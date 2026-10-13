# GenOffice 无 Electron 预览 / 放映移植调研

调研日期：2026-10-13。基于本地 `4863835963c99793c47b72473900c483e9fa0c2a`。
目标：Node.js 后端 + 浏览器前端；保留文件预览、PPT 放映和媒体播放；去掉编辑界面、写入接口、AI 和桌面宿主。

用户补充约束：**完全沿用项目现有渲染方式还原。** 解析、排版、绘制、节点结构、样式和播放算法以此 commit 为基线；移植验收对象是 GenOffice 本身的显示与播放结果。

首期范围已进一步确定为 **PPTX / PDF / DOCX**，单一独立应用放在 `apps/viewer`。具体交付计划见 [独立 Viewer 开发计划](/Applications/work/genoffice/repo/apps/viewer/DEVELOPMENT_PLAN.zh-CN.md)。本文保留六格式研究作为后续参考；首期的目录、阶段与依赖以开发计划为准，暂不交付 Rust/XLSX 或独立 HTML/Markdown Viewer。

## 结论

**可行。适合抽取引擎和展示组件，新增 Web 应用，不适合直接把七个 Electron 应用整体改成网站。**

最值得复用的是 PPTX 解析、排版和放映；PDF 已经使用浏览器原生可运行的 PDF.js；Excel 的前端是 Univer，但 XLSX 文件解析目前依赖 Rust sidecar；Word 的解析和分页可以复用，不过分页依赖浏览器 DOM 和现有 Tiptap 视图结构。

建议保留现有仓库核心包，新增 `apps/viewer-server`、`apps/viewer-web`，逐步抽出只读组件。优先打通 PPTX/PDF，然后补 Markdown/HTML、Excel、Word。首版支持现代格式 `.pptx/.pdf/.docx/.xlsx/.md/.html`，旧版二进制 `.ppt/.doc/.xls` 作为独立转换范围估算。

**Word 必须保留项目自身的 DOCX 解析、Tiptap 自定义节点、DOM 测量和分页；Markdown 必须保留现有 Markdown 解析与节点渲染。** 不采用 LibreOffice 转 PDF、新 Markdown 渲染器、PPT 转图片/PDF等替代展示路径。

Node 负责后端入口、HTTP API、任务和存储，Excel 保留原 Rust 子进程。DOCX 继续在浏览器 Worker 中使用项目解析器，不强行搬到服务端。Tiptap/Univer 保留作为底层展示依赖，产品禁止编辑，写入和 AI 能力从运行路径移除。替换引擎或要求所有代码都改为 JavaScript 与本次保留渲染方式的范围不兼容。

审查补充：PPT 必须保留浏览器字宽回传与二次排版；PDF 必须保留表单只读展示；HTML/Markdown 必须支持文档及外部资源一起导入；含 HTML/MHT altChunk 的 DOCX 必须接入原转换器及已有 Playwright 驱动。以下接口为拟建协议，尚未实现。

## 实际架构与代码证据

### Electron 是宿主，核心展示并非全部依赖 Electron

- 根 `package.json` 为 npm workspaces，当前要求 Node >=22.12.0；存在七个 Electron 应用及共享包。`postinstall: install-electron`、Electron 构建和打包脚本需要从 Web 发布路径移除。
- `apps/slides/vite.renderer.config.ts` 已有单独的 Vite renderer 开发服务，但现有页面仍依赖 preload 注入的 `window.slidesApi`，单独启动 Vite 不等于获得可用的 Web Viewer。
- `packages/pptx-engine/src/zip.ts` 使用 `node:crypto`，其他模块还有 `node:zlib` 等依赖。因此 PPTX 解析保留在 Node 后端；浏览器只加载渲染模块及类型，避免直接导入 engine 主入口。
- `packages/pptx-render/src/build-slide.ts` 专门使用浏览器安全的子路径，并生成 `RenderSlide` 数据。现有注释已经明确指出 engine 主入口会破坏浏览器构建。
- `apps/*/src/main` 同时包含窗口、菜单、IPC、编辑、AI、文件读写；不能把整个 main 文件直接 import 到 HTTP 服务。

### PPTX：已有完整的可抽取展示链路

当前链路：

```text
本地文件
  → openPptx / materializeSlide
  → buildRenderSlide + 字体度量 + 媒体解析
  → 浏览器字体加载 / measureText 回传 → 必要时重新 buildRenderSlide
  → RenderSlide[] 经 IPC 返回
  → React / Konva 静态绘制
  → SlideShowView + AnimatedSlide + ShowMediaLayer
```

重点代码：

