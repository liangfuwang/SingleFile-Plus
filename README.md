# 示例站点 帖子 → 单文件 HTML 保存工具（绕过图片防盗链）

## 问题原因

- 帖子图片**需要登录**才能看到。
- 图片托管在独立图床 `img.example.com`，有**防盗链**（校验 Referer + Cookie）。SingleFile 抓不到图片，本地打开时请求被拒，显示"图片被盗"占位图。

## 方案 A：全自动脚本（推荐）

`save-singlefile.js` 全流程：登录 → 过年龄门 → 抓页面（含分页）→ 带防盗链头下载全部图片 → base64 内嵌 → 移除外部脚本 → 输出单文件 HTML。

### 用法

```bash
NODE_USE_ENV_PROXY=1 node save-singlefile.js "<帖子URL>" "输出文件名.html"
```

示例：

```bash
NODE_USE_ENV_PROXY=1 node save-singlefile.js \
  "https://forum.example.com/forum.php?mod=viewthread&tid=123456" \
  "output.html"
```

> `NODE_USE_ENV_PROXY=1` 让 Node 的 fetch 走系统代理（本机代理 127.0.0.1:10808，直连会被重置）。

### 账号

脚本内置了账号，也可用环境变量覆盖：

```bash
PV_USER=xxx PV_PASS=yyy NODE_USE_ENV_PROXY=1 node save-singlefile.js ...
```

### 特性

- 自动处理登录、年龄确认门、Discuz 懒加载（`file`/`zoomfile` 属性里的真实图片地址）
- 自动跟随分页（`?page=N`），多页帖子合成一个文件
- 站内图片（头像、图标）一并内嵌，本地打开无任何外部请求
- 样式表自动内嵌为 `<style>`，页面脚本全部移除，本地打开无 JS 报错
- 自定义头像被站点 403 时自动回退到站内默认头像（`noavatar_*.gif`）
- 实在拿不到的图片用内联 SVG 占位图替换，绝不残留外部请求、不中断整篇
- 5 路并发下载，失败项会打印警告

## 方案 B：浏览器控制台脚本（备用）

如果某些帖子脚本抓不到（如需要回复可见、JS 动态加载），改用 `inline-images.js`：

1. 浏览器登录后打开帖子页
2. `F12` → Console → 粘贴 `inline-images.js` 全部内容 → 回车
3. 等进度条走完 → 用 SingleFile 扩展保存

## 文件说明

| 文件 | 用途 |
|------|------|
| `save-singlefile.js` | 全自动抓取脚本（Node ≥ 24） |
| `inline-images.js` | 浏览器控制台脚本（配合 SingleFile 扩展） |
| `output.html` | 已生成的成品（9.9 MB，40 张图全部内嵌） |
