/* background.js — 保存任务的调度中心（Service Worker）
 * 弹窗只负责发起任务和显示进度；真正的抓取在 offscreen 文档里跑，
 * 需要特权 API 的操作（标签页抓取 / Referer 规则 / 下载）由这里代办。
 * 因此关掉弹窗、切到别的标签页都不影响任务。 */

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
  const hit = tabs.find((t) => t.id != null && t.url && normalizeUrl(t.url) === want);
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

/* 这段在目标标签页里执行，必须自包含（executeScript 会把它序列化过去） */
async function captureRenderedDom(opts) {
  const cfg = Object.assign({ minWait: 3000, maxWait: 30000, stepDelay: 240, settleDelay: 600, settleRounds: 5, maxScrollMs: 120000 }, opts || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const textLen = () => (document.body && document.body.innerText ? document.body.innerText.trim().length : 0);
  const started = Date.now();
  while (textLen() < 200 && Date.now() - started < cfg.maxWait) await sleep(300);
  await sleep(cfg.minWait);

  // 正文出来之后，封面/头像这类资源还会晚一步才挂上来。等图片数量稳定再抓，否则会漏图。
  const countImgs = () => {
    let n = 0;
    const list = document.querySelectorAll('img');
    for (let i = 0; i < list.length; i++) if (list[i].currentSrc || list[i].getAttribute('src')) n++;
    return n;
  };
  for (let last = -1, stable = 0, i = 0; i < 40 && stable < 4; i++) {
    const n = countImgs();
    if (n === last) stable++; else stable = 0;
    last = n;
    await sleep(250);
  }

  const findScroller = () => {
    let best = document.scrollingElement || document.documentElement;
    let room = best ? best.scrollHeight - best.clientHeight : 0;
    const nodes = document.querySelectorAll('div,main,section,article');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      if (el.clientHeight < 100) continue;
      const r = el.scrollHeight - el.clientHeight;
      if (r > room) { room = r; best = el; }
    }
    return { el: best, room };
  };

  const nodesBefore = document.querySelectorAll('*').length;
  const scrollDeadline = Date.now() + cfg.maxScrollMs;
  let scroller = findScroller();
  let stable = 0, lastH = -1, lastTop = -1, round = 0;
  while (stable < cfg.settleRounds && round < 400 && Date.now() < scrollDeadline) {
    round++;
    if (!scroller.el || !scroller.el.isConnected || round % 20 === 1) scroller = findScroller();
    const el = scroller.el;
    if (!el) break;
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (maxTop <= 4) break;
    // 必须真的滚到底之后才允许判定"稳定"。只按高度不变就收手的话，
    // 因为步长是 0.8 屏，会在离底部还差一段的地方就退出，懒加载的内容全漏掉。
    const atBottom = el.scrollTop >= maxTop - 4;
    if (atBottom) {
      if (el.scrollHeight === lastH && el.scrollTop === lastTop) stable++; else stable = 0;
      lastH = el.scrollHeight;
      lastTop = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      await sleep(cfg.settleDelay);
    } else {
      stable = 0;
      el.scrollTop = Math.min(maxTop, el.scrollTop + Math.max(240, Math.floor(el.clientHeight * 0.8)));
      await sleep(cfg.stepDelay);
    }
  }
  if (scroller.el && scroller.el.isConnected) scroller.el.scrollTop = 0;
  await sleep(900);

  // 克隆 DOM 再处理，避免改动用户正在看的页面
  const originals = [...document.querySelectorAll('img')];
  const cloneRoot = document.documentElement.cloneNode(true);
  const cloned = [...cloneRoot.querySelectorAll('img')];
  const blobs = {};
  for (let i = 0; i < originals.length; i++) {
    const src = originals[i].currentSrc || originals[i].src || originals[i].getAttribute('src') || '';
    if (src && cloned[i]) cloned[i].setAttribute('src', src);
    if (src.startsWith('blob:')) {
      try {
        const b = await (await fetch(src)).blob();
        blobs[src] = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = rej;
          fr.readAsDataURL(b);
        });
      } catch (e) { /* 拿不到就算了 */ }
    }
  }
  const h1 = document.querySelector('h1.ts');
  return {
    html: '<!DOCTYPE html>\n' + cloneRoot.outerHTML,
    baseUrl: document.baseURI || location.href, // 尊重 <base href>，SPA 站点的相对路径靠它解析
    title: document.title || '',
    subject: h1 && h1.textContent ? h1.textContent.trim() : '',
    blobs,
    nodesBefore,
    nodesAfter: document.querySelectorAll('*').length,
  };
}

async function capture({ url }) {
  const { tabId, created } = await findOrOpenTab(url);
  try {
    addLog(created ? '没有匹配的标签页，已后台新开，等待渲染…' : '复用已打开的标签页，等待渲染…');
    await waitForTabReady(tabId);
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: captureRenderedDom,
      // 标签页在后台时定时器会被降频到约 1 秒一次，滚动上限放宽以免长文档被截断
      args: [{ minWait: 3000, stepDelay: 240, settleDelay: 600, settleRounds: 5, maxScrollMs: 240000 }],
    });
    return injected && injected[0] && injected[0].result;
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
