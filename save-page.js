#!/usr/bin/env node
/**
 * save-page.js — PageVault：抓取 Discuz 论坛帖子并生成图片内嵌的单文件 HTML
 *
 * 用法: node save-page.js <帖子URL> [输出文件名.html]
 * 流程: 登录(如需) → 过年龄门(如需) → 抓页面 → 带Referer下载所有图片
 *       → base64内嵌 → 移除外部脚本 → 输出单文件
 */
const fs = require('fs');
const path = require('path');

const THREAD_URL = process.argv[2];
if (!THREAD_URL || !/^https?:\/\//.test(THREAD_URL)) {
  console.error('用法: PV_USER=xxx PV_PASS=yyy node save-page.js <帖子URL> [输出文件名.html]');
  process.exit(1);
}
const SITE = new URL(THREAD_URL).origin;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const USERNAME = process.env.PV_USER;
const PASSWORD = process.env.PV_PASS;
if (!USERNAME || !PASSWORD) {
  console.error('缺少账号：请设置环境变量 PV_USER 和 PV_PASS');
  process.exit(1);
}

// 站点自定义头像经常直接返回 403（无论带不带 Referer/Cookie），
// 但站内默认头像 noavatar_*.gif 是可访问的。原页面也靠 onerror 回退到它。
const AVATAR_FALLBACKS = [
  [/_avatar_small\./i, `${SITE}/uc_server/images/noavatar_small.gif`],
  [/_avatar_middle\./i, `${SITE}/uc_server/images/noavatar_middle.gif`],
  [/_avatar_big\./i, `${SITE}/uc_server/images/noavatar_big.gif`],
];

// 实在下载不到时的兜底占位图（内联 SVG，本地打开零外部请求）
const PLACEHOLDER_IMG = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">' +
  '<rect width="160" height="120" fill="#eceff3"/>' +
  '<circle cx="52" cy="42" r="14" fill="#c3ccd6"/>' +
  '<path d="M18 108c4-22 16-32 34-32s30 10 34 32z" fill="#c3ccd6"/>' +
  '<path d="M104 40h40v10h-40z" fill="#c3ccd6"/>' +
  '<path d="M104 58h40v10h-40z" fill="#d5dbe2"/>' +
  '</svg>');

// ---------- 简易 cookie jar ----------
const cookies = new Map();
const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
function storeCookies(resp) {
  const raw = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

// ---------- HTTP ----------
async function http(url, opts = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(opts.headers || {}),
  };
  if (cookies.size && !opts.noCookies) headers.Cookie = cookieHeader();
  const resp = await fetch(url, { ...opts, headers, redirect: opts.redirect || 'manual' });
  storeCookies(resp);
  return resp;
}
async function getHtml(url, referer) {
  let resp = await http(url, { headers: referer ? { Referer: referer } : {} });
  // 跟随跳转
  let hops = 0;
  while (resp.status >= 300 && resp.status < 400 && resp.headers.get('location') && hops++ < 5) {
    const loc = new URL(resp.headers.get('location'), url).href;
    resp = await http(loc, { headers: referer ? { Referer: url } : {} });
    url = loc;
  }
  return { url, html: await resp.text() };
}

function formhash(html) {
  const m = html.match(/name="formhash" value="([^"]+)"/);
  return m ? m[1] : null;
}

// ---------- 登录 ----------
async function login() {
  const { html } = await getHtml(`${SITE}/member.php?mod=logging&action=login`);
  const fh = formhash(html);
  if (!fh) throw new Error('拿不到登录 formhash');
  const body = new URLSearchParams({
    formhash: fh, username: USERNAME, password: PASSWORD,
    quicklogin: 'yes', handlekey: 'ls', loginhash: 'xxxx',
  });
  const resp = await http(`${SITE}/member.php?mod=logging&action=login&loginsubmit=yes&inajax=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${SITE}/member.php?mod=logging&action=login` },
    body: body.toString(),
  });
  const text = await resp.text();
  if (!/欢迎您回来/.test(text)) {
    console.error('登录失败:', text.slice(0, 500));
    throw new Error('登录失败');
  }
  const user = ((text.match(/欢迎您回来，([^，]+)，/) || [])[1] || '').replace(/<[^>]*>/g, '').trim();
  console.log('✓ 登录成功:', user);
}

