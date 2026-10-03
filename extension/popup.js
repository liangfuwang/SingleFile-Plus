/* popup.js — 插件弹窗逻辑 */
const $url = document.getElementById('url');
const $fname = document.getElementById('fname');
const $go = document.getElementById('go');
const $log = document.getElementById('log');
const $bar = document.querySelector('.bar');
const $barFill = document.getElementById('barFill');
const $modes = [...document.querySelectorAll('input[name=mode]')];

function log(msg, cls = '') {
  $log.style.display = 'block';
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = msg;
  $log.appendChild(div);
  $log.scrollTop = $log.scrollHeight;
}
function progress(p) {
  $bar.style.display = 'block';
  $barFill.style.width = `${Math.round(p * 100)}%`;
}

/* 自定义头像经常 403（无论带不带 Referer/Cookie），回退到站内默认头像；
 * 实在拿不到就内联占位图，保证离线无外部请求。 */
const AVATAR_FALLBACKS = [
  [/_avatar_small\./i, 'https://forum.example.com/uc_server/images/noavatar_small.gif'],
  [/_avatar_middle\./i, 'https://forum.example.com/uc_server/images/noavatar_middle.gif'],
  [/_avatar_big\./i, 'https://forum.example.com/uc_server/images/noavatar_big.gif'],
];
const PLACEHOLDER_IMG = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">' +
  '<rect width="160" height="120" fill="#eceff3"/>' +
  '<circle cx="52" cy="42" r="14" fill="#c3ccd6"/>' +
  '<path d="M18 108c4-22 16-32 34-32s30 10 34 32z" fill="#c3ccd6"/>' +
  '<path d="M104 40h40v10h-40z" fill="#c3ccd6"/>' +
  '<path d="M104 58h40v10h-40z" fill="#d5dbe2"/>' +
  '</svg>');

/* 打开时填入当前标签页 URL，并尝试从页面标题预生成文件名 */
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && /^https?:/.test(tab.url)) {
    $url.value = tab.url;
    if (tab.title) $fname.value = safeName(sanitize(tab.title));
  }
  selectMode(isSpaUrl($url.value) ? 'rendered' : 'static');
})();

/* SPA / 需登录后才由 JS 渲染正文的站点，静态抓取只能拿到空壳，默认走渲染模式 */
const SPA_HOSTS = [
  /(^|\.)feishu\.cn$/i, /(^|\.)larksuite\.com$/i, /(^|\.)larkoffice\.com$/i,
  /(^|\.)notion\.so$/i, /(^|\.)notion\.site$/i,
  /(^|\.)yuque\.com$/i,
];
function isSpaUrl(url) {
  try { return SPA_HOSTS.some((re) => re.test(new URL(url).hostname)); } catch { return false; }
}
function selectMode(mode) {
  for (const el of $modes) el.checked = el.value === mode;
}
function currentMode() {
  return ($modes.find((el) => el.checked) || {}).value || 'static';
}
$url.addEventListener('input', () => {
  if (!isSpaUrl($url.value)) return;
  if (currentMode() !== 'rendered') { selectMode('rendered'); log('识别到 SPA 站点，已切换为「渲染抓取」'); }
});

