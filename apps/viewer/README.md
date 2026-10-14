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

PPT 普通预览提供元素/文字链接、幻灯片跳转、原生下拉页码选择和缩放/适配，私有字体失败后自动重试并重新测量。PDF 提供缩略图、书签/标题目录、只读批注正文/回复、原生下拉页码选择、页码追踪和文档信息。Word 提供只读复制/链接、标题和书签导航、修订显示模式、页色、缩放和密码重试；混合分栏及跨节布局在原测量算法收敛后生成可见页面，图片和嵌入字体从文档 zip 读取。PDF/Word 搜索控件默认隐藏，搜索与高亮实现保留。

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
| `showSidebar`   | `1`  | PPT 缩略图、PDF/Word 导航侧栏                                  |
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

生成 `apps/viewer/releases/genoffice-viewer/`。把该目录作为静态网站根目录交给 nginx 或其他静态托管。目录内是页面、预览 Worker、打包字体、PDF.js 资源和许可证，没有 Node 进程、PM2 或后端端口。

含 HTML/MHT 的 Word altChunk 会在页面上提示无法转换。字体包以外的字体按回退链处理，并在界面标出。

## 验证

先构建，然后执行：

```sh
npm run typecheck -w @genoffice/viewer
npm run test -w @genoffice/viewer
npm run test:browser -w @genoffice/viewer
npm run test:reading -w @genoffice/viewer
npm run test:url -w @genoffice/viewer
npm run test:ui -w @genoffice/viewer
npm run test:media -w @genoffice/viewer
npm run test:standalone -w @genoffice/viewer
```

浏览器测试需要本机 Chrome/Chromium，可通过 `VIEWER_CHROME_PATH` 指定。截图与生成的测试文件位于忽略提交的 `test-results`。`test:standalone` 确认发布目录是静态站点，不含 Node 服务或 PM2 配置。

核心内容组件保留原源码，PPT 没有整份转成图片/PDF，Word 没有改用其他文档渲染器。构建检查拒绝其他 app、Electron、AI provider/agent 运行时；原 `zip-gate` 使用的纯脱敏 helper 可继续复用。

[需求文档](REQUIREMENTS.zh-CN.md) · [开发计划](DEVELOPMENT_PLAN.zh-CN.md) · [交付状态与剩余验收](IMPLEMENTATION_STATUS.md) · [逐项功能审查](FEATURE_AUDIT.zh-CN.md)
