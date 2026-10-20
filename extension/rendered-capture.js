/* 这段在目标标签页里执行，必须自包含（executeScript 会把它序列化过去） */
async function captureRenderedDom(opts) {
  const cfg = Object.assign({
    minWait: 1000, maxWait: 30000, stepDelay: 150, settleDelay: 400,
    quietMs: 3000, loadingMaxMs: 60000, maxScrollMs: 120000, maxRounds: 6000,
    bottomChecks: 3,
    expand: true, clicksPerScan: 30, reportEvery: 10000,
  }, opts || {});
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
      const rect = el.getBoundingClientRect();
      // 不让隐藏面板、屏外侧栏的长列表抢走正文滚动。
      if (!el.getClientRects().length || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      if (el.clientHeight < 100) continue;
      const r = el.scrollHeight - el.clientHeight;
      if (r > room) { room = r; best = el; }
    }
    return { el: best, room };
  };

  // 评论区里的折叠入口：楼中楼"展开剩余 N 条回复"、被截断的长评论"展开全文"、"加载更多"按钮。
  // 只点文字完全匹配的元素；不点会跳走的链接，也不点"收起"。
  const EXPAND_RE = /^(?:展开(?:剩余|全部|更多)?\d*条(?:回复|评论)|查看(?:全部|剩余|更多)?\d*条(?:回复|评论)|共\d+条回复|展开全文|查看全文|阅读全文|(?:点击)?(?:加载|查看|展开|显示)更多(?:评论|回复)?|更多(?:评论|回复)|(?:load|show|view|see)more(?:comments|replies)?|(?:show|view)\d*(?:more)?repl(?:y|ies))$/i;
  const HINT_RE = /展开|查看|加载|更多|全文|回复|more|repl/i;
  const LOADING_RE = /^(?:(?:评论|回复|内容|数据|页面)?(?:正在)?加载中|正在加载(?:评论|回复|内容|数据|页面)?|loading(?:comments|replies)?)[.。…!！]*$/i;
  const norm = (s) => s.replace(/[\s>›»▸▾▼↓∨]+/g, '');
  const rendered = (el) => el.getClientRects().length > 0;
  const clickedState = new WeakMap(); // 元素 → 上次点击时的文字和页面高度，防止对同一个按钮反复点
  // 扫一遍文本节点：点开折叠入口，顺便看页面上有没有"加载中"
  const scan = (docH) => {
    let clicked = 0, loading = false;
    if (!document.body) return { clicked, loading };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const raw = node.nodeValue;
      if (!raw || raw.length > 40) continue;
      const p = node.parentElement;
      if (!p) continue;
      const t = norm(raw);
      if (LOADING_RE.test(t)) { if (!loading && rendered(p)) loading = true; continue; }
      if (!cfg.expand || clicked >= cfg.clicksPerScan || !HINT_RE.test(t)) continue;
      const target = p.closest('button,[role="button"],a') || p;
      if (!EXPAND_RE.test(norm(target.textContent || ''))) continue;
      if (target.disabled || target.getAttribute('aria-disabled') === 'true' || !rendered(target)) continue;
      const link = target.closest('a[href]');
      if (link && !/^(?:#|javascript:)/i.test(link.getAttribute('href') || '')) continue;
      const prev = clickedState.get(target);
      // 同一个按钮：文字变了（剩余条数减少）或页面长高了（"加载更多"生效后按钮还在）才再点
      if (prev && (prev.n >= 50 || (prev.text === t && prev.h === docH))) continue;
      clickedState.set(target, { text: t, h: docH, n: prev ? prev.n + 1 : 1 });
      try { target.click(); clicked++; } catch { /* ignore */ }
    }
    // 部分站点只显示动画，不含「加载中」文本。只采用明确的加载状态，
    // 不把任意带 loading 字样的样式类（可能只是永久哨兵）都当成请求。
    if (!loading) loading = [...document.querySelectorAll('[aria-busy="true"],.flow-loading')].some(rendered);
    return { clicked, loading };
  };
  const report = (msg) => {
    try { if (typeof chrome !== 'undefined' && chrome.runtime) chrome.runtime.sendMessage({ target: 'bg', type: 'log', msg }).catch(() => {}); } catch { /* ignore */ }
  };

  const nodesBefore = document.querySelectorAll('*').length;
  const commentCount = () => document.querySelectorAll('app-comment-item.main-comment-item').length;
  const scrollStart = Date.now();
  const scrollDeadline = scrollStart + cfg.maxScrollMs;
  let lastMutation = scrollStart;
  const mo = new MutationObserver((records) => {
    // 加载动画的 SVG/Lottie 不代表正文增长；正文文字更新则必须重新等待。
    if (records.some((r) => !(r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest('svg,canvas,app-lottie,.flow-loading,[aria-busy="true"]'))) lastMutation = Date.now();
  });
  if (document.body) mo.observe(document.body, { childList: true, characterData: true, subtree: true });
  let scroller = findScroller();
  let round = 0, clicks = 0, lastH = -1, lastGrow = scrollStart, lastClick = 0, arrivedAt = scrollStart;
  let wasAtBottom = false, wasHidden = false, lastReport = scrollStart;
  let checks = 0, lastProbe = scrollStart, lastCount = commentCount(), loading = false;
  let stuckMoves = 0;
  let stopReason = ''; // stable 多轮底部检查稳定 / stalled 加载卡住 / blocked 无法继续滚动 / rounds / timeout
  const moveTo = (el, top) => {
    if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'instant' });
    else el.scrollTop = top;
    if (el === document.scrollingElement) window.scrollTo({ top, behavior: 'instant' });
  };
  while (true) {
    if (round >= cfg.maxRounds) { stopReason = 'rounds'; break; }
    if (Date.now() >= scrollDeadline) { stopReason = 'timeout'; break; }
    round++;
    if (document.hidden) wasHidden = true;
    if (!scroller.el || !scroller.el.isConnected || round % 20 === 1) {
      const next = findScroller();
      if (next.el !== scroller.el) {
        checks = 0; wasAtBottom = false; lastH = -1; stuckMoves = 0;
        lastGrow = lastProbe = Date.now();
      }
      scroller = next;
    }
    const el = scroller.el;
    if (!el) { stopReason = 'blocked'; break; }
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const count = commentCount();
    if (el.scrollHeight !== lastH || count !== lastCount) {
      lastH = el.scrollHeight; lastCount = count; lastGrow = Date.now(); checks = 0;
    }
    if (Date.now() - lastReport >= cfg.reportEvery) {
      lastReport = Date.now();
      report('滚动中：' + round + ' 轮 / ' + ((lastReport - scrollStart) / 1000).toFixed(0) + ' 秒，页面高度 ' + lastH + ' px' + (count ? '，已加载 ' + count + ' 条主评论' : '') + (loading ? '，等待后续内容加载' : '') + (clicks ? '，已点开 ' + clicks + ' 处折叠' : ''));
    }
    // 必须真的滚到底之后才允许判定"稳定"。只按高度不变就收手的话，
    // 会在离底部还差一段的地方就退出，懒加载的内容全漏掉。
    const atBottom = el.scrollTop >= maxTop - 4;
    if (!atBottom) {
      wasAtBottom = false;
      const top = el.scrollTop;
      // 留约三分之一屏的重叠，避免跨过很短的懒加载哨兵。
      moveTo(el, Math.min(maxTop, top + Math.max(200, el.clientHeight * 0.7)));
      if (round % 3 === 0) {
        const s = scan(lastH);
        loading = s.loading;
        if (s.clicked) { clicks += s.clicked; lastClick = Date.now(); }
      }
      await sleep(cfg.stepDelay);
      if (Math.abs(el.scrollTop - top) < 1) {
        if (++stuckMoves >= 5) { stopReason = 'blocked'; break; }
      } else stuckMoves = 0;
      continue;
    }
    if (!wasAtBottom) { wasAtBottom = true; arrivedAt = Date.now(); }
    const s = scan(lastH);
    loading = s.loading;
    if (s.clicked) {
      clicks += s.clicked;
      lastClick = Date.now();
      checks = 0;
      await sleep(cfg.settleDelay);
      continue;
    }
    // 首屏暂时没有滚动条也不能立刻结束，页面可能还在等下一批内容。
    // 有加载信号时，等待或报告卡住，绝不能把等待超时标成「已到底」。
    const now = Date.now();
    const idleFrom = Math.max(lastGrow, lastMutation, lastClick, arrivedAt);
    if (!loading && now - idleFrom >= cfg.quietMs && checks >= cfg.bottomChecks) { stopReason = 'stable'; break; }
    if (now - Math.max(lastGrow, lastClick, arrivedAt) >= cfg.loadingMaxMs) { stopReason = 'stalled'; break; }
    // 多轮离开底部再返回；同一个哨兵可能只在重新进入视口时触发下一页。
    if (now - Math.max(lastGrow, lastClick, arrivedAt, lastProbe) >= cfg.quietMs) {
      lastProbe = now;
      moveTo(el, Math.max(0, maxTop - el.clientHeight * 1.5));
      await sleep(cfg.stepDelay);
      moveTo(el, el.scrollHeight);
      await sleep(cfg.settleDelay);
      checks++;
      continue;
    }
    moveTo(el, el.scrollHeight);
    await sleep(cfg.settleDelay);
  }
  mo.disconnect();
  const scrollInfo = { stopReason, rounds: round, scrollMs: Date.now() - scrollStart, clicks, hidden: wasHidden, bottomChecks: checks, loading, mainComments: commentCount() };
  if (scroller.el && scroller.el.isConnected) scroller.el.scrollTop = 0;
  await sleep(400);

  // 克隆 DOM 再处理，避免改动用户正在看的页面
  const originals = [...document.querySelectorAll('img')];
  const cloneRoot = document.documentElement.cloneNode(true);
  const cloned = [...cloneRoot.querySelectorAll('img')];
  const blobs = {};
  const blobJobs = [];
  for (let i = 0; i < originals.length; i++) {
    // 不能用 img.src：src="" 时 Chrome 会把它解析成页面自身的地址，之后会被当成图片去下载（拿到 text/html）
    const src = originals[i].currentSrc || originals[i].getAttribute('src') || '';
    if (src && cloned[i]) cloned[i].setAttribute('src', src);
    if (src.startsWith('blob:') && !(src in blobs)) {
      blobs[src] = null;
      // blob 读取互不依赖，并行进行
      blobJobs.push((async () => {
        try {
          const b = await (await fetch(src)).blob();
          blobs[src] = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = rej;
            fr.readAsDataURL(b);
          });
        } catch (e) { delete blobs[src]; /* 拿不到就算了 */ }
      })());
    }
  }
  await Promise.all(blobJobs);
  const h1 = document.querySelector('h1.ts');
  return {
    html: '<!DOCTYPE html>\n' + cloneRoot.outerHTML,
    baseUrl: document.baseURI || location.href, // 尊重 <base href>，SPA 站点的相对路径靠它解析
    title: document.title || '',
    subject: h1 && h1.textContent ? h1.textContent.trim() : '',
    blobs,
    nodesBefore,
    nodesAfter: document.querySelectorAll('*').length,
    scrollInfo,
  };
}