function sanitize(name) {
  return (name || '')
    .replace(/\s*-\s*[^-]*Powered by Discuz!.*$/i, '')
    .replace(/\s*-\s*稀缺资源专区.*$/i, '')
    .replace(/\s*[-–—|]\s*(飞书云文档|飞书|Notion|语雀)\s*$/i, '')
    .replace(/[♈♉♊♋♌♍♎♏♐♑♒♓⛎]/g, '')
    .replace(/[【】「」『』\[\]]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
        .slice(0, 80);
}

/* ---------- 文件名兜底清洗 ----------
 * Chrome 的 downloads API 会先做 net::IsSafePortableRelativePath() 校验：
 * 首尾不能是空白 / . / ~，不能含 ".."，不能是 Windows 保留名，不能含非字符，
 * 且经内部清洗后必须与原串完全一致 —— 否则整条下载直接抛 "Invalid filename"。
 * 飞书这类站点的标题常夹带零宽字符，JS 的 \s 不覆盖它们，必须单独清掉。 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
function safeName(name) {
  let n = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[\ufdd0-\ufdef\ufff0-\uffff]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s~]+/, '')
    .replace(/[.\s~]+$/, '');
  if (RESERVED_NAME.test(n)) n = '_' + n;
  return [...n].slice(0, 80).join('').replace(/[.\s~]+$/, '');
}

/* 文件名仍被浏览器拒绝时换纯 ASCII 名重试，保证一定存得下来 */
function fallbackName() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return 'web-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/* 属性值里的 & 会写成 &amp;（极端情况还有 &amp;#38; 这种双重转义），
 * 不还原的话 ?a=1&amp;b=2 会带着 "amp;" 去请求，URL 直接废掉。 */
function decodeEntities(u) {
  let s = String(u);
  for (let i = 0; i < 2; i++) {
    s = s.replace(/&#x26;|&#38;/gi, '&')
      .replace(/&#x22;|&#34;/gi, '"')
      .replace(/&#x27;|&#39;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&amp;/gi, '&');
  }
  return s;
}

function hostOf(u) {
  try { return new URL(u).hostname; } catch { return 'unknown'; }
}

/* 等下载落盘。注册监听器之后必须再补查一次当前状态：blob 下载非常快，
 * onChanged 有可能在监听器注册之前就发完了，只靠监听会永远等下去（弹窗卡在 95% 不动，
 * finally 不执行，临时 Referer 规则也清理不掉）。 */
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

async function downloadHtml(html, fname) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const names = [...new Set([safeName(fname), fallbackName()].filter(Boolean))];
  let lastErr = null;
  try {
    for (let i = 0; i < names.length; i++) {
      try {
        const id = await chrome.downloads.download({ url: blobUrl, filename: names[i] + '.html', saveAs: false });
        const state = await waitDownload(id);
        if (state === 'interrupted') throw new Error('下载被中断');
        log('✅ 已保存到下载文件夹: ' + names[i] + '.html', 'ok');
        return names[i];
      } catch (e) {
        lastErr = e;
        if (e.noRetry) break;
        if (i < names.length - 1) {
          log('⚠ 保存「' + names[i] + '.html」失败（' + e.message + '），改用兜底名重试…', 'err');
        }
      }
    }
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  throw lastErr || new Error('下载失败');
}

/* ============================================================
 * 渲染抓取：飞书文档 / Notion 这类 SPA 的正文由 JS 渲染，直接请求只能
 * 拿到空壳。改为在真实标签页里执行脚本：等正文出现 → 滚动触发懒加载
 * → 序列化渲染后的 DOM，再交给外层内嵌图片。
 * ============================================================ */
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
  // 必须后台打开：激活别的标签页会把弹窗关掉，抓取任务就断了
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
  return {
    html: '<!DOCTYPE html>\n' + cloneRoot.outerHTML,
    baseUrl: location.href,
    title: document.title || '',
    blobs,
    nodesBefore,
    nodesAfter: document.querySelectorAll('*').length,
  };
}

/* 渲染模式下的图片多是带签名的 URL（没有扩展名），不能按后缀筛，
 * 也不能因为发生重定向就判失败，只排除明显不是图片的响应 */
async function fetchImageLoose(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const blob = await resp.blob();
  if (!blob.size) throw new Error('空响应');
  const type = (blob.type || '').toLowerCase();
  if (/^text\//.test(type) || /^application\/(json|xml|javascript)/.test(type)) throw new Error('非图片: ' + type);
  return await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

function collectRenderedImageUrls(html, baseUrl) {
  const urls = new Set();
  const add = (u) => {
    if (!u) return;
    u = decodeEntities(u).trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
    if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#')) return;
    try {
      const abs = new URL(u, baseUrl).href;
      if (/^https?:/.test(abs)) urls.add(abs);
    } catch { /* ignore */ }
  };
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    for (const attr of ['src', 'data-src', 'data-original']) {
      const a = tag.match(new RegExp(attr + '\\s*=\\s*"([^"]+)"', 'i'));
      if (a) add(a[1]);
    }
    const ss = tag.match(/\bsrcset\s*=\s*"([^"]+)"/i);
    if (ss) ss[1].split(',').forEach((p) => add(p.trim().split(/\s+/)[0]));
  }
  // 只取行内 style 的背景图；<style> 里的 url() 属于 CSS，交给样式表处理，别当图片下载
  for (const m of html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)) {
    const css = decodeEntities(m[1]);
    for (const u of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) add(u[2]);
  }
  return urls;
}

/* 内嵌之后懒加载属性已无意义；srcset 的多个候选会让浏览器选错图 */
function stripLazyAttrs(html) {
  return html.replace(/<img\b[^>]*>/gi, (tag) =>
    tag.replace(/\s(?:srcset|data-srcset|data-src|data-original|data-echo|loading)\s*=\s*"[^"]*"/gi, ''));
}

async function saveRendered(pageUrl, fname) {
  log('渲染模式：定位标签页…', 'hl');
  progress(0.05);

  const { tabId, created } = await findOrOpenTab(pageUrl);
  let ruleIds = [];
  try {
    log(created ? '没有匹配的标签页，已后台新开，等待渲染…' : '复用已打开的标签页，等待渲染…');
    await waitForTabReady(tabId);

    log('注入脚本：滚动触发懒加载 → 抓取渲染后的 DOM…');
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: captureRenderedDom,
      args: [{ minWait: 3000, stepDelay: 240, settleDelay: 600, settleRounds: 5 }],
    });
    const result = injected && injected[0] && injected[0].result;
    if (!result || !result.html) throw new Error('没取到渲染后的 DOM（页面可能还在加载，或被登录页拦截）');
    log('DOM 抓取完成: ' + (result.html.length / 1048576).toFixed(1) + ' MB', 'ok');
    progress(0.45);

    const title = (result.title || '').trim();
    if (title) log('页面: ' + title.slice(0, 50), 'hl');
    if (!fname) fname = safeName(sanitize(title)) || 'page';
    if (result.nodesAfter < result.nodesBefore * 0.7) {
      log('⚠ 疑似虚拟滚动（节点 ' + result.nodesBefore + ' → ' + result.nodesAfter + '），长文档可能有内容缺失', 'err');
    }

    // blob: 图片已经在页面内转成 data URI，这里直接拿来用
    const dataUris = new Map(Object.entries(result.blobs || {}));
    const urls = collectRenderedImageUrls(result.html, result.baseUrl);
    for (const b of dataUris.keys()) urls.delete(b);
    const list = [...urls];
    log('发现 ' + list.length + ' 个图片，开始下载…');

    // 和静态模式一样，给图片域名临时注入 Referer，下载完自动删规则
    const siteOrigin = new URL(result.baseUrl).origin;
    const hosts = new Set([new URL(result.baseUrl).hostname]);
    for (const u of list) { try { hosts.add(new URL(u).hostname); } catch { /* ignore */ } }
    try {
      const rules = [...hosts].map((h, i) => ({
        id: i + 1,
        priority: 1,
        condition: {
          regexFilter: '^https?://' + h.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&') + '(/.*)?$',
          resourceTypes: ['xmlhttprequest'],
        },
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'Referer', operation: 'set', value: siteOrigin + '/' }],
        },
      }));
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
      ruleIds = rules.map((r) => r.id);
    } catch (e) {
      log('⚠ 无法设置 Referer 规则，部分图片可能下载失败', 'err');
    }

    const failReasons = new Map();
    const queue = [...list];
    let done = 0, ok = 0;
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (queue.length) {
        const u = queue.shift();
        try {
          dataUris.set(u, await fetchImageLoose(u));
          ok++;
        } catch (e) {
          dataUris.set(u, PLACEHOLDER_IMG);
          const key = hostOf(u) + ': ' + e.message;
          failReasons.set(key, (failReasons.get(key) || 0) + 1);
        }
        done++;
        if (done % 10 === 0 || done === list.length) {
          progress(0.45 + 0.4 * done / Math.max(1, list.length));
          log('下载进度: ' + done + '/' + list.length);
        }
      }
    }));
    log('图片下载完成: 成功 ' + ok + ', 占位替代 ' + (list.length - ok), ok ? 'ok' : 'err');
    for (const [reason, n] of [...failReasons].slice(0, 5)) log('  失败原因 [x' + n + ']: ' + reason, 'err');

    let out = replaceUrls(result.html, dataUris, result.baseUrl);
    out = stripLazyAttrs(out);
    out = await inlineStylesheets(out, result.baseUrl);
    out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<script\b[^>]*\/>/gi, '')
      .replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
    out = injectLightbox(out);

    progress(0.95);
    await downloadHtml(out, fname);
    progress(1);
  } finally {
    if (ruleIds.length) {
      try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds }); } catch { /* ignore */ }
    }
    if (created) { try { await chrome.tabs.remove(tabId); } catch { /* ignore */ } }
  }
}

