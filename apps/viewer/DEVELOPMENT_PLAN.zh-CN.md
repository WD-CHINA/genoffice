> 开发边界已按用户最新要求修订：只允许改动本 app 和新增的 Viewer 包。以下里程碑为完整目标；实际交付状态见 IMPLEMENTATION_STATUS.md。

# 独立 Web Viewer 开发计划：PPTX / PDF / DOCX

日期：2026-10-13。源码基线：`4863835963c99793c47b72473900c483e9fa0c2a`。
依据：[移植调研与审查补充](/Applications/work/genoffice/repo/docs/web-viewer-migration.zh-CN.md)。
状态：**设计与待开发任务，不是已实现的应用。** 本文件中的目录、包、API 和启动命令除明确列出的现有源码外均为拟建项。

## 1. 产品范围与完成标准

在 `repo/apps/viewer` 新增一个 npm workspace，包名拟为 `@genoffice/viewer`。一个 app 内含 Node 服务与 React Web 页面，独立启动、构建和发布；复用共享包，不需要启动 Docs、Slides、PDF、HTML 或 Shell 等其他应用。

首期按 **PPTX → PDF → DOCX** 交付；三个格式共用文件上传、资源、会话、状态和只读操作栏：

- PPT：`.pptx` 缩略图、静态预览、缩放、翻页/跳页、全屏放映、现有动画/转场、隐藏页规则、超链接和嵌入音视频。
- PDF：`.pdf` 原页面/文字层、缩略图、翻页、缩放、旋转、搜索/复制、链接及已填写表单/签名字段的原展示。
- Word：`.docx` 原自定义节点、分页、页眉页脚、分栏、表格、浮动对象、图片、公式、脚注/尾注、原修订/批注显示和只读搜索；包含项目已支持的 HTML/MHT altChunk 展示。
- 原读取链路已支持的 PDF 密码与 DOCX 解密保留；密码仅供当前读取会话，不保留加密/重加密或密码修改功能。PPTX 对加密或不支持的容器沿用原打开限制，不能自行声明支持。

本期不提供编辑、保存写回、插入/删除、批注新增、表单填写/签署、AI、桌面菜单和系统文件关联。Tiptap 保留为 DOCX 底层只读展示依赖。旧二进制 `.ppt/.doc`、XLSX、独立 HTML/Markdown Viewer、双屏 Presenter、自动定时轮播、Office 格式导出和账号管理留给后续范围。

**还原对象为原 GenOffice 的显示/播放行为。** 保留原解析器、字体度量、渲染算法、节点 DOM 与 CSS；禁止整份 Word/PPT 转 PDF、图片或换渲染库作为达标捷径。仅改宿主、文件/资源访问、通信和编辑权限。

第一版同一 Viewer 页面只展示一个活动文档，切换时销毁旧的 preview iframe 和 view session；不在同一个 document 中挂多个格式的全局 CSS/FontFace。不同浏览器页面可以独立打开文件，各自持有隔离会话。

## 2. 一个 app 的目录和启动模型

```text
apps/viewer/
  package.json                 @genoffice/viewer，单个 workspace
  README.md
  DEVELOPMENT_PLAN.zh-CN.md
  vite.config.ts               仅 Web 构建，无 electron-vite
  build.server.mjs             Node 主程序/worker 打包及资产复制
  tsconfig.{web,server}.json
  vitest.config.ts
  playwright.config.ts         浏览器测试，独立于原 Electron e2e 配置
  src/
    web/
      index.html
      host/                    文件打开、状态、ViewerShell
      preview/                 受信 iframe 入口，按格式挂载原渲染组件
      services/                只读 HTTP client、字体与测量 adapter
      styles/                  原内容样式及独立操作栏 tokens
    server/
      index.ts                 API + 生产静态文件服务
      routes/                  files / sessions / slides / jobs / assets
      storage/                 上传文件、派生缓存、资源索引
      workers/                 PPT 排版隔离、DOCX 打开预处理、altChunk 转换
      lifecycle/               会话 TTL、任务取消、清理
    contracts/                 app 装配和配置类型
  tests/{api,lifecycle,boundaries}/
  e2e/{pptx,pdf,docx,fixtures,baselines}/
  scripts/                     dev、基线采集、独立产物生成
  dist/
    server/                    可直接由 Node 运行的 JS
    web/                       HTML / CSS / JS / module workers
    assets/                    字体、HarfBuzz wasm、PDF.js 数据
    runtime-package.json       生成独立产物时改名为 package.json
```

