# GenOffice Web Viewer

独立的静态预览页面，在浏览器里完成 `.pptx`、`.pdf`、`.docx` 只读展示和 PPT 放映。复杂文档的完整视觉还原仍在验收中。

改动范围仅为 `apps/viewer` 和新增的 `packages/viewer-renderers`、`packages/viewer-services`。现有 app、package、根配置及根锁文件不修改。

最新产品范围、三格式能力和界面约束见 [需求文档](REQUIREMENTS.zh-CN.md)。

## 开发运行

要求 Node ≥22.12.0，以及已有仓库开发依赖。本阶段源码构建复用现有 monorepo 依赖，尚未提供仅安装 Viewer 源码依赖的 staging 安装器。以下命令在 `repo` 下执行，均不会调用其他 app 的启动或构建：

```sh
npm run dev -w @genoffice/viewer
```

本机打开 http://127.0.0.1:11001，局域网设备打开 `http://服务器局域网IP:11001`。Vite 默认监听 `0.0.0.0:11001`。如需仅本机访问，设置 `VIEWER_HOST=127.0.0.1`。PDF 的 cmap、标准字体和 wasm 由开发服务器直接从 `pdfjs-dist` 提供。

PPT 普通预览中点击音视频封面可打开原生播放器，提供播放/暂停和进度控制；按 Esc 或点击关闭退出，翻页会停止当前媒体。放映中点击媒体可播放/暂停。资源不存在或编码不被浏览器支持时会显示错误。

三格式控制栏直接悬浮覆盖在内容区底部，不预留工具栏占位，也不因显示控制栏而缩小文档适配尺寸。提供原生下拉跳页、上一页/下一页和缩放。适合宽度/页面、PDF 旋转与文档信息、Word 修订显示收进“更多”。工具栏、顶部文件栏和错误状态区由 CSS 换行与限宽，不用 JavaScript 缩小整行；支持明暗主题与窄屏。

PPT 默认隐藏缩放比例数值，保留缩小、放大及适配操作；Word、PDF 继续显示缩放比例。PPT 放映控制栏不显示黑屏按钮。

PPT 左上角“预览”按钮展开悬浮缩略图面板，选页、点击外部或按 Esc 收起，不挤压正文。放映模式提供上一页、下一步、跳页与退出控制，下一步仍先推进原动画；键盘切页和右键菜单继续生效；黑屏按钮、B/句点快捷键及右键黑屏入口已移除。PDF/Word 目录与搜索入口隐藏，原导航、搜索和高亮代码保留。Word 仍提供只读复制/链接、修订显示模式、页色和密码重试；PDF 仍提供只读表单/批注和文档信息。

搜索控件隐藏时，`Ctrl/Cmd+F` 使用浏览器查找；`Ctrl/Cmd+ +/-` 缩放，非输入区域的 PageUp/PageDown 翻页。Word 可见快照与可访问正文保持一份辅助阅读树，键盘链接焦点会映射到可见页面。

## 链接控制界面与自动打开

主页面支持通过 query 参数控制界面显示，并将选项传递到三格式预览 iframe。没有参数时保持现有界面。`1`/`true` 为显示，`0`/`false` 为隐藏；未识别的值使用默认值。

| 参数            | 默认 | 用途                                                           |
| --------------- | ---- | -------------------------------------------------------------- |
| `embed`         | `0`  | 设为 `1` 时，下列六项显示开关默认关闭，适合嵌入预览            |
| `showHeader`    | `1`  | 顶部文件栏，包含品牌、文件名及导入入口                         |
| `showImport`    | `1`  | 本地“打开文件”入口                                             |
| `showUrlImport` | `1`  | URL 输入框和“导入 URL”按钮                                     |
| `showToolbar`   | `1`  | PPT/PDF/Word 操作栏及 Word 分页预览工具栏                      |
| `showSidebar`   | `1`  | PPT 悬浮缩略图入口；设为 `1` 不恢复产品要求隐藏的 PDF/Word 目录 |
| `showErrors`    | `1`  | 主页面和预览的错误/告警区域，包括字体、媒体错误及 PDF XFA 提示 |
| `url`           | 无   | 主页面初始化后自动导入该 HTTP/HTTPS 文件直链，无需点击导入按钮 |

显式显示开关优先于 `embed` 的默认值。例如 `?embed=1&showToolbar=1` 只恢复文档操作栏；若要恢复导入控件，需要同时恢复文件栏及对应导入项。`showToolbar=1` 不会恢复此前按产品要求隐藏的 PDF/Word 搜索控件。

单独隐藏导入入口、操作栏和错误区，保留文件名和侧栏：

```text
/?showImport=0&showUrlImport=0&showToolbar=0&showErrors=0
```

通过链接自动打开并隐藏全部宿主控件，请用 `URLSearchParams` 编码文件 URL，确保文件签名中的 `&`、`+`、`?` 等不会被当成 Viewer 参数：

```js
const link = new URL('http://127.0.0.1:11001/') // 替换为部署地址
link.searchParams.set('url', 'https://files.example.com/document.pptx?token=...&signature=...')
link.searchParams.set('embed', '1')
console.log(link.href)
```

显示开关只控制界面。隐藏错误区时错误仍会被处理。没有 `url` 的隐藏界面不会自动生成文档。预览页通过 `src` 读取父页面创建的本地文件地址，并支持同样的显示开关。参数在页面加载时读取，修改链接后重新加载生效。