$go.addEventListener('click', async () => {
  const url = $url.value.trim();
  if (!/^https?:\/\//.test(url)) { log('✗ 请输入有效的 http(s) URL', 'err'); return; }
  $go.disabled = true;
  $log.innerHTML = '';
  try {
    await saveAsSingleFile(url, $fname.value.trim() || undefined, currentMode());
  } catch (e) {
    log(`✗ 失败: ${e.message}`, 'err');
  } finally {
    $go.disabled = false;
  }
});

/* ============================================================
 * 核心：抓取页面 → 下载全部图片（扩展有 host_permissions，
 *       请求会自动带站点 Cookie，跨域 fetch 无阻拦）
 * ============================================================ */
async function saveAsSingleFile(pageUrl, fname, mode) {
  return mode === 'rendered' ? saveRendered(pageUrl, fname) : saveStatic(pageUrl, fname);
}

/* ---------- 静态抓取：直接请求服务端返回的 HTML（Discuz 论坛等） ---------- */
async function saveStatic(threadUrl, fname) {
  log('开始抓取页面…', 'hl');
  progress(0.02);

  // 1. 抓主页面（扩展的 fetch 不受 CORS 限制，Cookie 自动携带）
  let html = await fetchText(threadUrl);
  // 年龄门检测（Discuz 18+ gate）
  if (/agree_submit/.test(html)) {
    log('检测到年龄确认门，自动通过…');
    const fh = (html.match(/name="formhash" value="([^"]+)"/) || [])[1];
    const body = new URLSearchParams({ formhash: fh, agree_submit: '是' });
    await fetch(threadUrl, { method: 'POST', body, redirect: 'follow' });
    html = await fetchText(threadUrl);
  }
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  if (!fname) fname = safeName(sanitize(title)) || 'page';
  log(`页面: ${title.trim().slice(0, 50)}`, 'hl');
  progress(0.08);

  // 2. 抓取所有分页
  const pages = [...new Set([...html.matchAll(/[?&]page=(\d+)/g)].map((m) => +m[1]))];
  const maxPage = pages.length ? Math.max(...pages) : 1;
  const pageHtmls = [html];
  for (let p = 2; p <= maxPage; p++) {
    const sep = threadUrl.includes('?') ? '&' : '?';
    pageHtmls.push(await fetchText(`${threadUrl}${sep}page=${p}`));
    log(`第 ${p}/${maxPage} 页抓取完成`);
    progress(0.08 + 0.04 * p / maxPage);
  }
  html = pageHtmls.join('\n<!-- PAGE BREAK -->\n');

  // 3. 收集图片 URL
  const urls = collectImageUrls(html, threadUrl);
  log(`发现 ${urls.size} 个图片，开始下载…`);
  const list = [...urls];
  const dataUris = new Map();
  const fallbackCache = new Map();
  let done = 0, ok = 0;

  // 4. 给图片域名临时注入 Referer（防盗链服务器要求请求必须带 Referer，
  //    扩展页面的 fetch 默认不带，所以用 DNR 会话规则补上，下载完自动删）
  const siteOrigin = new URL(threadUrl).origin;
  const hosts = new Set([new URL(threadUrl).hostname, ...list.map((u) => new URL(u).hostname)]);
  let ruleIds = [];
  try {
    const rules = [...hosts].map((h, i) => ({
      id: i + 1,
      priority: 1,
      condition: {
        regexFilter: `^https?://${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/.*)?$`,
        resourceTypes: ['xmlhttprequest'],
      },
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Referer', operation: 'set', value: siteOrigin + '/' }],
      },
    }));
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
    ruleIds = rules.map((r) => r.id);
  } catch (e) {
    log('⚠ 无法设置 Referer 规则，部分图片可能下载失败', 'err');
  }

  // 5. 并发下载（5 路），记录失败原因
  const queue = [...list];
  const failReasons = new Map();
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const u = queue.shift();
      try {
        const d = await fetchImageWithFallback(u, fallbackCache);
        dataUris.set(u, d);
        ok++;
      } catch (e) {
        // 单张图失败不阻塞整篇，用内联占位图替换
        dataUris.set(u, PLACEHOLDER_IMG);
        const host = new URL(u).hostname;
        const key = `${host}: ${e.message}`;
        failReasons.set(key, (failReasons.get(key) || 0) + 1);
      }
      done++;
      if (done % 10 === 0 || done === list.length) {
        progress(0.15 + 0.7 * done / list.length);
        log(`下载进度: ${done}/${list.length}`);
      }
    }
  });
  await Promise.all(workers);

  // 删除临时 Referer 规则
  if (ruleIds.length) {
    try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds }); } catch {}
  }
  log(`图片下载完成: 成功 ${ok}, 占位替代 ${list.length - ok}`, ok ? 'ok' : 'err');
  for (const [reason, n] of [...failReasons].slice(0, 5)) {
    log(`  失败原因 [x${n}]: ${reason}`, 'err');
  }
  progress(0.9);

  // 5. 替换引用 → 修懒加载 → 内联CSS → 清脚本 → 注入灯箱
  let out = replaceUrls(html, dataUris, threadUrl);
  out = fixLazyLoad(out);
  out = await inlineStylesheets(out, threadUrl);
  // 移除页面全部脚本（含内联）。Discuz 内联脚本依赖已删掉的外部脚本，
  // 保留会在本地打开时抛 ReferenceError（HTMLNODE / initSearchmenu 等）
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
  out = injectLightbox(out);

  // 6. 下载为文件
  await downloadHtml(out, fname);
  progress(1);
}