// ---------- 过年龄门 ----------
async function passAgeGate(threadUrl) {
  const { html } = await getHtml(threadUrl);
  if (!/agree_submit/.test(html)) { console.log('✓ 无年龄门'); return html; }
  const fh = formhash(html);
  const body = new URLSearchParams({ formhash: fh, agree_submit: '是' });
  const resp = await http(threadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: threadUrl },
    body: body.toString(),
  });
  await resp.text();
  const { html: html2 } = await getHtml(threadUrl, SITE + '/');
  console.log('✓ 已过年龄门');
  return html2;
}

// ---------- 收集并下载图片 ----------
function collectImageUrls(html, baseUrl) {
  const urls = new Map(); // abs -> [出现形式]
  const add = (u) => {
    if (!u || u.startsWith('data:') || u.startsWith('#')) return;
    try {
      const abs = new URL(u, baseUrl).href;
      if (!/^https?:/.test(abs)) return;
      if (!/\.(jpe?g|png|gif|webp|bmp|avif)(\?|$)/i.test(abs) && !/attachment/i.test(abs)) {
        // 仍收进来试试（有些图无后缀），但仅限明显是图片的
        if (!/\/data\/attachment\//.test(abs) && !/uc_server\/data/.test(abs)) return;
      }
      if (/\.js(\?|$)/i.test(abs) || /\.css(\?|$)/i.test(abs)) return;
      urls.set(abs, (urls.get(abs) || 0) + 1);
    } catch { /* ignore */ }
  };
  // img 标签各属性
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    const tag = m[0];
    for (const attr of ['zoomfile', 'file', 'data-original', 'data-src', 'src', 'data-echo']) {
      const a = tag.match(new RegExp(`${attr}="([^"]+)"`));
      if (a) add(a[1]);
    }
  }
  // 内联 style 背景图
  for (const m of html.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) add(m[2]);
  return urls;
}

// 头像类图片失败时自动回退到站内默认头像
async function downloadWithFallback(url, referer, cache) {
  try {
    return await downloadImage(url, referer);
  } catch (e) {
    const rule = AVATAR_FALLBACKS.find(([re]) => re.test(url));
    if (!rule) throw e;
    const fb = rule[1];
    if (cache.has(fb)) return cache.get(fb);
    const d = await downloadImage(fb, referer);
    cache.set(fb, d);
    return d;
  }
}

