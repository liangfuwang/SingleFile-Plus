/* common.js — 弹窗与 offscreen 共用的文件名处理 */

/* 标题清洗：只去掉站点后缀和会让文件名出问题的字符。
 * 【】「」[] 都是合法的文件名字符，必须保留 —— 它们常常是帖子主题的一部分。 */
function sanitize(name) {
  return (name || '')
    .replace(/\s*-\s*[^-]*Powered by Discuz!.*$/i, '')
    .replace(/\s*-\s*稀缺资源专区.*$/i, '')
    .replace(/\s*[-–—|]\s*(飞书云文档|飞书|Notion|语雀)\s*$/i, '')
    .replace(/[♈♉♊♋♌♍♎♏♐♑♒♓⛎]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/[﷐-﷯￰-￿]/g, '')
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

/* ---------- 自动识别抓取方式 ----------
 * 静态抓取只能拿到服务端返回的 HTML；SPA（飞书、Notion、知识星球…）的正文由 JS 渲染，
 * 静态拿到的是空壳。这里判断静态 HTML 里有没有"真正的正文"。 */
const SPA_HOSTS = [
  /(^|\.)feishu\.cn$/i, /(^|\.)larksuite\.com$/i, /(^|\.)larkoffice\.com$/i,
  /(^|\.)notion\.so$/i, /(^|\.)notion\.site$/i,
  /(^|\.)yuque\.com$/i,
  /(^|\.)zsxq\.com$/i,
];
function isSpaUrl(url) {
  try { return SPA_HOSTS.some((re) => re.test(new URL(url).hostname)); } catch { return false; }
}

/* 前端框架的挂载点：存在且里面几乎没字，基本就是空壳 */
const SPA_ROOT_SELECTOR = 'app-root, #app, #root, #__next, #__nuxt, #q-app, #app-root, [ng-version], [ng-app], [data-reactroot]';

function analyzeStaticHtml(html) {
  if (/agree_submit/.test(html)) return { shell: false, textLen: 0, reason: '年龄确认门（静态流程可自动通过）' };
  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch { return { shell: false, textLen: 0, reason: '无法解析' }; }
  doc.querySelectorAll('script, style, noscript, template, head').forEach((el) => el.remove());
  const textLen = ((doc.body && doc.body.textContent) || '').replace(/\s+/g, '').length;
  const root = doc.body && doc.body.querySelector(SPA_ROOT_SELECTOR);
  const rootLen = root ? (root.textContent || '').replace(/\s+/g, '').length : -1;
  if (textLen < 200) return { shell: true, textLen, reason: '静态 HTML 正文仅 ' + textLen + ' 字' + (root ? '，且有前端框架挂载点 <' + root.tagName.toLowerCase() + (root.id ? '#' + root.id : '') + '>' : '') };
  if (root && rootLen < 100 && textLen < 800) return { shell: true, textLen, reason: '前端框架挂载点内几乎没有内容（' + rootLen + ' 字）' };
  return { shell: false, textLen, reason: '静态 HTML 含正文 ' + textLen + ' 字' };
}

/* Discuz 帖子的完整主题 = 主题分类（[原创]，在 h1.ts 的链接里）+ 标题（#thread_subject）。
 * <title> 里只有后者，所以优先读 h1.ts。 */
function titleFromHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const h1 = doc.querySelector('h1.ts');
    const t = h1 && h1.textContent && h1.textContent.trim();
    return t || (doc.title || '').trim();
  } catch {
    return ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim();
  }
}
