# PageVault — 网页 → 单文件 HTML 保存工具（支持登录页与图片防盗链）

## 问题原因

- 部分论坛帖子的图片**需要登录**才能看到。
- 图片常托管在独立图床上，有**防盗链**（校验 Referer + Cookie）。通用的单文件保存工具可能抓不到图片，本地打开时请求被拒，显示"图片被盗"之类的占位图。

## 方案 A：全自动脚本（推荐）

`save-page.js` 全流程：登录 → 过年龄门 → 抓页面（含分页）→ 带防盗链头下载全部图片 → base64 内嵌 → 移除外部脚本 → 输出单文件 HTML。

### 用法

```bash
PV_USER=xxx PV_PASS=yyy node save-page.js "<帖子URL>" "输出文件名.html"
```

示例：

```bash
PV_USER=xxx PV_PASS=yyy node save-page.js \
  "https://forum.example.com/forum.php?mod=viewthread&tid=123456" \
  "output.html"
```

> 目标站点需要代理才能访问时，加上 `NODE_USE_ENV_PROXY=1` 并设置 `HTTPS_PROXY`，Node 的 fetch 就会走代理。

### 账号

脚本不内置账号，必须通过环境变量 `PV_USER`、`PV_PASS` 提供，缺失时直接报错退出。请勿把账号写进仓库文件。

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

## 与 SingleFile 的对比

[SingleFile](https://github.com/gildas-lormeau/SingleFile) 是成熟的通用网页存档扩展，本项目名称与之区分，定位也不同：PageVault 不是它的替代品，而是针对"需要登录 + 图床防盗链 + Discuz 论坛"这类场景的补充。

| 维度 | SingleFile | PageVault |
|------|-----------|-----------|
| 定位 | 通用网页存档，覆盖任意网站 | 专注论坛帖 / SPA 文档的离线存档 |
| 成熟度 | 长期维护，社区大，多浏览器支持 | 个人项目，仅 Chrome（MV3） |
| 抓取方式 | 在当前页面 DOM 上序列化 | 自动识别：静态请求或渲染抓取 |
| 防盗链图片 | 依赖浏览器正常请求，图床校验 Referer 时可能抓不到 | 用 `declarativeNetRequest` 临时注入 Referer，并检测 302 占位图，失败不会存进文件 |
| 多页帖子 | 只保存当前页 | 自动跟随分页，合并为一个文件 |
| 懒加载图片 | 通用处理 | 针对 Discuz 的 `file` / `zoomfile` 真实地址 |
| 年龄确认门 | 需手动通过 | 自动处理 |
| 后台运行 | 需停留在页面上操作 | 任务在 offscreen 文档中后台跑，可关闭弹窗 |
| 图片查看 | 保持原页面行为 | 内置点击放大灯箱 |
| 页面脚本 | 默认移除 | 全部移除 |
| 其他功能 | 批量保存标签页、自动保存、标注、压缩、云端上传等 | 无，保持精简 |
| 依赖 | 较多功能模块 | 纯原生 JS，无外部依赖 |

选择建议：普通网页、需要标注/批量/云同步，用 SingleFile；需要登录的论坛帖、带防盗链图床、多页合并，用 PageVault。

## 文件说明

| 文件 | 用途 |
|------|------|
| `save-page.js` | 全自动抓取脚本（Node ≥ 24） |
| `inline-images.js` | 浏览器控制台脚本（配合 SingleFile 扩展） |
