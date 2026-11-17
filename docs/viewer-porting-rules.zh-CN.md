# Viewer 移植规则与来源说明

本规则仅适用于 GenOffice 项目。用户要求：**能从主包移植的功能必须优先从主包移植；主包缺失或无法适用的部分才自行实现。**

## 三端对齐与验收要求

后续代码任务必须同时处理 Web、服务端、Android 三端，并逐项与 Electron 方案比较，以 Electron 为基准。差异应通过修改对应三端实现消除，不得修改 Electron 来迁就三端，也不得降低校验标准或更改预期结果。

实现前记录相关功能的四端入口及差异；实现后分别验证三端实际调用链。验收记录至少包含：功能项、Electron 基准源码与行为、Web 结果、服务端结果、Android 结果、剩余差异。共享函数或私有 Node 适配层的测试不能替代端到端验证；尤其要区分浏览器本地解析、HTTP 上传及远程解析、Android WebView，以及服务端解析后由浏览器绘制的链路。

遇到无法处理的兼容性问题，必须向用户说明具体冲突、涉及端与功能、影响范围和可选方案及各自限制，不得忽略、强行处理、静默降级或标记完成。无法运行某端验证时如实记录，不能用其他端的通过结果代替。

## 执行方式

实现前先定位主包对应模块，判断能否直接迁移、抽取其中的纯逻辑或通过薄适配层接入。Electron IPC、文件读取方式和 Web/Android 宿主不同，只是需要检查的适配边界，不能单凭这些差异认定核心功能无法移植。

适用的主包实现连同传递依赖、资源和已有样本一起迁移，保留解析、排版和绘制语义。私有补充应集中在宿主边界、只读界面、按需调度等实际差异上。主包确实缺失对应功能，或复用会引入与目标不兼容的行为时，记录检查位置、具体原因和自行实现范围。

来源清单中的基线提交表示原始代码同步的依据，不表示私有新增逻辑也是上游实现。每次迁移更新对应来源清单、适配说明和必要的行为回归；未改变的核心模块继续保持来源一致性校验。

## 本轮 PDF 来源核对

核对主包基线为 `v0.13.18`，提交 `ac19c54111849d9d8fb2c508223a0389b805c247`。下表说明 PDF 优化及其前置失败隔离改动，不表示新增桌面编辑或打印入口。

| 功能                         | 主包来源及采用方式                                                                                | 私有补充或不直接迁移的原因                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 单页尺寸与失败隔离           | `apps/pdf/src/renderer/page-probe.ts`，已移植到私有包                                             | 增加取消检查和单页调用包装；首次打开仅请求第一页，其他页面按阅读位置请求                                                               |
| Canvas、文字层及单页像素限制 | `apps/pdf/src/renderer/PdfPage.tsx`，保留原渲染流程和像素缩放计算                                 | 增加失败回报、可配置预算、取消和资源释放                                                                                               |
| 表单及签名外观判断           | `apps/pdf/src/renderer/form-catalog.ts`，从已移植的目录构建逻辑提取 `pageFormWidgets`             | 改为按页调用，保留原始页码和签名判断，避免为只读页面扫描全书字段                                                                       |
| 画布像素释放                 | `apps/pdf/src/renderer/PdfThumb.tsx` 的 `releaseCanvasPixels` 方式                                | 抽取等价的私有 `releasePdfCanvas`，用于正文页面替换、离屏和卸载                                                                        |
| 搜索、标题识别、批注线程     | 主包 `search.ts`、`heading-outline.ts`、`annotation-catalog.ts`、`note-threads.ts`                | 沿用原算法，增加按需调用、单页容错、取消和有界派生数据缓存                                                                             |
| 常驻页面窗口、两任务渲染队列 | 检查主包 `PdfPage.tsx`、`PdfThumb.tsx`、`App.tsx`，没有对应的交互式窗口/限流实现                  | 自行补充按像素预算选择附近页面和可取消队列；主包 `print.ts` 的预算以打印 DPI、整批页面和最低打印清晰度为约束，不能直接用于交互阅读窗口 |
| URL/Range 按需加载           | 主包 `file-bytes.ts`、`open-document.ts` 分别针对 Electron IPC 分块和保留字节副本                 | 当前 Viewer 使用 PDF.js URL 入口，补充 PDF.js 加载参数，不重写 IPC 分块或字节副本逻辑                                                  |
| 加密回归                     | 复用 `apps/pdf/tests/fixtures` 的加密样本；测试生成器复用主包 `pdf-crypt.ts` 的 `encryptDocument` | Viewer 浏览器测试补充密码交互、重试、取消和重新打开；不把桌面解密/保存模块引入生产包                                                   |

