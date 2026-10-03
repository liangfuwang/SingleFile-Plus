/* ============================================================
 * 单文件网页图片内嵌工具（防防盗链版）
 * 用途：在已登录的浏览器里运行，把当前页面所有图片（包括懒加载的）
 *       下载并转为 data URI 内嵌，之后再用 SingleFile 保存即可
 *       得到图片永不离线的单文件 HTML。
 * 用法：打开目标帖子页面 → F12 → Console → 粘贴本脚本回车 → 等待完成
 * ============================================================ */
(async () => {
  // ---------- 配置 ----------
  const CONCURRENT = 6;      // 并发下载数
  const INCLUDE_BG = true;   // 是否处理 CSS 内联 background-image
  // 自定义头像常直接 403，回退到站内默认头像
  const AVATAR_FALLBACKS = [
    [/_avatar_small\./i, 'https://forum.example.com/uc_server/images/noavatar_small.gif'],
    [/_avatar_middle\./i, 'https://forum.example.com/uc_server/images/noavatar_middle.gif'],
    [/_avatar_big\./i, 'https://forum.example.com/uc_server/images/noavatar_big.gif'],
  ];

  // ---------- 收集所有图片 URL ----------
  const urls = new Set();
  const addUrl = (u) => {
    if (!u) return;
    u = u.trim();
    if (!u || u.startsWith('data:') || u.startsWith('#')) return;
    try {
      const abs = new URL(u, location.href).href;
      if (abs.startsWith('http')) urls.add(abs);
    } catch (e) { /* ignore */ }
  };

  document.querySelectorAll('img').forEach((img) => {
    // Discuz 懒加载：真实地址在 file 属性
    addUrl(img.getAttribute('file'));
    addUrl(img.getAttribute('data-original'));
    addUrl(img.getAttribute('data-src'));
    addUrl(img.getAttribute('src'));
    // srcset
    const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (ss) ss.split(',').forEach((part) => addUrl(part.trim().split(/\s+/)[0]));
  });
  document.querySelectorAll('source[srcset]').forEach((s) => {
    (s.getAttribute('srcset') || '').split(',').forEach((p) => addUrl(p.trim().split(/\s+/)[0]));
  });
  if (INCLUDE_BG) {
    document.querySelectorAll('[style*="background"]').forEach((el) => {
      const m = (el.getAttribute('style') || '').match(/url\((['"]?)([^'")]+)\1\)/);
      if (m) addUrl(m[2]);
    });
  }

  const list = [...urls];
  if (!list.length) { alert('页面上没有发现可处理的图片'); return; }

  // ---------- 进度提示 ----------
  let done = 0, ok = 0;
  const tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;background:rgba(0,0,0,.8);color:#fff;padding:8px 14px;border-radius:6px;font:13px/1.5 monospace;';
  document.body.appendChild(tip);
  const update = () => { tip.textContent = `图片内嵌进度: ${done}/${list.length} (成功 ${ok})`; };
  update();

  // ---------- 下载并转为 data URI ----------
  const cache = new Map(); // url -> dataURI | null
  const toDataUrl = async (url) => {
    try {
      return await fetchAsDataUrl(url);
    } catch (e) {
      const rule = AVATAR_FALLBACKS.find(([re]) => re.test(url));
      if (rule) {
        try { return await fetchAsDataUrl(rule[1]); } catch { /* fallthrough */ }
      }
      console.warn('⚠ 图片下载失败(可能跨域限制):', url, e.message);
      return null;
    }
  };
  const fetchAsDataUrl = async (url) => {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  };

  const queue = [...list];
  const workers = Array.from({ length: CONCURRENT }, async () => {
    while (queue.length) {
      const url = queue.shift();
      const data = await toDataUrl(url);
      cache.set(url, data);
      if (data) ok++;
      done++;
      update();
    }
  });
  await Promise.all(workers);

  // ---------- 替换页面中的引用 ----------
  let replaced = 0;
  const swap = (u) => {
    const d = cache.get(new URL(u, location.href).href);
    return d || null;
  };
  document.querySelectorAll('img').forEach((img) => {
    for (const attr of ['file', 'data-original', 'data-src', 'src']) {
      const v = img.getAttribute(attr);
      if (v) {
        const d = swap(v);
        if (d) { img.setAttribute('src', d); replaced++; }
      }
    }
    // 清掉懒加载痕迹，防止脚本再改回占位图
    ['file', 'data-original', 'data-src'].forEach((a) => img.removeAttribute(a));
    img.removeAttribute('srcset');
    img.removeAttribute('data-srcset');
    img.removeAttribute('lazyload');
    img.loading = 'eager';
  });
  document.querySelectorAll('source').forEach((s) => s.remove());
  if (INCLUDE_BG) {
    document.querySelectorAll('[style*="background"]').forEach((el) => {
      const style = el.getAttribute('style') || '';
      const ns = style.replace(/url\((['"]?)([^'")]+)\1\)/g, (m0, q, u) => {
        const d = swap(u);
        return d ? `url("${d}")` : m0;
      });
      if (ns !== style) { el.setAttribute('style', ns); replaced++; }
    });
  }

  // ---------- 完成 ----------
  tip.remove();
  const failed = [...cache.entries()].filter(([, v]) => !v).map(([k]) => k);
  console.log(`✅ 完成：成功内嵌 ${ok}/${list.length} 张图片，替换了 ${replaced} 处引用`);
  if (failed.length) {
    console.log('❌ 以下图片下载失败（跨域或防盗链拦截），详见列表：');
    console.table(failed);
  }
  alert(`图片内嵌完成！成功 ${ok}/${list.length}。\n现在请用 SingleFile 扩展保存本页，\n图片将以 base64 形式永久保存在单个 HTML 文件里。`);
})();