async function downloadImage(url, referer) {
  const resp = await http(url, { headers: { Referer: referer } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const type = resp.headers.get('content-type') || '';
  const m = url.match(/\.(jpe?g|png|gif|webp|bmp|avif)(\?|$)/i);
  let mime = type.split(';')[0];
  if (!mime.startsWith('image/')) {
    const ext = m ? m[1].toLowerCase() : 'jpeg';
    mime = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' }[ext] || 'image/jpeg';
  }
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// ---------- 内联样式表 ----------
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
      const resp = await http(url, { headers: { Referer: pageUrl } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const css = absolutizeCssUrls(await resp.text(), url);
      out = out.split(tag).join(`<style data-src="${url}">\n${css}\n</style>`);
    } catch (e) {
      out = out.split(tag).join('');
      console.warn(`  ⚠ 样式表无法内嵌，已移除: ${url} (${e.message})`);
    }
  }
  return out;
}

// ---------- 主流程 ----------
async function main() {
  const threadUrl = THREAD_URL;
  const outFile = process.argv[3] || `thread-${(threadUrl.match(/tid=(\d+)/) || [])[1] || Date.now()}.html`;

  await login();
  let html = await passAgeGate(threadUrl);
  // 部分站点年龄门后需要再抓一次
  if (/agree_submit/.test(html)) html = (await getHtml(threadUrl, SITE + '/')).html;
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || outFile;
  console.log('✓ 页面标题:', title.trim());

  // 分页检测
  const pages = [...new Set([...html.matchAll(/[?&]page=(\d+)/g)].map((m) => +m[1]))];
  const maxPage = pages.length ? Math.max(...pages) : 1;
  console.log(`✓ 共 ${maxPage} 页`);
  const pageHtmls = [html];
  for (let p = 2; p <= maxPage; p++) {
    const sep = threadUrl.includes('?') ? '&' : '?';
    const { html: ph } = await getHtml(`${threadUrl}${sep}page=${p}`, threadUrl);
    pageHtmls.push(ph);
    console.log(`  ✓ 第 ${p}/${maxPage} 页抓取完成 (${ph.length} 字节)`);
    await new Promise((r) => setTimeout(r, 800));
  }
  html = pageHtmls.join('\n<!-- PAGE BREAK -->\n');

  // 收集图片
  const urlMap = collectImageUrls(html, threadUrl);
  console.log(`✓ 发现 ${urlMap.size} 个图片URL，开始下载...`);
  const dataUris = new Map();
  const fallbackCache = new Map();
  let ok = 0, placeholder = 0;
  const queue = [...urlMap.keys()];
  const CONCURRENT = 5;
  const workers = Array.from({ length: CONCURRENT }, async () => {
    while (queue.length) {
      const u = queue.shift();
      try {
        const d = await downloadWithFallback(u, threadUrl, fallbackCache);
        dataUris.set(u, d);
        ok++;
      } catch (e) {
        // 不让单张图片失败阻塞整篇；用内联占位图替换，保证离线无外部请求
        dataUris.set(u, PLACEHOLDER_IMG);
        placeholder++;
        console.warn(`  ⚠ 图片不可用，已用占位图替代: ${u} (${e.message})`);
      }
      if ((ok + placeholder) % 10 === 0) console.log(`  进度: ${ok + placeholder}/${urlMap.size}`);
    }
  });
  await Promise.all(workers);
  console.log(`✓ 图片下载完成: 成功 ${ok}, 占位替代 ${placeholder}`);

  // 内联样式表（统一处理 403 的 t5/style.css，避免本地打开时请求失败报错）
  let out = await inlineStylesheets(html, threadUrl);
  for (const [u, d] of dataUris) {
    // 转义正则特殊字符
    const esc = u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(esc, 'g'), d);
    // 相对路径形式
    try {
      const rel = new URL(u).pathname.replace(/^\//, '');
      out = out.replace(new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), d);
    } catch { /* ignore */ }
  }
  // 懒加载修复：真实图片在 zoomfile/file 属性里（已替换为 data URI），
  // 把它写进 src，同时删掉冗余的 zoomfile/file 属性（避免同一张图存 3 份）
  out = out.replace(/<img\b[^>]*>/g, (tag) => {
    if (!/\b(zoomfile|file)="data:image/.test(tag)) return tag;
    const real = tag.match(/\b(?:zoomfile|file)="(data:image[^"]+)"/);
    if (!real) return tag;
    let nt = /\bsrc="[^"]*"/.test(tag)
      ? tag.replace(/\bsrc="[^"]*"/, `src="${real[1]}"`)
      : tag.replace(/^<img\b/, `<img src="${real[1]}"`);
    nt = nt.replace(/\s*(zoomfile|file)="data:image[^"]*"/g, '');
    return nt;
  });

  // 移除页面全部脚本（含内联）。Discuz 的内联脚本依赖已被删除的外部脚本，
  // 保留会在本地打开时抛 ReferenceError（HTMLNODE / initSearchmenu 等）
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<script\b[^>]*\/>/gi, '');
  // noscript 里的内容没必要保留
  out = out.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');

  // ---------- 注入点击放大灯箱（缩放/拖动/切换） ----------
  const lightbox = `<style id="sf-lightbox-style">
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
  out = out.replace(/<\/body>/i, lightbox + '\n</body>');

  fs.writeFileSync(outFile, out);
  const sizeMB = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`\n✅ 完成: ${path.resolve(outFile)} (${sizeMB} MB, 图片内嵌 ${ok} 张${placeholder ? `, 占位替代 ${placeholder} 张` : ''})`);

  // 清理 cookies 里的敏感信息
  cookies.clear();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