开发时由该 workspace 的 `dev` 一次启动 API 和 Vite，建议 API 端口 `3001`、Web 端口 `5180`，均可配置；Vite 代理 API/资源到 Node，客户端使用相对 URL。生产环境由 Node 在一个端口提供 Web 页面、API 和受控资源，不需要其他 app 进程或 Vite。

预览 iframe 加载的是本应用编译出的受信入口，不是用户上传 HTML。它隔离原组件的全局 CSS、模块级状态、FontFace 和 Worker；允许本应用 Worker/同源 API，按需要授予 fullscreen。父页面与 iframe 只交换受校验的生命周期/导航消息，浏览器全屏仍由用户点击触发。DOCX altChunk 的不受信 HTML只在独立转换 BrowserContext 中运行。

## 3. 共享代码抽取与依赖边界

按最新范围约束，仅在新增 Viewer 自有包中保存原渲染源码快照和宿主适配，现有 Electron app、packages、根配置及锁文件均不修改。现有 app 继续引用原文件；Viewer 只读复用已有纯引擎。核心渲染算法和字体资产保持原实现，并通过源码一致性检查及视觉基线验收防止漂移。

Viewer 自有包及契约位置：

```text
apps/viewer/src/contracts/    fileId、viewSession、状态、测量/资源/播放 DTO（待完善）
packages/viewer-renderers/    浏览器组件；明确导出 ./pptx、./pdf、./docx、./ui
packages/viewer-services/     Node 服务逻辑；明确导出 ./pptx、./docx、./pdf
```

- 浏览器包：原静态节点、放映、PDF 页面/表单、DOCX 节点与分页；子路径独立构建，不通过总入口把三格式及编辑功能全部加载。
- Node 包：原字体/媒体兼容、PPT 排版、DOCX 读取预处理/解密/lazy media、altChunk adapter，以及 PDF 展示仍使用的只读 metadata。
- contracts：无 DOM、Node、Electron 和 AI 运行时 import；只定义协议和纯校验。
- 继续复用原 `pptx-engine`、`pptx-render`、`docx-engine`、`zip-gate`、`font-metrics`、`html2docx` 和 i18n 中需要的纯代码。
- `viewer-renderers/ui` 复用原 Dropdown、FindPanel、图标、tokens 和字体资产的具体实现。现有 `@genoffice/ui` 主入口导出 AI 组件，且 package dependencies 包含 `ai-provider`；不能直接沿用其总入口并声称独立产物没有 AI。抽取无 AI 子模块/资产入口，保持原内容样式及字体字节不变。
- `pptx-engine` 仍引用 `agent-core/redact-range` 格式标记常量；优先把这类纯格式常量迁到无 AI 的小模块，或仅内联该纯子路径。禁止带入 agent loop/provider/IPC。
- 为 `html2docx` 增加明确的 `./playwright-driver` 服务端导出；已有文件没有从主入口导出，不能长期由 Viewer 跨目录引用源码。

独立性检查按依赖图和产物执行，不只检查代码中有没有单词 Electron：

1. Viewer 与新共享包不得 import `apps/{docs,slides,pdf,html,sheets,markdown,shell}/**`，包括 type-only 跨 app import；真正需要的 IPC 类型移入 contracts。
2. 发布入口和 worker 的完整 import graph 不含 `electron`、`electron-vite`、`electron-builder`、`electron-utils`、AI provider/agent 运行时。
3. 不调用原根 `dev` / `build:all` / `shell` / headless-export；启动日志和进程列表中没有 Electron。
4. 开发提取阶段仍构建原应用做回归，但它们仅是验证工具，不是 Viewer 的运行依赖。

## 4. 按格式划分的移植任务

### 4.1 PPT：服务端排版与浏览器测量闭环

现有源：`apps/slides/src/main/session-state.ts` 的 build/media helper、`fonts.ts`、`shaped-metrics.ts`；浏览器的 `NodeBody.tsx`、`SlideThumb.tsx`、`konva-adapter.ts`、`image-loader.ts`、`animation-play.ts`、`SlideShowView.tsx`、`AnimatedSlide.tsx`、`MorphStage.tsx`、`ShowMediaLayer.tsx`、相关 CSS 与 i18n。

任务：