- `packages/pptx-engine/src/index.ts`：`openPptx`、`materializeSlide`、母版/布局继承、主题等。
- `packages/pptx-render/src/build-slide.ts`：`buildRenderSlide`、坐标、文本排版、图表和形状树。
- [session-state.ts:406](/Applications/work/genoffice/repo/apps/slides/src/main/session-state.ts:406)：`buildAllRenderSlides`；其文件顶层仍导入 Electron，需把渲染、媒体函数拆到独立模块。
- [session-state.ts:474](/Applications/work/genoffice/repo/apps/slides/src/main/session-state.ts:474)：`makeMediaResolver`，包含 TIFF 转 PNG、JPEG EXIF 方向处理、Office SVG 主题重着色；不能丢掉这些兼容逻辑。
- `apps/slides/src/renderer/NodeBody.tsx`：`StaticNode` 静态渲染；`SlideThumb.tsx` 可复用作缩略图/静态页面。编辑态 `SlideCanvas.tsx` 不作为只读页面的主入口。
- `apps/slides/src/renderer/components/SlideShowView.tsx`：键盘翻页、跳页、隐藏页、黑白屏、动画步骤、切换效果。
- `apps/slides/src/renderer/components/AnimatedSlide.tsx` 和 `animation-play.ts`：动画分组、时间线、逐段文字、运动路径、媒体命令。
- `apps/slides/src/renderer/components/MorphStage.tsx`：Morph 的项目实现；属于现有支持范围，不能推断为全部 PowerPoint Morph 行为。
- `apps/slides/src/renderer/components/ShowMediaLayer.tsx`：DOM `<video>/<audio>` 叠加播放，数据来自 `getMediaData`。
- `apps/slides/src/main/slides-main.ts:4154`：把 OOXML 动画的 shape id 映射为 RenderNode 的 `sourceId`。原始 `getSlideAnimations()` 返回值不能直接代替现有 IPC 的动画结果。

动画、转场、shape keys、元素链接、文本链接不是仅靠 RenderSlide 就能全部恢复。新版协议要同时传这些元数据，并保持同一次解析的 sourceId 一致。沿用原来的画布尺寸、缩放与布局参数；如果改成固定逻辑宽度，必须先通过布局和截图对照，不能以性能优化为由直接改变排版。

#### 必须保留的字宽测量与二次排版

[slides-main.ts:867](/Applications/work/genoffice/repo/apps/slides/src/main/slides-main.ts:867) 先调用 `buildAllRenderSlides`，再调用 `refineComplexWidths(wc)`；获得新测量值后重新构建渲染树。[shaped-metrics.ts:281](/Applications/work/genoffice/repo/apps/slides/src/main/shaped-metrics.ts:281) 通过 `webContents.executeJavaScript` 在 renderer 加载实际字体、以 100px 字号执行 Canvas `measureText`，把结果回填字体度量缓存。这是原排版算法的一部分，不能仅把 IPC 返回值改成 GET RenderSlide 就省略。

Web 端按下面的闭环移植：

1. Node 创建该浏览器的 `viewSessionId`，保留已解析文档、字体集合、原布局宽度和 `renderRevision`；第一遍布局记录待测量项。
2. 返回字体清单、字体资源以及服务端生成的 `measurementBatchId`。每项包含 `key`、`text`、`family`、`bold`、`italic`；测量字号、fallback 字体栈和合成字重/斜体规则沿用原实现。
3. 浏览器加载并注册对应 FontFace，沿用原来的可用性判断和测量函数。不能只依靠 `document.fonts.check()`，原代码已经说明未知字体也可能返回 true。未加载的私有字体返回待重试状态。
4. 浏览器提交已知测量 key 的有限非负字宽；Node 校验 batch、session 和 revision，回填同一任务的缓存，再调用原渲染树构建函数。继续使用同一份解析对象，不重新解析造成 `sourceId` 改变。
5. 返回更新后的 `renderRevision`、受影响页面及待测量状态；前端按 revision 更新页面和缩略图。字体失败、超时或未测量项不能被标记为“已验证一致”，显示原项目对应的 fallback 并报告准备状态，字体就绪后按原重试机制继续。

`gtCache` / `gtPending` 原来是进程全局变量。迁入多用户 Node 服务后，先用每个 view session 独立工作进程隔离，保持原 key 和算法；之后才考虑带字体 hash、浏览器环境标识和 session scope 的缓存重构。不同浏览器或不同字体集合的测量结果不能互相复用。上述 POST 只更新派生布局状态，不允许修改原文件内容。

### DOCX：解析可复用，分页需要浏览器布局

现有文档不是“Node 生成最终分页 HTML → 浏览器直接展示”。`apps/docs/src/main/byte-handoff.ts` 提供文档字节 URL；`renderer/file-actions.ts` 加载字节；`parse-off-thread.ts` / `parse-worker.ts` 在浏览器 Worker 中解析；Tiptap 的自定义节点负责显示，随后测量 DOM、计算分页。

