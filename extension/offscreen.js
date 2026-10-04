/* offscreen.js — 保存流水线（抓取 → 下载图片 → 内嵌 → 生成文件）。
 * 跑在 offscreen 文档里，与弹窗生命周期无关：弹窗关了、切走标签页，任务照常继续。
 * offscreen 文档只能用 chrome.runtime，需要特权 API 的操作（标签页抓取 / Referer 规则 / 下载）
 * 一律通过消息交给 background.js 代办。 */

/* ---------- 与后台通信 ---------- */
function log(msg, cls = '') { chrome.runtime.sendMessage({ target: 'bg', type: 'log', msg, cls }).catch(() => {}); }
function progress(p) { chrome.runtime.sendMessage({ target: 'bg', type: 'progress', p }).catch(() => {}); }
async function rpc(op, args) {
  const r = await chrome.runtime.sendMessage({ target: 'bg', type: 'rpc', op, args });
  if (!r) throw new Error('后台无响应');
  if (r.error) throw Object.assign(new Error(r.error), { noRetry: !!r.noRetry });
  return r.result;
}

chrome.runtime.onMessage.addListener((m) => {
  if (!m || m.target !== 'offscreen' || m.type !== 'run') return;
  runJob(m.job);
});
async function runJob(job) {
  try {
    const mode = job.mode === 'auto' || !job.mode ? await detectMode(job.url) : job.mode;
    if (mode === 'rendered') await saveRendered(job.url, job.fname);
    else await saveStatic(job.url, job.fname);
    await chrome.runtime.sendMessage({ target: 'bg', type: 'done' });
  } catch (e) {
    await chrome.runtime.sendMessage({ target: 'bg', type: 'fail', error: (e && e.message) || String(e) });
  }
}

/* 自动识别：返回 'static' 或 'rendered'。
 * 依据（按顺序）：已知 SPA 站点 → 静态请求失败 → 静态 HTML 是空壳 →
 * 该页面已在标签页打开且真实文本量远大于静态文本量。拿不准时选静态（更快、不开标签页）。 */
async function detectMode(url) {
  log('自动识别抓取方式…', 'hl');
  progress(0.02);
  if (isSpaUrl(url)) {
    log('已知 SPA 站点 → 渲染抓取', 'ok');
    return 'rendered';
  }
  let staticInfo;
  try {
    staticInfo = analyzeStaticHtml(await fetchText(url));
  } catch (e) {
    log('静态请求失败（' + e.message + '）→ 改用渲染抓取', 'ok');
    return 'rendered';
  }
  if (staticInfo.shell) {
    log('判定为 JS 渲染页面：' + staticInfo.reason + ' → 渲染抓取', 'ok');
    return 'rendered';
  }
  const live = await rpc('probeTab', { url }).catch(() => null);
  if (live && live.textLen > staticInfo.textLen * 2 + 500) {
    log('标签页真实文本 ' + live.textLen + ' 字，远多于静态 HTML 的 ' + staticInfo.textLen + ' 字 → 渲染抓取', 'ok');
    return 'rendered';
  }
  log('判定为服务端渲染页面：' + staticInfo.reason + ' → 静态抓取', 'ok');
  return 'static';
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

  log('注入脚本：滚动触发懒加载 → 抓取渲染后的 DOM…');
  const result = await rpc('capture', { url: pageUrl });
  if (!result || !result.html) throw new Error('没取到渲染后的 DOM（页面可能还在加载，或被登录页拦截）');
  log('DOM 抓取完成: ' + (result.html.length / 1048576).toFixed(1) + ' MB', 'ok');
  progress(0.45);

  const title = (result.subject || result.title || '').trim();
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
    await rpc('setReferer', { hosts: [...hosts], origin: siteOrigin });
  } catch (e) {
    log('⚠ 无法设置 Referer 规则，部分图片可能下载失败', 'err');
  }

  try {
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
  } finally {
    await rpc('clearReferer').catch(() => { /* ignore */ });
  }

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

async function downloadHtml(html, fname) {
  const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const names = [...new Set([safeName(fname), fallbackName()].filter(Boolean))];
  try {
    return (await rpc('download', { blobUrl, names })).name;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
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
  const title = titleFromHtml(html);
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
  try {
    await rpc('setReferer', { hosts: [...hosts], origin: siteOrigin });
  } catch (e) {
    log('⚠ 无法设置 Referer 规则，部分图片可能下载失败', 'err');
  }

  // 5. 并发下载（5 路），记录失败原因
  try {
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
    log(`图片下载完成: 成功 ${ok}, 占位替代 ${list.length - ok}`, ok ? 'ok' : 'err');
    for (const [reason, n] of [...failReasons].slice(0, 5)) {
      log(`  失败原因 [x${n}]: ${reason}`, 'err');
    }
  } finally {
    await rpc('clearReferer').catch(() => { /* ignore */ });
  }
  progress(0.9);

  // 6. 替换引用 → 修懒加载 → 内联CSS → 清脚本 → 注入灯箱
  let out = replaceUrls(html, dataUris, threadUrl);
  out = fixLazyLoad(out);
  out = await inlineStylesheets(out, threadUrl);
  // 移除页面全部脚本（含内联）。Discuz 内联脚本依赖已删掉的外部脚本，
  // 保留会在本地打开时抛 ReferenceError（HTMLNODE / initSearchmenu 等）
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
  out = injectLightbox(out);

  // 7. 下载为文件
  await downloadHtml(out, fname);
  progress(1);
}