- 保留 `openPptx` / `materializeSlide` / `buildRenderSlide` 和主题/母版/布局继承；剥离 Session 的编辑/undo/AI 状态。
- 将 shape id→sourceId、动画、转场、shape keys、元素/文本链接的读取封装成独立函数，DTO 和 RenderSlide 来自同一解析对象。
- 保留系统/嵌入字体解析、HarfBuzz 与原 fallback；明确字体目录，处理原 `?asset` / wasm import。
- 每个 view session 的 PPT 工作进程独立持有 font registry、`gtCache`、`gtPending` 和解析对象；用全局有限 worker 数约束并发。会话结束终止 worker并清理缓存。
- 浏览器先加载原字体、按原 100px 与 fallback 栈 measureText，再回传 batch/revision/key；服务端回填后进行第二遍原排版。不得在未测量完成时将预览标记为一致性通过。
- 保留媒体 sniff、TIFF/JPEG/SVG/EMF/WMF 处理及 DPI/tile 元数据；图片和音视频走带文件/session 归属校验的资源 URL，媒体支持 Range。
- 注入 `SlidesDataSource`，替代 `window.slidesApi` 的读能力；不构造完整虚假的 Electron API。全屏 adapter 替换桌面窗口逻辑，保留原放映键盘/动画顺序与切页媒体停止行为。

验收：普通/CJK/阿拉伯/泰文、私有和嵌入字体、母版、图表/表格、特殊图片、链接、隐藏页、逐步动画/Morph/运动路径、音视频；原与 Web 比较最终 RenderSlide、测量结果、截图和播放状态。

### 4.2 PDF：页面、文字层、表单和链接一起抽取

现有源：`apps/pdf/src/renderer/PdfPage.tsx`、`form-catalog.ts`、`FormLayer.tsx`、`LinkLayer.tsx`、`view-config.ts`、缩略图/搜索/几何相关函数、原 PDF CSS 与 static form fill 读取函数。

任务：

- 保留 PDF.js 精确版本、DOC_OPTS、Canvas 像素预算、TextLayer、可见页懒加载和缩略图策略。
- 保留 `AnnotationMode.ENABLE_FORMS` 与原 FormLayer 配对；catalog 在浏览器建立，已有值/勾选/选项/签名字段按原方式显示，禁用输入及写回。
- 保留 LinkLayer 跳转与链接处理；原密码打开交互继续由 PDF.js 处理，不经持久化日志存储密码。
- 按展示调用链保留 saved static fill/必要 metadata 读取；不能整包导入 pdf-main、image-edit 或签名写入代码。
- 复制同版本 PDF.js worker、cmaps、standard_fonts、wasm 到独立 Web 产物；Range 返回与原字节、Content-Length、取消一致。
- 抽取 zoom、旋转、outline、搜索与复制，不移植编辑面板。旋转是当前视图状态，不改写文件。

验收：普通 PDF、CJK、已填写表单、签名字段、页面旋转、内部/外部链接、密码文件、长文档可见页释放；表单不得漏绘或重复绘制。

### 4.3 Word：完整保留 Worker→节点→DOM→分页

现有源：`apps/docs/src/renderer/file-actions.ts` 的 load 链、`parse-off-thread.ts` / `parse-worker.ts`、`editor/extensions.ts` 及各 node view、`editor/convert.ts`、`line-metrics.ts`、`embedded-fonts.ts`、`pagination-*.ts`、`PaginationPreview.tsx`、页眉页脚/脚注/修订显示、原内容 CSS；main 侧 `lazy-media.ts` / `byte-handoff.ts` / `docx-encryption.ts` 的只读部分。

任务：

- 提取 `loadFile` 的展示初始化：Worker parse、generation guard、字体注册、font table、numbering/styles storage、layout settings、`blocksToPmDoc`、phased content 和文档 CSS。去掉保存/历史/AI副作用，不能只 parse 后 setContent。
- Node 保留打开格式检查、原解密和 lazy media 预处理；加密文件的明文字节与资源按会话保管，关闭时释放。上传零字节/损坏/过大文件沿用原打开判定。
- `genoffice-docx-media://` 适配为 HTTP。为源 hash 与 part path 建立 session 授权映射，保留 slimDocx 占位符和按需读取逻辑；不能将所有 lazy media URL 当作普通 base64 图片。
- 保留模块 Worker 与 transferable bytes，原 worker/main-thread fallback 按调用链适配；内部 Tiptap 不可编辑，关闭粘贴、拖拽改值、编辑命令，保留必要的布局插件。
- 正常分页版式作为初始基线，不使用另一种阅读模式的样式替代；保留节点 DOM/CSS、字体/字距/行距、分栏、浮动对象、分页稳定判断。
- altChunk 沿用 `setAltChunkHtmlConverter` → 原 html2docx → 已有 PlaywrightDriver；BOM、viewport/缩放、naturalTableWidth、字体与元素截图行为需要原 driver 对照。返回转换字节后由原解析器生成展示 blocks。
- 有界 Chromium 转换池，每任务独立 context、watchdog、取消和 finally 清理；字体/worker 资产与生产包一起部署。

