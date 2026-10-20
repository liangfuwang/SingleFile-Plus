/* background.js — 保存任务的调度中心（Service Worker）
 * 弹窗只负责发起任务和显示进度；真正的抓取在 offscreen 文档里跑，
 * 需要特权 API 的操作（标签页抓取 / Referer 规则 / 下载）由这里代办。
 * 因此关掉弹窗、切到别的标签页都不影响任务。 */

importScripts('rendered-capture.js');

const JOB_KEY = 'job';
const MAX_LOGS = 300;

let state = null;
const ready = (async () => {
  const o = await chrome.storage.session.get(JOB_KEY);
  state = o[JOB_KEY] || { status: 'idle', logs: [], progress: 0 };
  // Service Worker 被回收后重启，offscreen 也没了 —— 任务实际上已经断了
  if (state.status === 'running' && !(await hasOffscreen())) {
    state.status = 'error';
    state.logs.push({ msg: '✗ 失败: 后台任务被意外中断，请重试', cls: 'err' });
    persist();
    setBadge('✗', '#dc2626');
  }
})();

/* ---------- 状态 / 通知 ---------- */
function persist() {
  chrome.storage.session.set({ [JOB_KEY]: state }).catch(() => {});
}
function notifyPopup(msg) {
  chrome.runtime.sendMessage(Object.assign({ target: 'popup' }, msg)).catch(() => { /* 弹窗没开 */ });
}
function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}
function addLog(msg, cls = '') {
  state.logs.push({ msg, cls });
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
  persist();
  notifyPopup({ type: 'log', msg, cls });
}
function setProgress(p) {
  state.progress = p;
  persist();
  notifyPopup({ type: 'progress', p });
}

/* 任务期间保活：Service Worker 空闲 30 秒会被回收，定时调一次扩展 API 重置计时 */
let keepTimer = null;
function keepAlive(on) {
  if (on && !keepTimer) keepTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  else if (!on && keepTimer) { clearInterval(keepTimer); keepTimer = null; }
}

/* ---------- offscreen 文档 ---------- */
async function hasOffscreen() {
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctx.length > 0;
  } catch { return false; }
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS', 'DOM_PARSER'],
    justification: '在后台抓取网页、内嵌图片并生成单文件 HTML，不依赖弹窗保持打开',
  });
}
async function closeOffscreen() {
  try { await chrome.offscreen.closeDocument(); } catch { /* 本来就没有 */ }
}

/* ---------- 任务生命周期 ---------- */
async function startJob({ url, fname }) {
  await ready;
  if (state.status === 'running') return { error: '已有保存任务在后台进行，请等它完成' };
  state = { status: 'running', url, logs: [], progress: 0.01 };
  persist();
  notifyPopup({ type: 'status', status: 'running' });
  setBadge('…', '#2563eb');
  keepAlive(true);
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'run', job: { url, fname } });
  } catch (e) {
    await finishJob(false, e.message);
  }
  return { ok: true };
}

async function finishJob(ok, error) {
  await ready;
  if (state.status !== 'running') return;
  keepAlive(false);
  await clearReferer();
  if (ok) {
    state.status = 'done';
    state.progress = 1;
    setBadge('✓', '#16a34a');
  } else {
    state.status = 'error';
    addLog('✗ 失败: ' + error, 'err');
    setBadge('✗', '#dc2626');
  }
  persist();
  notifyPopup({ type: 'status', status: state.status });
  await closeOffscreen();
}

/* ---------- 代办：Referer 规则 ---------- */
async function clearReferer() {
  try {
    const old = await chrome.declarativeNetRequest.getSessionRules();
    if (old.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: old.map((r) => r.id) });
  } catch { /* ignore */ }
}
async function setReferer({ hosts, origin }) {
  await clearReferer();
  const rules = hosts.map((h, i) => ({
    id: i + 1,
    priority: 1,
    condition: {
      regexFilter: '^https?://' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(/.*)?$',
      resourceTypes: ['xmlhttprequest'],
    },
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Referer', operation: 'set', value: origin + '/' }],
    },
  }));
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
}

/* ---------- 代办：下载 ---------- */
/* 等下载落盘。注册监听器之后必须再补查一次当前状态：blob 下载非常快，
 * onChanged 有可能在监听器注册之前就发完了，只靠监听会永远等下去。 */
function waitDownload(id, timeout = 120000) {
  const settled = (it) => it && (it.state === 'complete' || it.state === 'interrupted');
  return new Promise((resolve, reject) => {
    let timer = null;
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        finish(resolve, delta.state.current);
      }
    };
    const finish = (fn, v) => {
      chrome.downloads.onChanged.removeListener(listener);
      if (timer) clearTimeout(timer);
      fn(v);
    };
    timer = setTimeout(() => finish(reject, Object.assign(new Error('等待下载完成超时'), { noRetry: true })), timeout);
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then((items) => {
      const it = items && items[0];
      if (settled(it)) finish(resolve, it.state);
    }).catch(() => { /* 查不到就继续等事件 */ });
  });
}

async function downloadBlob({ blobUrl, names }) {
  let lastErr = null;
  for (let i = 0; i < names.length; i++) {
    try {
      const id = await chrome.downloads.download({ url: blobUrl, filename: names[i] + '.html', saveAs: false });
      const st = await waitDownload(id);
      if (st === 'interrupted') throw new Error('下载被中断');
      addLog('✅ 已保存到下载文件夹: ' + names[i] + '.html', 'ok');
      return { name: names[i] };
    } catch (e) {
      lastErr = e;
      if (e.noRetry) break;
      if (i < names.length - 1) {
        addLog('⚠ 保存「' + names[i] + '.html」失败（' + e.message + '），改用兜底名重试…', 'err');
      }
    }
  }
  throw lastErr || new Error('下载失败');
}