/* ---------- 工具函数 ---------- */
async function fetchText(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`页面请求失败 HTTP ${resp.status}`);
  return resp.text();
}

function collectImageUrls(html, baseUrl) {
  const urls = new Set();
  const add = (u) => {
    if (!u) return;
    u = decodeEntities(u).trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
    if (!u || u.startsWith('data:') || u.startsWith('#')) return;
    try {
      const abs = new URL(u, baseUrl).href;
      if (!/^https?:/.test(abs)) return;
      if (/\.(js|css)(\?|$)/i.test(abs)) return;
      const looksImg = /\.(jpe?g|png|gif|webp|bmp|avif)(\?|$)/i.test(abs)
        || /\/data\/attachment\//i.test(abs) || /uc_server\/data/i.test(abs);
      if (looksImg) urls.add(abs);
    } catch { /* ignore */ }
  };
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    for (const attr of ['zoomfile', 'file', 'data-original', 'data-src', 'src', 'data-echo']) {
      const a = m[0].match(new RegExp(`${attr}="([^"]+)"`));
      if (a) add(a[1]);
    }
  }
  for (const m of html.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) add(m[2]);
  return urls;
}

async function fetchImage(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  // 正常图片不会重定向；被 302 到占位图说明 Referer 注入未生效
  if (resp.redirected) throw new Error('被重定向到防盗链占位图');
  const blob = await resp.blob();
  if (!blob.type.startsWith('image/')) throw new Error('非图片: ' + blob.type);
  return await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

// 头像类图片失败时自动回退到站内默认头像
async function fetchImageWithFallback(url, cache) {
  try {
    return await fetchImage(url);
  } catch (e) {
    const rule = AVATAR_FALLBACKS.find(([re]) => re.test(url));
    if (!rule) throw e;
    if (cache.has(rule[1])) return cache.get(rule[1]);
    const d = await fetchImage(rule[1]);
    cache.set(rule[1], d);
    return d;
  }
}

/* ---------- 内联样式表 ---------- */
function collectStyleLinks(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href || /^data:/i.test(href)) continue;
    out.push({ tag, url: new URL(href, baseUrl).href });
  }
  return out;
}
function absolutizeCssUrls(css, cssUrl) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (all, q, u) => {
    if (/^(data:|https?:|\/\/|#)/i.test(u)) return all;
    try { return `url(${q}${new URL(u, cssUrl).href}${q})`; } catch { return all; }
  });
}
async function inlineStylesheets(html, pageUrl) {
  let out = html;
  for (const { tag, url } of collectStyleLinks(html, pageUrl)) {
    try {
      const css = absolutizeCssUrls(await fetchText(url), url);
      out = out.split(tag).join(`<style data-src="${url}">\n${css}\n</style>`);
    } catch {
      // 拉不到的样式表（如站点本身 403 的 t5/style.css）直接移除，避免打开时报错
      out = out.split(tag).join('');
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');

/* 同一个资源在页面里可能是绝对地址、协议相对地址（//cdn/x.png）、或者把 & 转义成
 * &amp; 的形态。收集时已经还原成绝对地址，替换时每种形态都得试，否则整张图会漏掉。 */
function urlVariants(u) {
  const set = new Set([u]);
  if (/^https?:/.test(u)) set.add(u.replace(/^https?:/, ''));
  if (u.indexOf('&') >= 0) for (const s of [...set]) set.add(s.replace(/&/g, '&amp;'));
  return [...set];
}

function replaceUrls(html, dataUris, baseUrl) {
  let out = html;
  for (const [u, d] of dataUris) {
    for (const v of urlVariants(u)) {
      if (v) out = out.replace(new RegExp(escapeRe(v), 'g'), d);
    }
    try {
      const rel = new URL(u).pathname.replace(/^\//, '');
      if (rel) out = out.replace(new RegExp(escapeRe(rel), 'g'), d);
    } catch { /* ignore */ }
  }
  return out;
}

function fixLazyLoad(html) {
  return html.replace(/<img\b[^>]*>/g, (tag) => {
    if (!/\b(zoomfile|file)="data:image/.test(tag)) return tag;
    const real = tag.match(/\b(?:zoomfile|file)="(data:image[^"]+)"/);
    if (!real) return tag;
    let nt = /\bsrc="[^"]*"/.test(tag)
      ? tag.replace(/\bsrc="[^"]*"/, `src="${real[1]}"`)
      : tag.replace(/^<img\b/, `<img src="${real[1]}"`);
    nt = nt.replace(/\s*(zoomfile|file)="data:image[^"]*"/g, '');
    return nt;
  });
}

function injectLightbox(html) {
  const lb = `<style id="sf-lightbox-style">
#sf-lightbox{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.92);display:none;align-items:center;justify-content:center;overflow:hidden;}
#sf-lightbox img{max-width:none;max-height:none;transform-origin:50% 50%;user-select:none;-webkit-user-drag:none;touch-action:none;cursor:grab;}
#sf-lightbox img.sf-anim{transition:transform .18s ease-out;}
#sf-lightbox img.sf-grab{cursor:grabbing;}
#sf-lightbox .sf-tip{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);color:#fff;font:13px/1.5 monospace;opacity:.65;user-select:none;white-space:nowrap;}
.sf-btn{position:fixed;top:50%;transform:translateY(-50%);width:52px;height:80px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:34px;cursor:pointer;opacity:.55;background:rgba(0,0,0,.3);border-radius:8px;}
.sf-btn:hover{opacity:1;}
.sf-prev{left:14px;}.sf-next{right:14px;}
.sf-toolbar{position:fixed;top:16px;right:20px;display:flex;gap:6px;align-items:center;}
.sf-toolbar span{color:#fff;background:rgba(0,0,0,.45);border-radius:8px;min-width:38px;height:38px;display:flex;align-items:center;justify-content:center;font:16px/1 monospace;cursor:pointer;opacity:.8;user-select:none;padding:0 8px;}
.sf-toolbar span:hover{opacity:1;}
.sf-toolbar .sf-pct{cursor:default;font-size:13px;}
.sf-toolbar .sf-close{font-size:26px;}
td.t_f img{cursor:zoom-in;}
</style>
<script>
(function(){
  var lb=document.createElement('div');lb.id='sf-lightbox';
  lb.innerHTML='<div class="sf-btn sf-prev">&#10094;</div><div class="sf-btn sf-next">&#10095;</div>'+
    '<div class="sf-toolbar"><span class="sf-zoom-out">&minus;</span><span class="sf-pct">100%</span><span class="sf-zoom-in">+</span><span class="sf-reset">&#8634;</span><span class="sf-close">&times;</span></div>'+
    '<img><div class="sf-tip">滚轮缩放 · 拖动平移 · 双击 100%/适应 · &larr;/&rarr; 切换图片 · Esc 关闭</div>';
  document.documentElement.appendChild(lb);
  var im=lb.querySelector('img'),pct=lb.querySelector('.sf-pct');
  var prevBtn=lb.querySelector('.sf-prev'),nextBtn=lb.querySelector('.sf-next');
  var s=1,s0=1,tx=0,ty=0,items=[],idx=-1,drag=null;

  function eligible(t){
    return t.tagName==='IMG'&&t.closest&&
      (t.closest('.t_f')||(t.id&&t.id.indexOf('aimg_')===0)||
       (t.src&&t.src.indexOf('data:image')===0&&t.naturalWidth>400));
  }
  function collect(){
    var list=[];
    document.querySelectorAll('img').forEach(function(t){if(eligible(t))list.push(t);});
    return list;
  }
  function apply(anim){
    im.classList.toggle('sf-anim',!!anim);
    im.style.transform='translate('+tx+'px,'+ty+'px) scale('+s+')';
    pct.textContent=Math.round(s*100)+'%';
  }
  function reset(){
    var nw=im.naturalWidth||1,nh=im.naturalHeight||1;
    s0=Math.min((innerWidth*0.96)/nw,(innerHeight*0.96)/nh,1);
    s=s0;tx=0;ty=0;apply(true);
  }
  function show(){
    var multi=items.length>1;
    prevBtn.style.display=multi?'flex':'none';
    nextBtn.style.display=multi?'flex':'none';
    im.onload=function(){reset();};
    im.src=items[idx].src;
    lb.style.display='flex';
    document.body.style.overflow='hidden';
  }
  function open(src){
    items=collect();idx=-1;
    for(var k=0;k<items.length;k++){if(items[k].src===src){idx=k;break;}}
    if(idx<0){items=[{src:src}];idx=0;}
    show();
  }
  function close(){lb.style.display='none';im.src='';items=[];document.body.style.overflow='';}
  function nav(d){
    if(items.length<2)return;
    idx=(idx+d+items.length)%items.length;show();
  }
  function zoomAt(cx,cy,f,anim){
    var ns=Math.min(12,Math.max(s0*0.2,s*f));
    if(ns===s)return;
    var px=cx-innerWidth/2,py=cy-innerHeight/2;
    tx=px-(px-tx)*(ns/s);ty=py-(py-ty)*(ns/s);
    s=ns;apply(anim);
  }
  lb.addEventListener('click',function(e){if(e.target===lb)close();});
  lb.querySelector('.sf-close').addEventListener('click',close);
  prevBtn.addEventListener('click',function(e){e.stopPropagation();nav(-1);});
  nextBtn.addEventListener('click',function(e){e.stopPropagation();nav(1);});
  lb.querySelector('.sf-zoom-in').addEventListener('click',function(e){e.stopPropagation();zoomAt(innerWidth/2,innerHeight/2,1.25,true);});
  lb.querySelector('.sf-zoom-out').addEventListener('click',function(e){e.stopPropagation();zoomAt(innerWidth/2,innerHeight/2,0.8,true);});
  lb.querySelector('.sf-reset').addEventListener('click',function(e){e.stopPropagation();reset();});
  lb.addEventListener('wheel',function(e){e.preventDefault();zoomAt(e.clientX,e.clientY,e.deltaY<0?1.15:1/1.15,false);},{passive:false});
  im.addEventListener('dblclick',function(e){
    e.stopPropagation();
    if(s>1.001){reset();}else{tx=0;ty=0;s=Math.max(1,s0);apply(true);}
  });
  im.addEventListener('pointerdown',function(e){
    e.preventDefault();im.setPointerCapture(e.pointerId);
    drag={x:e.clientX,y:e.clientY,tx:tx,ty:ty};im.classList.add('sf-grab');
  });
  im.addEventListener('pointermove',function(e){
    if(!drag)return;tx=drag.tx+e.clientX-drag.x;ty=drag.ty+e.clientY-drag.y;apply(false);
  });
  im.addEventListener('pointerup',function(){drag=null;im.classList.remove('sf-grab');});
  im.addEventListener('pointercancel',function(){drag=null;im.classList.remove('sf-grab');});
  document.addEventListener('keydown',function(e){
    if(lb.style.display==='none')return;
    if(e.key==='Escape')close();
    else if(e.key==='ArrowLeft')nav(-1);
    else if(e.key==='ArrowRight')nav(1);
    else if(e.key==='+'||e.key==='=')zoomAt(innerWidth/2,innerHeight/2,1.25,true);
    else if(e.key==='-')zoomAt(innerWidth/2,innerHeight/2,0.8,true);
    else if(e.key==='0')reset();
  });
  document.addEventListener('click',function(e){
    var t=e.target;
    if(eligible(t)){e.preventDefault();e.stopPropagation();open(t.src);}
  },true);
})();
</script>`;
  return html.replace(/<\/body>/i, lb + '\n</body>');
}