相关模块：`packages/docx-engine`、`renderer/pagination-*.ts`、`components/PaginationPreview.tsx`、自定义节点和页眉页脚组件。`PaginationPreview` 会依赖 `EditorView`、节点 DOM、注释/修订和字体度量，不能单独拷贝即用。

唯一采用的路线是沿用 `parseDocxOffThread`、现有自定义节点、DOM/CSS 和分页流程。保留内部 Tiptap/ProseMirror 视图，关闭用户输入、粘贴、拖拽修改、编辑菜单、保存和 AI，展示层仍使用原节点及相关布局插件。

已有 `App.tsx` 的 `editor.setEditable(!readMode && !isProtected)` 可作为只读控制的参考，但不能直接启用所有阅读模式样式：需要选择明确的原项目视图基线，保持对应的页面宽度、边距、缩放和修订显示设置。拆组件时保留分页所依赖的 node view 与 DOM，不能用简化 HTML 重建。

`ParsedDoc` 内含内部原始字节、Map、嵌入字体等。首版沿用浏览器 Worker 和原来的 transferable buffer 流程；Node 只通过 HTTP 提供文档字节和资源。如果将来改变解析位置，要另行定义完整 DTO 并验证一致性。

#### HTML/MHT altChunk：使用原转换器和已有 Playwright 驱动

`parse-worker.ts` 对 HTML/MHT altChunk 有回退分支。[docs-main.ts:4334](/Applications/work/genoffice/repo/apps/docs/src/main/docs-main.ts:4334) 会把 HTML 写入带 UTF-8 BOM 的临时文件，调用 `convertHtmlToDocx` 和 ElectronBrowserDriver，并传入 `naturalTableWidth: true`。转换得到的 DOCX 仅用来生成展示 blocks，不改写上传的原文档。

该转换器不只读取 DOM。[BrowserDriver](/Applications/work/genoffice/repo/packages/html2docx/src/driver.ts:27) 还要求页面截图和元素截图，`convert.ts` 用它们处理无法直接转成原生节点的内容。因此普通浏览器 DOM 不是本方案中已证明可用的替代实现。

采用仓库已有的 [PlaywrightDriver](/Applications/work/genoffice/repo/packages/html2docx/src/drivers/playwright.ts:34)，由 Node 管理固定版本 Chrome/Chromium；每次转换创建独立 BrowserContext，沿用原 converter、输入 BOM、viewport/缩放、字体、等待规则、选项、输出解析和失败行为。两种 driver 的导航与截图细节仍须对照测试，不能因为接口相同就声明渲染一致。

浏览器解析遇到该分支时，通过文件/view session 绑定的转换请求发送原转换链路解码后的 HTML；Node 返回转换 DOCX 的二进制字节或任务结果。前端安装原 `setAltChunkHtmlConverter` 回调并沿用原回退解析。服务端沿用原输入大小限制和 watchdog，超时或取消时关闭 context，清理临时目录；浏览器异常时由 worker 管理器终止并恢复。结果缓存包含 HTML hash、converter 版本、Chromium/字体环境及转换参数。

**完整支持原项目的 HTML/MHT altChunk 展示时，独立 Chromium 是明确的部署依赖。** 不需要 Electron，也不使用 LibreOffice。部署缺少 Chromium 时不能宣称该类文件已完整还原；错误状态应明确指出转换不可用，不能静默跳过正文。

### XLSX：Node 可以管理现有 Rust sidecar

`apps/sheets/src/main/xlsx-sidecar-client.ts` 的 `XlsxSidecarClient` 仅使用 Node 的 `spawn`、`readline`，用 JSON 行协议调用 `xlsx-sidecar`，没有 Electron import。它支持 open、read_range、read_media、close 等，适合移入服务端工作进程。

前端 `apps/sheets/src/renderer/App.tsx` 使用 Univer；`create-univer.ts` 只组装开源 preset，并主动避开专有 Pro 依赖。复用数据适配、`univer-sync.ts` 的相关渲染部分及图表/图片/条件格式展示，重建一个小的只读 Viewer，不整体搬运巨大的编辑器 App。