验收：原页数、换行、跨页表格、多栏、浮动图片、页眉页脚/页码、脚注尾注、公式、修订/批注、嵌入字体、分阶段大文档、lazy media、密码与 HTML/MHT altChunk。

## 5. 首期协议和生命周期

不开放文档修改接口。上传和派生计算可以使用 POST；“只读”指不修改原文档，不意味着所有请求都必须 GET。

```text
GET    /api/health
POST   /api/files                         文件上传 → fileId / format / hash
GET    /api/files/:id                     文件状态与元数据
POST   /api/view-sessions                 fileId + view 参数 → viewSessionId
GET    /api/view-sessions/:id             状态、字体/资源索引与 layout revision
DELETE /api/view-sessions/:id             取消读取/排版/转换，释放会话
POST   /api/view-sessions/:id/unlock      项目已支持的 DOCX 读取解密
GET    /api/view-sessions/:id/content     PDF 原字节 / DOCX 原打开流程的展示字节
GET    /api/view-sessions/:id/assets/:key 图片、媒体、字体、DOCX lazy part
GET    /api/view-sessions/:id/slides      页目录、播放元数据、测量 batch
GET    /api/view-sessions/:id/slides/:n   RenderSlide + renderRevision
POST   /api/view-sessions/:id/text-widths batch + revision + key→width
GET    /api/view-sessions/:id/pdf-display-metadata
POST   /api/view-sessions/:id/altchunks   已解码 HTML → bytes 或 jobId
GET    /api/jobs/:id                     排队/转换进度/失败信息
GET    /api/jobs/:id/result              altChunk 转换 DOCX 字节
DELETE /api/jobs/:id                     取消当前 session 的任务
```

Word/PDF catalog、DOM 测量与分页不重复实现成服务端 JSON。PPT final RenderSlide 和播放 DTO 同时携带 revision；对不相关的 client/session、旧 batch、未知 key、非有限/负 width、超额 payload 统一拒绝。sourceId 来自单一解析对象；重测字体只重建 layout。

定义状态：`uploaded → opening → waiting-fonts / waiting-measurements / converting → ready`，失败为 `failed`，释放为 `closed`。浏览器 Worker parse、DOM 分页仍用客户端局部状态表示；`ready` 不等于“跨平台像素一致”，一致性由验收记录确认。状态携带可追踪的 error code、revision 与是否允许重试。

父页面选择文件后建立 session，iframe按 URL 和当前会话载入对应格式；切换文件先取消旧请求、销毁 Worker/FontFace/PDF loading task/音视频和 iframe，再 DELETE 旧 session。页面卸载的网络通知只作辅助，服务器 TTL/回收任务是兜底；不能依赖 beforeunload 一定成功。

文件保留策略、session TTL、上传大小、解压额度、同时 worker/context 数由环境配置统一管理。第一版入口绑定 loopback，不假设已有账号系统；若暴露到网络则需要实际接入的身份/代理授权，不能把 fileId 当访问授权。

独立 HTML/Markdown 资源包 API 在本期不交付。OOXML 嵌入资源、PPT 媒体、Word lazy media 与 altChunk 的原资源处理本期必须完成，不能因此裁掉；以后加入 HTML/Markdown 时再接入调研报告中的目录 manifest 导入。

## 6. 独立安装、构建与部署

### Viewer workspace 开发入口

```sh
npm run dev -w @genoffice/viewer
npm run build -w @genoffice/viewer
npm run start -w @genoffice/viewer
npm run test -w @genoffice/viewer
npm run typecheck -w @genoffice/viewer
npm run test:browser -w @genoffice/viewer
```

不新增或修改根脚本。命令均定义在 Viewer 自己的 package.json；类型检查统一入口、Web/Node 分别打包，构建输出仅写入 apps/viewer。