/* ---------- 代办：渲染抓取 ----------
 * 飞书文档 / Notion 这类 SPA 的正文由 JS 渲染，直接请求只能拿到空壳。
 * 改为在真实标签页里执行脚本：等正文出现 → 滚动触发懒加载 → 序列化渲染后的 DOM。 */
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname.replace(/\/+$/, '');
  } catch { return u; }
}

async function findOrOpenTab(url) {
  const want = normalizeUrl(url);
  const tabs = await chrome.tabs.query({});
  const matches = tabs.filter((t) => t.id != null && t.url && normalizeUrl(t.url) === want);
  // 同一帖子开了多个标签页时，优先用户当前正在看的那个，避免采集旧副本。
  const hit = matches.find((t) => t.active) || matches.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  if (hit) return { tabId: hit.id, created: false };
  // 后台打开，不抢用户当前焦点
  const tab = await chrome.tabs.create({ url, active: false });
  return { tabId: tab.id, created: true };
}

async function waitForTabReady(tabId, timeout = 40000) {
  const cur = await chrome.tabs.get(tabId).catch(() => null);
  if (cur && cur.status === 'complete') return;
  await new Promise((resolve) => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const timer = setTimeout(done, timeout);
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function capture({ url }) {
  const { tabId, created } = await findOrOpenTab(url);
  try {
    addLog(created ? '没有匹配的标签页，已后台新开，等待渲染…' : '复用已打开的标签页，等待渲染…');
    await waitForTabReady(tabId);
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: captureRenderedDom,
      // 几百条评论的帖子要分几十页加载；标签页在后台时定时器还会被降频到约 1 秒一次，上限给足 10 分钟
      args: [{ maxScrollMs: 600000 }],
    });
    const result = injected && injected[0] && injected[0].result;
    if (result && result.scrollInfo) {
      const { stopReason, rounds, scrollMs, clicks, hidden, mainComments, bottomChecks } = result.scrollInfo;
      const sec = (scrollMs / 1000).toFixed(0);
      const expanded = clicks ? '，点开 ' + clicks + ' 处折叠' : '';
      const comments = mainComments ? '，已加载 ' + mainComments + ' 条主评论' : '';
      if (stopReason !== 'stable') {
        const reasons = {
          rounds: '已达滚动轮数上限（' + rounds + ' 轮）',
          timeout: '已达滚动时间上限（' + sec + ' 秒）',
          stalled: '后续内容长时间没有加载完成',
          blocked: '滚动位置无法继续推进',
        };
        addLog('⚠ ' + (reasons[stopReason] || '无法确认页面底部') + comments + expanded + '，可能没抓全；仅保存当前已渲染的部分', 'err');
      } else {
        addLog('滚动完成：' + rounds + ' 轮 / ' + sec + ' 秒' + comments + expanded + '，底部已连续检查 ' + bottomChecks + ' 次且无加载提示');
      }
      if (hidden) {
        addLog('⚠ 抓取时标签页在后台：不少网站在后台会暂停"滚到底加载"，内容不全的话请把该标签页留在前台重试', 'err');
      }
    }
    return result;
  } finally {
    if (created) { try { await chrome.tabs.remove(tabId); } catch { /* ignore */ } }
  }
}

/* 自动识别用：该 URL 已经在某个标签页里打开时，量一下真实渲染出来的文本量
 * （不新开标签页、不滚动，几乎零成本）。没有匹配的标签页或还在加载就返回 null。 */
async function probeTab({ url }) {
  const want = normalizeUrl(url);
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => t.id != null && t.status === 'complete' && t.url && normalizeUrl(t.url) === want);
  if (!hit) return null;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: hit.id },
      func: () => ({ textLen: ((document.body && document.body.innerText) || '').replace(/\s+/g, '').length }),
    });
    return (r && r.result) || null;
  } catch { return null; }
}

const RPC = {
  capture,
  probeTab,
  setReferer,
  clearReferer: async () => { await clearReferer(); },
  download: downloadBlob,
};

/* ---------- 消息入口 ---------- */
chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (!m || m.target !== 'bg') return;
  switch (m.type) {
    case 'start':
      startJob(m).then(sendResponse);
      return true;
    case 'getState':
      ready.then(() => sendResponse(state));
      return true;
    case 'ack':
      // 弹窗已看过结果，清掉角标；任务进行中的 … 保留
      ready.then(() => { if (state.status !== 'running') setBadge(''); });
      return;
    case 'log':
      ready.then(() => addLog(m.msg, m.cls));
      return;
    case 'progress':
      ready.then(() => setProgress(m.p));
      return;
    case 'done':
      finishJob(true);
      return;
    case 'fail':
      finishJob(false, m.error);
      return;
    case 'rpc': {
      const fn = RPC[m.op];
      if (!fn) { sendResponse({ error: '未知操作: ' + m.op }); return; }
      ready.then(() => fn(m.args || {}))
        .then((result) => sendResponse({ result: result === undefined ? null : result }))
        .catch((e) => sendResponse({ error: (e && e.message) || String(e), noRetry: !!(e && e.noRetry) }));
      return true;
    }
  }
});