本轮自行补充的调度和加载参数明确标记为 Viewer 适配。后续主包出现等效且适用的实现时，按本规则重新核对并优先迁移；不能因为已有私有实现而跳过主包检查。验证范围见 [测试指南](testing-guide.zh-CN.md#2026-11-17-pdf-大文件首屏内存与加密回归)。

## 2026-11-17 五项移植整改

以下实现核对当前主包源码，主包文件未修改；保持 Viewer 已有函数导出、只读预览、便携字体兜底及媒体 descriptor 协议。

| 整改项       | 主包来源与移植方式                                                                                                            | 保留的宿主适配与回归                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 加密 Word    | 整模块复制 `packages/electron-utils/src/ooxml-encryption.ts` 至私有 `shared/ooxml-encryption.ts`，不再维护另一套检测/解密算法 | `docs/decrypt.ts` 仅包装 Buffer 输入并维持原导出名；真实 Office Agile/Standard 文件逐字节解密、Uint8Array 偏移视图、错密、取消、重开  |
| TIFF 解码    | 从 `apps/slides/src/main/tiff-decode.ts` 提取原尺寸判断、最大合法 IFD 选择、解码和解码后复查至 `slides/shared/tiff-pixels.ts` | 浏览器仅处理字节视图和 PNG 编码；合法图像与原 Node 解码像素一致，非法尺寸在像素分配前拒绝                                             |
| PPT 字体回退 | 从 `apps/slides/src/main/fonts.ts` 的 `createSystemFontMetrics` 提取 `scriptFallbackFor` 及原模式，发现与度量共用             | 字体文件查询改为目录/已加载字形查询；已有字形不替换，首选字体不可用时保持原便携链，不虚构系统字体可用性                               |
| SVG 主题色   | 从 `apps/slides/src/main/session-state.ts` 提取 `SVG_THEME_SLOTS` 和 `retintThemedSvg` 至 `slides/shared/themed-svg.ts`       | 浏览器和服务端使用同一函数；保留主题、母版颜色映射和损坏关系回退                                                                      |
| 来源与守卫   | 补齐 10 个代码/样式文件和 36 个字体资源的记录，Word 来源更新为共享 OOXML 模块                                                 | `directCopies` 锁定原样复制；`adaptedFiles` 逐文件登记既有适配；`extractedSymbols` 和 TIFF 核心语句对照主包，不删除原有核心一致性检查 |

新增来源回归 `apps/viewer/tests/porting-source.test.ts` 覆盖清单内原样文件、逐项适配登记及抽取核心。后续主包修复会触发对应守卫，须先同步适用实现，再更新明确的宿主适配。不得通过宽泛排除来源检查接受未知差异。

浏览器字节边界显式构造 Buffer：当前兼容层的 `Buffer.isBuffer` 也接受普通 Uint8Array，不能据此省略规范化。未加密 ZIP 文档只检查八字节头，避免检测时复制整份大文档。原 Office 解密库的 xml2js 依赖需要事件接口，Viewer 的 Vite 配置仅为浏览器接入 `events@3.3.0`，Node/桌面解析路径仍使用原模块。

## 2026-11-17 实际三端入口补齐

前述共享模块回归不能代表 HTTP 链路已经接入。本轮修复先前远程上传拒绝加密 Word、TIFF 空白及 SVG 保留原始颜色的问题，不修改 Electron 实现。

| 功能                  | Electron 基准                                                                                     | Web                                                                  | 服务端                                                                                      | Android                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Word Agile / Standard | `packages/electron-utils/src/ooxml-encryption.ts` 及 `apps/docs/src/main/docs-main.ts` 的解密重试 | 本地沿用共享解密；远程通过 `upload-file.ts` 提示密码、错误重试、取消 | 共享算法放入受限子进程，复用解析队列和存储配额；仅密码错误可重试                            | 复用远程上传流程，原生密码框隐藏输入并支持取消；成功导入后可下载 Word 离线包 |
| TIFF                  | `apps/slides/src/main/tiff-decode.ts` 的尺寸守卫、最大合法 IFD、解码后复查                        | 本地使用已抽取核心；远程使用服务端生成的 PNG                         | `pptx-slim.ts` 在解析字节预算内保留 TIFF，`pptx-core.ts` 调用主包媒体适配的原样 TIFF 解码器 | 在线与离线模型均使用已解码图片，不依赖 WebView 原生 TIFF 支持                |
| SVG 主题色            | `apps/slides/src/main/session-state.ts` 的主题、母版映射及当前幻灯片上下文                        | 本地使用共享重着色；远程接收已重着色资源                             | 保留 SVG 并携带当前 `slide.path` 调用共享媒体适配，覆盖客户端布局模型和服务端渲染树         | 下载模型保留已重着色资源，断开服务端连接仍按相同主题显示                     |

宿主兼容边界：Electron 在本机保留加密原件；HTTP 上传导入的是解密后的解析副本，返回其内容哈希，后续缓存与离线内容可读，客户端原始文件保持不变，密码不落盘。主包解密库和 TIFF/SVG 适配需要读取完整相关资源，因此加密输入和保留资源受服务端解析字节预算限制；超限明确失败，不取消预算或修改 Electron。其他大型媒体继续使用原有流式资源路径。

服务端新增 HTTP 回归 `apps/parse-server/tests/office-compat.test.ts`；生产浏览器回归 `VIEWER_PORTING_MODE=server` 运行 Viewer `test:porting`；Android 实机脚本为 `android-office-compat-smoke.mjs`，分别验证在线与权威离线包断开服务连接后的 TIFF/SVG 像素。Word 在线/离线复用 `android-docx-smoke.mjs`。来源和薄适配登记见私有服务包 `sources.json` 的 `hostIntegrations`。

## 2026-11-17 独立上传页与 Word 阅读留白

独立 `upload.html` 的 XHR 进度上传原先没有调用密码重试适配。现在与预览首页共用 `upload-file.ts` 的密码状态处理，XHR 仅负责进度和传输；正确密码、错密重试、取消后切换明文以及两种 Office 加密格式均在真实 HTTP 入口回归。Android 的同一上传页面使用现有原生密码输入框。

以 `01_Word_明文对照.docx` 实际打开 Electron 阅读视图对比，纸宽约 793.73px，四边正文边距 75.6px；Electron 的 `.page-wrap` 为零 padding，padding 在内部 `.doc-page`。Viewer 连续正文采用单个纸层 padding、各虚拟单元零 padding，正文的实际内缩本来一致，但没有迁移 `App.tsx` 的 `docZoomStyle` 页面 CSS 变量，页角标记错误地使用 816px 纸宽和 96px 默认边距。远程页面还多出文件名占用约 29px。

薄适配 `docx-reading-page.ts` 复用已移植的 `pagination-sections.ts/sectionPageBox`，将同一页面宽度、正文宽度、四边边距及页眉页脚距离传递给纸层与隐藏测量；本地、HTTP 模型与 Android 在线/离线共用。移除远程正文顶部额外文件名，名称保留在预览入口/无障碍标签。正文保留此前明确要求的连续阅读、按需单元窗口，不改回固定纸高或分页，也不对每个正文单元重复添加 padding。Electron 主包未修改。

复验入口：Viewer `test:porting` 的 server 模式同时检查预览首页、独立上传页及页面几何；`test:library` 检查上传后历史保存/打开/恢复；Android `android-word-password-smoke.mjs` 设置 `ANDROID_UPLOAD_PAGE=1` 检查实际上传页，`android-docx-smoke.mjs` 记录并检查在线/离线页面边距和页角几何。

## 2026-11-17 纸张最小页高补齐

前一轮将纸层最小高度归零，把连续阅读误当作纸张随短正文收缩；这与 Electron 阅读视图不一致。现将主包 `apps/docs/src/renderer/styles.css` 的 `.doc-page { min-height: var(--page-h, 1056px) }` 应用于 Viewer 的单个 `.viewer-doc-reading-paper`。页面高度来自已复用的 `sectionPageBox` 和服务端原始 SectionSettings，不改写文档数据或 Electron。内部虚拟单元仍为零最小高度，避免每块正文被重复撑成一整页；纸层是最小高度，不是固定高度，长文档自然增长且继续连续加载。

测试文档 `01_Word_明文对照.docx`：Electron 实测纸高 1122.53125px，Viewer 修复前约 562.64px，修复后本地、HTTP 解析模型及 Android 在线/离线均按 1122.53px 最小页高显示。新增生产浏览器和 Android 断言同时核对 min-height 与 --page-h、实际纸高不小于文档页高。