共享包目前导出原始 TS，且原应用明确要求 bundling：Node 产物必须将需要的 workspace 代码编译/打包为 JS，不能让生产 Node 直接解析 `.ts` 或依赖源仓库的 symlink。浏览器构建包含 docx module Worker；服务端 worker、字体、HarfBuzz wasm 和 converter helper scripts 必须按显式资产清单生成，不能从 `apps/slides/out` 或 `apps/docs/out` 读取。

### 独立发布产物（拟交付）

`npm run package -w @genoffice/viewer` 生成完整独立目录/压缩包：编译好的 Node/worker、Web、字体/WASM/PDF.js 资产、最小 runtime package.json + lockfile、README 和 notices。workspaces 依赖内联到产物；必要外部运行时（如 playwright-core）进入最小 manifest，不包含 Electron、AI provider 或 Rust。首期没有 Excel，因此不部署 xlsx-sidecar。

在没有原仓库、没有 Electron 的干净目录完成 `npm ci` 和 `npm start`，打开三格式文件，作为独立性验收。Chrome/Chromium 是 DOCX altChunk 的独立依赖，版本/字体环境固定，路径由 `VIEWER_CHROME_PATH` 显式配置并映射给驱动；health 暴露转换能力是否可用，缺少该依赖时不能把完整 Word 验收标记通过。

根 `postinstall: install-electron` 和其他 workspace 的 Electron 安装是现有问题。**只增加 npm workspace 或设置 Electron 下载跳过变量，不足以证明独立安装。** 开发阶段可在已有 monorepo依赖上工作，但上线必须使用过滤并锁定的 runtime manifest，干净安装不执行根 postinstall。如果要求“从源码仅安装 Viewer 开发依赖”，另提供其完整源码依赖闭包的 staging manifest；不用未经验证的 `npm ci --workspace` 当作已解决。

拟配置：`VIEWER_HOST`、`VIEWER_PORT`、`VIEWER_DATA_DIR`、`VIEWER_FONT_DIR`、`VIEWER_CHROME_PATH`、session TTL/文件额度/worker额度。各格式的字体集合与版本在配置中形成 fingerprint，参与布局/转换缓存键。

## 7. 开发阶段、任务与验收门槛

所有阶段当前状态为待开发。一个阶段只有完成其验收和独立启动测试后才进入下一阶段；代码抽取与原 Electron 基线更新严格分开，不能把意外视觉变化提交成新基线。

### M0：验证边界与建立原基线

- V-001：收集三格式的真实样本并建立 manifest，列出原项目支持/不支持的内容、字体、locale、视图设置和预期结果。
- V-002：跑通复杂文字 PPT 的原测量与浏览器回传探针，确认字宽、第二遍 layout 和渲染可一致。
- V-003：验证原 PDF 表单/cmap 资产链，用已填写字段、checkbox/radio/choice、签名样本确认完整抽取范围。
- V-004：使用原 ElectronBrowserDriver 和 PlaywrightDriver 对照同一 HTML/MHT altChunk，确认规范化 blocks、截图/字体和分页。
- V-005：盘点 import graph、UI/agent 常量、字体/worker/asset 依赖，写出抽取清单与本期允许的包闭包。

验收：每个探针使用确实包含对应特性的文件；记录原/目标差异和具体依赖。存在未解释布局差异就继续处理，不将其计作“已跑通”。M0 后重估任务工期。

### M1：独立骨架、资源与共享代码入口

- V-101：创建 `apps/viewer` workspace、web/server构建、拟定根脚本和独立测试配置；health / ready状态。
- V-102：实现上传、immutable file store、fileId/session、TTL、取消与资产路由（含 Range）；原始文件 hash 保持不变。
- V-103：创建 Viewer 自有 renderer/services 包及纯 UI 入口，记录原源码来源；不改原 app，不添加重定向 wrapper。
- V-104：最小 packaging产物及依赖图检查；字体/worker/WASM资产清单；iframe生命周期。

验收：单独启动不启动其他 app；独立产物可提供页面/API；关闭/超时无会话泄漏；跨session资源被拒绝；新增代码没有其他 app的 runtime import。

### M2：PPT 静态预览

- V-201：解析、原媒体/主题/母版继承和 RenderSlide endpoint。
- V-202：完整字体加载→测量 batch→回传→二次排版，revision和 worker隔离。
- V-203：原 StaticNode/SlideThumb、图片兼容、缩放/翻页/跳页与预加载。

验收：静态样本的 RenderSlide几何、换行、图片/图表和最终截图达基线；加载失败/未就绪有正确状态；刷新和两浏览器同时预览不会复用错误字宽。