## URL 导入

在顶部粘贴文件链接，点击“导入 URL”。浏览器直接 fetch 该地址，再进入 PPTX、DOCX、PDF 预览；PPT 可继续放映。文件服务器需要允许当前页面跨域访问。支持带签名参数的链接和 UTF-8 下载文件名；没有扩展名时通过文件内容识别格式。普通网页、需要浏览器登录的分享页不作为文档导入。本地文件不超过 1 GiB。

## 独立发布

```sh
npm run package -w @genoffice/viewer
```

生成 `apps/viewer/releases/genoffice-viewer/`。把该目录作为静态网站根目录交给 nginx 或其他静态托管。目录内是页面、预览 Worker、打包字体、PDF.js 资源、预生成的 `.gz` 和 `nginx.conf`，没有 Node 进程、PM2 或后端端口。

`/assets/` 中的 js、css、ttf 文件名带内容 hash。把发布目录里的 `nginx.conf` 合并进站点配置：这些文件缓存一年，`index.html` 和 `preview.html` 不长期缓存，文本、脚本、ttf 和 wasm 走 gzip。woff2 本身已压缩，不重复压缩。

含 HTML/MHT 的 Word altChunk 会在页面上提示无法转换。字体包以外的字体按回退链处理，并在界面标出。

## 验证

先构建，然后执行：

```sh
npm run typecheck -w @genoffice/viewer
npm run test -w @genoffice/viewer
npm run test:ui -w @genoffice/viewer
npm run test:standalone -w @genoffice/viewer
```

`test` 覆盖浏览器布局、解密所需的加密兼容和核心源码一致性。`test:standalone` 确认发布目录是静态站点，且本应用不再包含 Node 服务源码或 PM2 配置。

`test:ui` 使用本机 Chrome（其他路径可设置 `CHROME_PATH`），在临时静态服务器中验证三格式悬浮控制、320/375/768/1440 像素、短视口、明暗主题和 `embed` 参数，覆盖缩略图展开选页、放映鼠标/键盘控制及 Word/PDF 次要操作。截图默认写入 `/tmp/genoffice-viewer-ui`，可设置 `VIEWER_UI_SCREENSHOTS` 修改位置。退出时自动关闭浏览器和临时服务器。

核心内容组件保留原源码，PPT 没有整份转成图片/PDF，Word 没有改用其他文档渲染器。构建检查拒绝其他 app、Electron、AI provider/agent 运行时；原 `zip-gate` 使用的纯脱敏 helper 可继续复用。

## PPT 加载优化与排查

PPT 沿用原解析、文字排版和 Konva 绘制，优化资源准备与调度：

- 根据原排版过程实际请求的字体加载对应字体和字形回退，不再默认下载全部 23 个度量字体。字体就绪、浏览器字宽回传后才展示页面。
- 字宽回传只重新排版依赖这些测量值的幻灯片，Worker 只返回变化的页面，主线程合并其余页面。
- 当前页及相邻页优先准备图片；可见缩略图使用独立解码队列。大图按需取字节，通过 transferable ArrayBuffer 回传，避免结构化克隆复制。
- 侧栏只挂载可见区域及附近的缩略图画布，隐藏侧栏时不创建缩略图画布。放映组件在进入放映时加载。

在预览 iframe 的开发者工具中查看 `window.__viewerPerformance`。`stages` 包含文件读取、Worker 打开、字体就绪、排版稳定、首个画布和当前页图片就绪的累计耗时；`worker` 包含解析、字体准备、初始排版耗时及字体数量。计时从 PPT 组件启动开始，不包含此前页面脚本下载或远程源文件下载。`firstCanvas` 允许图片继续加载，应同时看 `currentPageImagesReady`。该数据只保存在当前页面内存中。

构建后执行浏览器性能回归（复用仓库的 `playwright-core`，默认使用 macOS Chrome；其他环境可设置 `CHROME_PATH`，或安装 Playwright 对应的 Chromium）：

```sh
npm run build -w @genoffice/viewer
npm run test:performance -w @genoffice/viewer
```

脚本启动临时静态服务器并自动关闭，覆盖中英文样例、40 页独立大图样例、可见缩略图、隐藏侧栏、图片字节完整性、跳页返回及放映。可设置 `VIEWER_PERF_REPORT=/tmp/viewer-performance.json` 保存测量结果；设置 `VIEWER_BASELINE_DIR` 指向优化前的静态构建目录，可额外比较两份中英文样例全部页面的画布是否逐像素一致。

本轮本机冷浏览器上下文验证中，两份样例均由 23 个字体请求降至 3 个；字体响应体合计从约 12.83 MiB 分别降至 1.65 MiB 和 3.08 MiB（未启用 HTTP 压缩）。优化前后样例画布一致，40 页媒体和放映回归通过。本机静态资源读取很快，端到端首屏耗时接近，不能把资源减少比例当成首屏加速比例。

目前仍需读取、解压整份 PPT 并完成全部页面的初始排版；媒体密集文件也仍需建立整份文档的图片描述信息。超大文件的首次解析成本还在，PDF、Word 的加载路径本轮没有调整。

[需求文档](REQUIREMENTS.zh-CN.md) · [开发计划](DEVELOPMENT_PLAN.zh-CN.md) · [交付状态与剩余验收](IMPLEMENTATION_STATUS.md) · [逐项功能审查](FEATURE_AUDIT.zh-CN.md)