官方和本地安装的 Univer 0.25.1 类型均提供 `getWorkbookPermission().setReadOnly()`。仍要关闭编辑菜单、插入/删除工作表、粘贴和改值命令，后端不开放文档修改 API；原重算读取属于派生展示计算。[官方只读 API](https://docs.univer.ai/reference/facade/workbook-permission)

当前提交增加了 `single-thread` / WASM 无线程路径，但源码仍是 Rust stdio 服务，没有现成浏览器 JS 绑定与虚拟文件系统适配；“能向 WASM 编译”不等于“已有可用的纯浏览器 XLSX SDK”。首版不依赖这条路线。

文件打开、公式缓存/重算时机、值格式化、locale、日期显示、样式和图表适配全部沿用项目现有流程。不能为了只读预览擅自改为“只显示缓存值”，也不能换用另一套公式引擎。大表继续按范围读取、懒加载；不能一次把整本工作簿变成大 JSON。

保留 `xlsx-sidecar`、Univer 的精确依赖版本和展示配置，包括项目对样式优先级、locale、条件格式、图表及图片的修正。只读权限不能改变文件内容对应的显示结果。

### PDF / Markdown / HTML

- **PDF：基础页面较容易，完整展示还要抽取表单层。** `apps/pdf/src/renderer/PdfPage.tsx` 使用 PDF.js、Canvas、TextLayer 和 IntersectionObserver，适合浏览器。把本地 readFile 改为受控 HTTP URL；保留页码、缩放、旋转、搜索、缩略图、原加载选项和表单/链接展示层；移除 PDFium 编辑、签名写入、OCR 和 AI 路径。PDF.js 官方有 URL 加载及 Canvas 展示示例。[官方示例](https://mozilla.github.io/pdf.js/examples/)
- **Markdown：中成本。** 复用 `editor/extensions.ts` 的解析与展示配置、`CodeBlockView.tsx`、`math.ts`、`diagrams.ts`、`markdownStyleRenderers.ts` 及原 CSS，保留项目支持的代码/表格/公式/Mermaid/WaveDrom 等节点渲染。保留内部只读 Tiptap，关闭编辑交互和 AI；node view 中的编辑控件与展示逻辑要分别处理。文内相对图片统一映射到资源 URL，保持原资源解析语义。
- **HTML：低到中成本。** `PresentView.tsx` / `preview/PreviewFrame.tsx` 已有 iframe 展示。把 `html-preview://` / `html-asset://` 协议换成 HTTP；去掉 inspector、源码编辑和生成流程。保持隔离 origin 和 sandbox；对需要脚本的演示页允许脚本，但不要授予 Viewer 同源访问权限。HTML 及资源不能直接运行在应用主页面里。

#### PDF 的只读表单展示边界

[PdfPage.tsx:100](/Applications/work/genoffice/repo/apps/pdf/src/renderer/PdfPage.tsx:100) 使用 `AnnotationMode.ENABLE_FORMS`，有意不在页面位图中绘制 widget appearance，以避免和 HTML 表单层重复绘制。只移植 Canvas/TextLayer 会导致已填写文本、勾选框或其他表单内容缺失。

必须连同 `form-catalog.ts` 的 `buildFormCatalog`、[FormLayer](/Applications/work/genoffice/repo/apps/pdf/src/renderer/FormLayer.tsx:22)、原 widget CSS、字段值/选项解析和页面坐标转换一起复用。以 `readOnly` 禁止输入，移除表单写回与 `onEdit`/签署操作；保留字段值、选中状态、签名字段原有展示及 `LinkLayer` 的导航。只读控件的 disabled 样式也须和选定的原项目只读基线对照，不自行调整颜色或几何。

`App.tsx` 加载文件时还调用 `listStaticFormFills`。对仍参与展示的已保存内容，保留相应只读 metadata 读取；不能根据“form”或“signature”名称把展示依赖和写入功能一起删除。表单 catalog 可继续由浏览器 PDF.js 建立，服务端无需重复实现。保留 `view-config.ts` 的 `DOC_OPTS`，同版本部署 worker、cmaps、standard_fonts 和 wasm。

验收新增：已填写文本、checkbox/radio、choice 字段及签名字段；对照原程序 widget 位置、值、字体和页面旋转后的坐标，确认不漏绘、不重复绘制、不允许写回。

#### HTML/Markdown 的文档与外部资源导入

原项目的 [Markdown 资源处理](/Applications/work/genoffice/repo/apps/markdown/src/main/markdown-main.ts:692) 和 [HTML 资源处理](/Applications/work/genoffice/repo/apps/html/src/main/html-main.ts:1220) 从打开文档的目录读取图片、CSS、JS、字体及无扩展名资源。浏览器单独上传 `.html/.md` 不会自动带上这些文件，只有 URL 替换无法还原显示。

首版采用**文档资源包导入**：用户上传 ZIP 或选取目录，服务端建立 package manifest，保留相对路径、文件内容 hash、MIME 及入口文档；支持同一个包内选择多个入口。独立上传仍适用于 OOXML/PDF，以及确实没有本地依赖的 HTML/Markdown。资源包 ZIP 是导入容器，不改变内部文件的解析与渲染算法。

还可接入服务端受控文件目录：前端发送已授权的目录/文档 ID，Node 在配置好的根目录解析入口及资源。该模式不接受浏览器任意绝对路径，也不假设服务端能读取用户电脑上的文件。

例：入口 `demo/index.html` 与 `demo/css/site.css`、`demo/images/a.png` 一起导入；`css/site.css`、CSS 内的 `../images/a.png` 都必须仍以原资源位置解析。不能把文件全部重命名后只改 HTML 的 img src。

资源映射使用稳定的路径 URL，例如独立预览 origin 的 `/packages/:packageId/files/demo/index.html`；单个资源 hash ID 可用于存储，但展示 URL 必须提供原相对路径语义。沿用 `buildPreviewDocument`：作者已有 `<base>` 时保持它，未声明时指向导入文档目录；Markdown 沿用原 image resolver，仅将本地资源访问适配为该路径服务。URL 编码、查询/fragment、CSS url()/@import、脚本/module、字体与无扩展名 MIME 按原处理逻辑验证。

文件访问仍按原文档目录边界和已授权 manifest 约束；拒绝 ZIP 路径逃逸、重复规范化路径和越界资源，不通过开放任意目录解决资源缺失。沙箱 iframe 的字体、module/fetch 等跨源请求，需要独立资源 origin 的匹配 CORS 和授权策略，不能为方便资源加载添加 `allow-same-origin`。

导入结果返回缺失本地依赖诊断，动态脚本请求的资源通过预览网络诊断补充；包未收齐时不能标记为完整还原。验收覆盖相对图片、CSS 嵌套引用、JS、字体、作者 `<base>`、无扩展名资源和目录层级。

## 推荐目标架构

```text
浏览器：React + TypeScript + Vite
  ├─ ViewerShell：打开/列表/加载状态/格式路由
  ├─ SlidesViewer：Konva + 缩略图 + 放映 + 动画 + video/audio
  ├─ PdfViewer：原 PDF.js 页面、文字层、表单/链接层和缩略图
  ├─ DocsViewer：原 DOCX Worker / Tiptap 节点 / DOM 分页
  ├─ SheetsViewer：Univer 只读 + 按范围加载
  ├─ MarkdownViewer：原 Markdown/Tiptap 节点与样式
  └─ HtmlViewer：隔离 iframe
                 │ HTTP（含 PPT 字宽回传），首版无需编辑协作 WebSocket
Node.js API / 工作进程
  ├─ 文件/资源包导入、文件 ID、类型检测、权限、任务状态
  ├─ PPTX：解析、主题/母版继承、字体测量闭环、排版、播放元数据
  ├─ XLSX：Rust sidecar open/read_range/read_media/close
  ├─ DOCX / Markdown：提供原文件及资源，保留浏览器解析路径
  ├─ DOCX altChunk：原 html2docx + PlaywrightDriver + 固定版 Chromium
  └─ 资源服务：图片、音视频、字体、原始文件、派生产物
                 │
文件存储 + 派生缓存 + 有界工作队列
```

建议目录（新增，而非已有）：

```text
apps/viewer-server/src/{routes,workers,storage}
apps/viewer-web/src/{viewers,components,services}
packages/viewer-contracts       # 展示 DTO、文件/任务/资源协议
packages/slides-viewer          # 抽取静态渲染、动画和放映
packages/preview-core          # 抽取 Electron 无关的排版/媒体处理
```

后端可选 Fastify 或 Express，移植工作的重点在格式与协议边界，不在 HTTP 框架。前端沿用 React，避免同时进行 Vue/其他框架重写。

## API 与数据边界

拟建 API 至少覆盖以下能力，路由名为建议设计；文件读取、派生布局计算与格式转换分别建模，均不提供原文档编辑/保存接口：

```text
POST /api/files                         上传文件，返回 fileId
POST /api/document-packages             目录/ZIP 资源包和 manifest 导入
GET  /api/document-packages/:id          入口、路径清单、缺失资源诊断
GET  /api/files/:id                      元数据、类型、页/表数量、准备状态
GET  /api/files/:id/content              二进制原文件 URL，支持 Range
POST /api/view-sessions                  为该浏览器创建布局/读取会话
GET  /api/view-sessions/:id/slides       页目录、字体、测量 batch、播放元数据
GET  /api/view-sessions/:id/slides/:index RenderSlide + renderRevision，按页加载
POST /api/view-sessions/:id/text-widths  提交 batch/revision/key 对应的实测字宽
DELETE /api/view-sessions/:id            释放文档、度量缓存和原生会话
GET  /api/files/:id/assets/:assetId      图片/音视频/字体
GET  /api/files/:id/pdf-display-metadata 保留仍被展示依赖的 PDF 只读 metadata
GET  /api/files/:id/workbook             工作簿和 sheet 元数据
GET  /api/files/:id/sheets/:sheetId/range 单元格/样式范围
POST /api/view-sessions/:id/recalc       按原流程读取重算结果，不接收用户编辑
POST /api/view-sessions/:id/altchunks    原 html2docx 转换，返回二进制或 jobId
GET  /api/jobs/:jobId                    解析/转换状态
GET  /api/jobs/:jobId/result             转换产物二进制字节

独立预览/资源 origin：
GET /packages/:packageId/files/*         保留目录结构和 base 语义的预览/资源
```

拆出 `ViewerDataSource`，组件接收 props 或注入只读服务；把现有 `window.slidesApi` 的读操作转换为 HTTP 客户端或已加载元数据查询。临时 bridge shim 可用于验证，但正式代码不模拟整套 Electron API。任何编辑、保存、AI 请求都不出现在服务端能力中。

`text-widths` 请求必须携带服务端下发的 batch ID、renderRevision 和测量 key；拒绝过期 revision、未下发 key、NaN/Infinity 和未知 session，重复提交按 batch 幂等处理。字体/布局变化使旧 batch 失效；只返回允许的派生数据，不执行客户端传入的 JavaScript。原来按 `webContents.id` 隔离的 XLSX 会话也绑定到 view session，源文件相同不意味着共享可变 engine 状态；recalc 由服务端依据原读取流程组装空编辑请求，不向客户端开放任意 cell ops。

播放协议应包含：页面尺寸和隐藏页、RenderSlide、动画步骤、转场、shape keys、元素/文字链接、媒体索引、字体索引；按需要另加 notes 和自动翻页参数。现有 `SlideShowView` 未见消费每页 `advTm` 的自动翻页逻辑，不能直接声称已具备定时自动轮播，若需要须明确实现。

## 必须改的运行时细节

1. **文件/会话 ID。** 本地路径和 `webContents.id` 改为 fileId 与服务端会话 ID；本地文件读取权限不等于上传后的访问权限。资源路由校验文件归属，不能把客户端 path 传给 readFile。
2. **图片、媒体。** 初次小文件验证可沿用 data URL，正式版外置到资源路由，并支持音视频 Range。保留媒体 MIME sniff、TIFF 转码、JPEG 方向、SVG 主题处理、EMF/WMF rasterization。原 image loader 用 MIME data URL 识别 EMF/WMF，换成 HTTP URL后要同步改判别逻辑；图像 DPI/tile 布局也要保留元数据，不能只替换 URL 字段。
3. **字体。** `main/fonts.ts`、`shaped-metrics.ts` 有 OS 字体路径、`?asset` 和 HarfBuzz WASM 加载；迁移后明确字体目录和资产路径。服务端用于排版的字体文件，前端必须通过 FontFace 加载对应字体再绘制，否则换行、位置和动画文本会漂移。不能默认把本机 Office 私有字体分发给客户端。嵌入字体注册目前是进程全局状态，多文档相同 family 不同字体时要按任务隔离或独立工作进程。
4. **全屏。** 删除 Electron simpleFullScreen/窗口最大化/cover bleed 分支，统一浏览器 Fullscreen API；从用户“开始放映”点击直接申请全屏，失败时保持窗口内放映，处理 `fullscreenchange`。浏览器需要瞬时用户激活，不能照搬 mount 后 IPC 等待的进入方式。[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen)
5. **媒体播放。** `play()` 可能因浏览器自动播放策略失败，处理 Promise 和用户手动播放。切页、退出必须停止媒体；codec 支持按目标浏览器验证，必要时在资源工作进程转码。[MDN 自动播放说明](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
6. **双屏。** 如果需要 Presenter，改为用户点击打开新窗口、同源 BroadcastChannel/postMessage 同步；不能承诺 Electron 的指定显示器、强制定位/全屏行为。基础单窗口放映先上线。
7. **任务与缓存。** 大文件解析、转码、字体度量放入有界 worker 池；缓存键包含文件 hash、解析/渲染版本、字体集及逻辑画布配置。原生引擎会话及时 close。加入上传和解压额度，继续复用 zip-gate，防止一个文件耗尽整个服务。
8. **构建。** 普通 Vite 前端 + 独立 Node TypeScript 构建；修正资源 import，打包 worker/WASM/PDF.js 资产。Web 发布应使用独立 workspace 依赖闭包，移除 Electron 自动安装、electron-vite、electron-builder 和桌面打包流程；`dev:renderer` 现有脚本只可作为起点。

## 去掉与保留的范围

去掉产品和服务路径中的 AI panel、provider、AI 搜索、agent IPC、编辑器工具栏、撤销/重做、文件写回、自动保存、文档生成、桌面菜单/更新/系统文件关联/本地索引，以及 PPT 编辑专用的选中、拖拽、调整大小和文本编辑 overlay。

保留解析、主题/继承、排版、资源兼容、图表绘制、只读文本搜索/复制、缩放/翻页、播放逻辑，以及真正被展示组件引用的 UI/i18n。`agent-core` 暂不能按包名全部删除：PPTX engine 的 `redaction-xml.ts` 还引用其 `redact-range` 常量。可以先保留这个不运行 AI 的底层子路径，再把公共格式标记抽到无 AI 的小模块。

原项目 CLI 不作为无 Electron 渲染服务直接复用：README 明确 `render/convert to PDF/create_pdf` 仍启动隐藏 GenOffice；`packages/cli/src/commands/render.ts` 的非 PDF 链路也是 headless-export。服务器缩略图可另用独立 Chromium/Playwright 打开新 Viewer 截图。即使不生成缩略图，完整支持 DOCX HTML/MHT altChunk 也需要原 html2docx 的截图能力，本方案为此部署已有 PlaywrightDriver 和独立 Chromium。常规页面绘制仍在用户浏览器；Chromium 转换工作进程是展示依赖，不提供文档编辑能力。

## 实施顺序与粗估

以下是工程判断，假定一名熟悉 React/TypeScript 的开发者、复用现有能力、桌面 Chrome/Edge 优先，不含生产级多租户认证、旧格式、全量 Office 等价、手机优化和双屏。没有用完成率或基准数据作保证。

- **阶段 0：验证门槛，完成后重新估工期。** 除普通 PPT/PDF 外，先做复杂文字 PPT 的字体加载→测量回传→二次排版、已填写 PDF 表单、HTML/Markdown 资源包、DOCX HTML/MHT altChunk 的 Electron/Playwright 对照。每条都用包含对应特性的文件验证；不能用一页普通 PPT 替代这四个探针。
- **阶段 1：3–5 人日的原基础估计待重估。** 新 Web/API workspace、文件 ID、PDF.js 基础 Viewer；新增资源包导入、路径语义、会话及表单层需在阶段 0 后计入。
- **阶段 2：6–10 人日。** PPT 缩略图、翻页、全屏；抽取动画和转场；媒体、链接、隐藏页、异常/加载处理。
- **阶段 3：3–5 人日。** 抽取原 Markdown 节点和 HTML 预览，保持原样式及资源语义。
- **阶段 4：5–8 人日。** Rust sidecar 接入、只读 Univer、范围读取、样式/图表/图片适配。
- **阶段 5：原估约 10–18 人日，待转换探针重估。** 抽取原 DOCX Worker、只读节点视图、DOM 分页、页眉页脚、修订显示和字体资源；接入 html2docx/PlaywrightDriver 与 Chromium 任务池，不改变渲染算法。
- **阶段 6：基础验收 5–8 人日。** 原 Electron 与 Web 的真实文件截图/交互对照、缓存及资源释放、部署和依赖裁剪。差异修复工期在首轮对照后评估。

先前的 PPTX/PDF **2–4 周**、六格式 **7–12 周** 仅保留为审查前的初步范围，不作为补充四条链路后的排期依据。阶段 0 跑通字体闭环、表单层、资源包及 altChunk 驱动对照后，再按实际抽取边界、部署依赖和视觉差异重新估算。无人值守自动放映、复杂媒体转码、双屏另外估算。

## 验证记录与下一步验收

已执行（普通 Node v25.5.0，`process.versions.electron` 为 null）：

- `01_standard_business.pptx`：5 页、11 个 RenderNode，解析/惰性页物化/渲染树/播放元数据/JSON round trip 成功，序列化 26,808 bytes。
- `05_unicode_cjk_emoji.pptx`：1 页、2 个 RenderNode，同样成功，序列化 6,697 bytes。
- `simple.docx`：4 个 block，`kitchen-sink.docx`：12 个 block，Node 解析成功。
- 现有 `build-slide`、`animation-play`、`show-keys`、`custom-show-rehearse` 四个测试文件：**87/87 通过**。

可复跑探针：[engine-probe.mts](/Applications/work/genoffice/research/engine-probe.mts)。在仓库执行 `./node_modules/.bin/tsx ../research/engine-probe.mts`。相关测试命令：

```sh
./node_modules/.bin/vitest run packages/pptx-render/tests/build-slide.test.ts apps/slides/tests/animation-play.test.ts apps/slides/tests/show-keys.test.ts apps/slides/tests/custom-show-rehearse.test.ts --reporter=dot
```

这些验证证明核心逻辑可脱离 Electron，不证明已经完成 Web 迁移或渲染一致性验证。PPT 探针使用启发式字体、未接入 media resolver，不能作为最终排版结果；没有浏览器截图或实际音视频/全屏测试；没有运行 Rust sidecar。

本次审查补充只完成源码核对和方案修订：浏览器字宽 HTTP 回传、只读 PDF 表单抽取、资源包导入以及 altChunk 的 Electron/Playwright 对照均未实现或执行。保留上述已执行记录，不把新协议、已有驱动或计划测试写成已验证能力。

实施时应至少覆盖约 20–30 个实际文件：PPT 中英文/嵌入字体、母版、表格图表、EMF/WMF/TIFF、图片裁剪、动画/转场/运动路径、视频/音频、跳页；Word 多栏/浮动对象/分页/页眉脚；Excel 大表/多 sheet/公式缓存/合并单元格/图表/条件格式；PDF 大文件/文字搜索；HTML 相对资源与脚本。

验收必须分别检查静态外观与放映交互：开始放映、逐步推进、返回/跳页、页面切换、媒体停止/继续、加载失败、字体就绪、全屏进入退出，以及服务端并发任务和释放。项目本来支持的动画、对象或媒体在 Web 端失效，按迁移缺陷处理；原项目不支持的内容保留原行为，不另加静态转换作为达标替代。

### 渲染一致性验收基线

固定原 commit、依赖版本、字体文件及 hash、locale、主题、文档显示选项、viewport、缩放和 DPR。使用同一组文件，分别在原 Electron 与 Web 截取文档内容区域，避免应用工具栏尺寸变化影响比较。

- PPT 比较 RenderSlide/动画元数据、形状和字形坐标、图表/媒体位置及关键动画帧，并测试推进顺序与媒体事件。
- DOCX 比较页数、分段/分行断点、表格跨页、分栏、浮动对象、页眉页脚、脚注与修订显示。
- XLSX 比较范围数据、格式化文字、行高列宽、合并单元格、条件格式、图表/图片及打开后计算状态。
- PDF / Markdown / HTML 比较页面或节点结构、文字层、样式、资源及动态页面展示。

四项新增的验收门槛：

1. **PPT 测量闭环：** 同字体/环境下比较原 executeJavaScript 测量和 Web 回传的字宽、二次 RenderSlide、换行及字形位置；覆盖阿拉伯文/泰文和私有/嵌入字体。另测字体加载失败、旧 batch、session 释放和两个不同字体环境的缓存隔离。
2. **PDF 表单：** 已填写文本、checkbox/radio/choice 和签名字段在原只读视图与 Web 中可见且只绘制一次；缩放/旋转坐标一致，输入/签署/保存不会改变文档。
3. **外部资源：** 同一 HTML/Markdown 与其目录资源整体导入，图片/CSS/JS/字体及嵌套路径正常；原 `<base>` 保留，缺失和越界资源有明确诊断。复用原 MIME 与路径处理测试并增加 HTTP 执行入口。
4. **altChunk 驱动：** 同 HTML/MHT 输入分别通过原 ElectronBrowserDriver 与 PlaywrightDriver 转换后比较规范化展示 blocks、图片、分页/截图；覆盖需要元素截图的内容及宽表格。不能仅比较 DOCX ZIP 字节，因为打包标识和元数据可能不同。验证超时清理、转换取消和 Chromium 缺失状态。

同一渲染算法是必要条件，字体或 Chromium 版本差异仍可能造成像素偏差。首轮优先固定相近 Chromium 内核、同一 OS/字体环境；截图差分中任何宽高、换行、分页或位置变化均视为失败，字形抗锯齿差异单独归因，不能用宽松全图阈值掩盖布局问题。声明一致性必须有这些对照结果。

复用项目已有的 `e2e/docs-visual.spec.ts` 和 `e2e/visual-baselines` 作为 Word 对照起点，再补充 Web 执行入口与其余格式的基线。本次修订只检查了相关源码，没有执行 Electron/Web 对照测试。

## 建议决策

开始一个 **PPTX + PDF 的 Web Viewer 切片**：沿用原 React/Konva/PDF.js、字体度量与资源处理，用 Node 替换 Electron 的服务宿主；先与原程序做对照，验收通过后抽取原 DOCX、XLSX、Markdown、HTML 渲染链路。整个迁移坚持原项目的解析、排版、绘制和播放方式，只改变宿主/通信与编辑权限。

进入正式开发前先完成阶段 0 的四条验证。部署清单明确 Node、原 Rust sidecar、固定版本 Chromium/PlaywrightDriver、匹配的字体文件及 PDF.js 静态资产；同一渲染算法是否达到还原要求，以对照结果为准。

源仓库与范围核对：[WD-CHINA/genoffice](https://github.com/WD-CHINA/genoffice)。上述实现判断以本地指定 commit 的源码与验证为准，而不是 README 的产品宣传。