### M3：PPT 放映

- V-301：抽取原动画步进、转场/Morph、键盘/隐藏页/黑白屏和超链接行为。
- V-302：原 DOM媒体层和命令序列；Range、点击播放、自动播放失败处理、切页/退出停止。
- V-303：用户点击全屏和 fullscreenchange适配，不含双屏或定时自动轮播。

验收：每个受支持效果的步骤顺序、关键帧、媒体命令和页面导航与原一致；不只比较第一页静态图。M2/M3通过后可交付独立PPT版本。

### M4：PDF 完整只读展示

- V-401：原 PdfPage/TextLayer/缩略图、DOC_OPTS与静态资产。
- V-402：form-catalog/FormLayer/LinkLayer及只读metadata；屏蔽写入/签署。
- V-403：搜索/复制、缩放旋转、密码与大文件可见页生命周期。

验收：页面/文字/字段不缺失，无重复绘制；旋转/缩放与链接正确；长文件滚动后位图可释放。PPT版本不回归。

### M5：DOCX 完整只读展示

- V-501：原打开预处理/解密/字节访问、Worker parse、phased load、字体/编号/布局设置与node views。
- V-502：原 DOM/CSS、分页、分栏/浮动对象、页眉页脚/脚注与修订显示；原lazy media适配HTTP。
- V-503：readonly输入与命令边界，读取搜索/复制；切换文档取消旧 generation、fonts与worker。
- V-504：原altChunk转换回调、Playwright导出及 Chromium转换池、超时/取消/清理。

验收：Word样本的页数/换行/跨页/浮动位置与原一致；图片/lazy media可见；密码与altChunk成功/失败行为可追踪；禁用编辑不破坏内容几何。

### M6：三格式对照和独立发布

- V-601：同OS/字体/viewport/DPR/locale下原Electron与 Web 对照测试；补齐原基线没有覆盖的PPT、PDF和Word文件。
- V-602：关闭/重开/超时/转换取消/worker异常和并发会话隔离；文件 hash不变。
- V-603：干净部署目录安装启动，检查全部资产、精确运行依赖、端口/配置、日志和 health。
- V-604：完成 README、部署说明和已知限制；发布验收记录说明测试环境及原项目的未支持范围。

验收：三格式所有本期特性通过，产物不用原 apps/out、其他 app、Electron、AI或Rust；DOCX转换环境明确。未解释差异必须修复或保持阶段未完成，不能用截图转换或宽松阈值替代。

## 8. 测试策略和排期方式

复用 `build-slide`、`animation-play`、`show-keys` 等现有测试验证抽取保持行为；新增测试聚焦实际变化：字体测量状态/协议、session隔离、资源Range、PDF widget完整性、DOCX lazy media和转换driver、worker/转换取消与独立产物。文档和纯UI裁剪不额外写镜像实现的测试。

原 `e2e/docs-visual.spec.ts` 的PNG基线来自 Linux/xvfb固定字体且使用零差分。先在相同环境/缩放与内容区域复用，分别记录DOM布局与像素结果。布局（换行/分页/坐标）任何漂移都失败；浏览器内核导致的抗锯齿差异单独记录和归因，不能扩大全图阈值掩盖排版变化。PPT动画使用确定性时钟/状态/关键帧，媒体检查命令与play/pause状态。

首批建议覆盖约15–25个三格式样本，实际覆盖按特性manifest判断，不以数量代替覆盖。M0的原程序构建/截图环境和M6的Web产物测试分开：验证时可以使用Electron，生产产物不能依赖它。

阶段依赖：`M0 → M1 → M2 → M3 → M4 → M5 → M6`。最终里程碑为三格式独立应用；M3可先交付PPT，M4再交付PPT/PDF。外部资源包的HTML/Markdown探针随其后续阶段执行，不阻塞本期，但altChunk的原资源处理本期不能跳过。

本计划不给未经验证的日历承诺。M0完成后按V任务估算人日、风险余量和差异修复；原调研中的六格式7–12周不直接套到三格式范围。PPT字体闭环、DOCX渲染抽取及转换driver是排期的主要不确定项。

## 9. 首批开始开发的顺序

先做 V-001～V-005，产出具体样本清单、对照结果和可提取依赖闭包；随后提交M1独立workspace。每次修改共享渲染模块时，同一批次完成原app回归和Viewer的对应功能验证。暂不添加Excel/HTML/Markdown或通用编辑器功能，避免扩大首期发布边界。
