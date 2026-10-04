/* popup.js — 插件弹窗逻辑 */
const $url = document.getElementById('url');
const $fname = document.getElementById('fname');
const $go = document.getElementById('go');
const $log = document.getElementById('log');
const $bar = document.querySelector('.bar');
const $barFill = document.getElementById('barFill');

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


/* 用户没手动改过文件名时，不把预填值传给后台，让后台按抓到的完整主题自动命名 */
let fnameEdited = false;
$fname.addEventListener('input', () => { fnameEdited = true; });

/* 页面里的完整主题。Discuz 的主题分类（如 [原创]）在 h1.ts 里，不在 <title> 里 */
async function pageSubject(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { const h = document.querySelector('h1.ts'); return h && h.textContent ? h.textContent : ''; },
    });
    return (r && r.result) || '';
  } catch { return ''; }
}

/* 打开时填入当前标签页 URL，并预生成文件名 */
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && /^https?:/.test(tab.url)) {
    $url.value = tab.url;
    const subject = await pageSubject(tab.id);
    const title = subject || tab.title;
    if (title && !fnameEdited) $fname.value = safeName(sanitize(title));
  }
})();

/* ---------- 与后台同步任务状态 ----------
 * 任务跑在后台，弹窗只是个窗口：随时可以关，重新打开会恢复日志和进度。 */
function renderStatus(status) {
  const running = status === 'running';
  $go.disabled = running;
  $go.textContent = running ? '后台保存中…（可关闭弹窗、切换标签页）' : '保存为单文件 HTML';
}

chrome.runtime.onMessage.addListener((m) => {
  if (!m || m.target !== 'popup') return;
  if (m.type === 'log') log(m.msg, m.cls);
  else if (m.type === 'progress') progress(m.p);
  else if (m.type === 'status') {
    renderStatus(m.status);
    if (m.status !== 'running') chrome.runtime.sendMessage({ target: 'bg', type: 'ack' }).catch(() => {});
  }
});

(async () => {
  const st = await chrome.runtime.sendMessage({ target: 'bg', type: 'getState' }).catch(() => null);
  if (!st || st.status === 'idle') return;
  for (const l of st.logs) log(l.msg, l.cls);
  progress(st.progress || 0);
  renderStatus(st.status);
  if (st.status === 'running' && st.url) $url.value = st.url;
  chrome.runtime.sendMessage({ target: 'bg', type: 'ack' }).catch(() => {});
})();

$go.addEventListener('click', async () => {
  const url = $url.value.trim();
  if (!/^https?:\/\//.test(url)) { log('✗ 请输入有效的 http(s) URL', 'err'); return; }
  $log.innerHTML = '';
  progress(0.01);
  const fname = fnameEdited ? $fname.value.trim() : '';
  const r = await chrome.runtime.sendMessage({
    target: 'bg', type: 'start', url, fname: fname || undefined,
  }).catch((e) => ({ error: e.message }));
  if (r && r.error) { log('✗ ' + r.error, 'err'); return; }
  renderStatus('running');
});
