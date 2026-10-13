# PPTX / DOCX / PDF 展示功能审查

审查日期：2026-10-13。对照仓库源码基线 `4863835963c99793c47b72473900c483e9fa0c2a` 与当前 Viewer。

## 修复进展（2026-10-13）

首期实际功能缺口已接入 Viewer。下方保留初次审查的发现和当时源码依据，供追溯；这些“未接入”描述不再代表当前实现。原程序逐页视觉基线与复杂样本全量验收仍未完成。

| 初次发现               | 当前修复与验证                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOCX 逐块布局缺失      | 使用原 column/sectionWidth/grid/charSpace/topMargin/mirror/vAlign/vertical 布局函数；宽度重测采用原 widthPassGate。稳定后才生成可见分页；超过收敛上限明确提示。文档样式提交后等待字体就绪，晚到字体沿用原行样本和页眉探测缓存失效函数重新分页。已跑通混合不等宽分栏、不同节网格/字距及仓库 08/21/22 语料；延迟字体与重复打开后页数保持稳定。                   |
| DOCX 快照无法阅读      | 清理 contenteditable/内联事件和可编辑节点，阅读模式启用指针事件和文本选择；复制/搜索按实际裁剪窗口过滤；保留一个独立辅助阅读树及键盘链接映射。已验证只读 DOM、书签链接、搜索数量/定位和文字复制。                                            |
| 活动会话被回收         | Host 按服务端间隔续期、恢复前台立即续期；失效提供重新打开。打开/测量/转换/slim 处理期间避免回收，关闭清理 ZIP 句柄与明文。短 TTL 的活动续期、空闲回收、失效重新打开已验证。                                                                  |
| PDF 批注正文缺失       | 接入原 loadSavedAnnots/buildNoteThreads/DrawLayer/NoteMarginColumn 只读链路，保留原 pin 图标/颜色/定位与卡片连线；正文、作者、时间及回复可读，不提供修改按钮。已验证 Text 批注正文及 /IRT 回复；其他批注类型沿用原程序支持边界。                                                            |
| PPT 普通预览链接缺失   | 沿用原 hitLink；元素/文本 run、URL、页内跳转和放映动作读取原目标。已验证普通预览元素动作链接、跳页、适配与手动缩放。                                                                                                                         |
| PPT 字体恢复不足       | 每个私有字体最多自动尝试三次，成功后回传测量并重新生成排版；可手动重试且避免重复注册 FontFace。修复字体 ID 含空格的 URL 编解码。真实嵌入字体前两次下载失败、第三次成功及 pending 清空已验证。                                                |
| PDF 搜索/导航/缩放缺失 | 原索引/字符矩形映射、高亮/数量/上一处下一处、缩略图、原目录组件与标题 fallback、页码追踪/跳页、原缩放级别/适配、旋转、打开信息/XFA 提示、坏内部目标捕获均已接入。三页样本及原只读表单回归通过。                                              |
| DOCX 其余阅读缺口      | 页码追踪、缩放适配、标题/书签、原页色/header phantom、修订 all/final/original 和批注正文/定位、原 slimDocx 与授权 HTTP 图片、密码错误重试均已接入。密码重试、按需图片解码、页色和修订最终模式已验证；复杂 phantom/批注线程还需专项样本对照。 |

验证命令：`typecheck`、`build`、`test`、`test:reading`、`test:media`、`test:standalone`。API/源码检查目前 10 项。阅读回归额外生成 PDF 批注回复、带修订/书签/密码的 Word、混合分栏/网格、按需图片与 PPT 私有字体/链接文件；输出位于 Viewer 自有的忽略目录 `test-results/reading`。

本轮保留原绘图、动画、PDF.js/TextLayer、DOCX 节/行测量/切页/页眉页脚等核心算法；只在 Viewer 专属副本增加读取、布局调用与阅读交互边界。没有修改现有非 Viewer app/package、根配置或根锁文件。

## 初次审查结论（修复前）

三格式已能打开并展示，但尚未达到既定计划的完整只读展示和原程序视觉还原验收。DOCX 缺少部分关键布局调用；PDF 缺少批注正文和阅读导航；PPTX 缺少普通预览交互。

初次审查为源码调用链及现有测试覆盖审查。“未接入”表示当时入口没有该功能；“待验收”表示已有实现，尚无充分对照证据。编辑、保存写回、AI、批注新增、表单填写/签署不计入缺口。

## 优先处理的发现

### P1：DOCX 原逐块布局更新没有接入

`viewerLayout` 会计算 `colMode='mixed'`，但 `colFlow` 只有 uniform 模式才有值；当前宿主只在 `colFlow` 存在时注入全局 column CSS，没有调用原逐块布局更新。

原项目在测量后生成并提交 `columnLayoutSpecs`、`sectionWidthSpecs`、`sectionGridPitchSpecs`、`sectionCharSpaceSpecs`、`sectionTopMarginSpecs` 等修正。`ColumnLayoutExtension` 初始为空；把该插件复制进来并注册，不会自动生成这些修正。

影响：混合/不等宽分栏、连续分节、不同节内容宽度、不同节行网格/字网格等文档，可能以错误宽度测量、换行和分页。部分竖排、浮动对象及跨节页边距也需要原测量链的专项对照，不能据组件同源码宣称已完整还原。

依据：[Viewer 分栏调用](/Applications/work/genoffice/repo/apps/viewer/src/web/docs.tsx:217)、[colMode/colFlow 计算](/Applications/work/genoffice/repo/packages/viewer-renderers/src/docs/renderer/viewer-layout.ts:234)、[插件空初始状态](/Applications/work/genoffice/repo/packages/viewer-renderers/src/docs/renderer/editor/column-layout.ts:36)、[原逐块布局生成](/Applications/work/genoffice/repo/apps/docs/src/renderer/App.tsx:4674)、[原布局提交](/Applications/work/genoffice/repo/apps/docs/src/renderer/App.tsx:4740)。

建议：仅在 Viewer 自有包中补齐原布局控制器的必要测量/修正/稳定收敛调用，再打开分页视图；用仓库多节/分栏语料验证，不改原 app。

### P1：DOCX 仍使用非交互的打印快照作为唯一阅读视图

可见 `.pv-scroll` 为 `aria-hidden`，每张 `.pv-page` 为 `inert`；真正的 Tiptap 画布又被移到屏幕外并设为 `visibility:hidden`。这是原打印预览的保护机制，并非完整的只读阅读界面。

影响：可见正文无法提供正常的链接点击、文本选择复制和屏幕阅读器访问。图片、表格、公式等可以看见，不代表这些阅读能力已经接入。不能直接删除 inert：克隆页还携带原节点的可编辑属性，需同时实现只读交互边界及避免重复辅助树。

依据：[隐藏画布](/Applications/work/genoffice/repo/apps/viewer/src/web/viewer.css:123)、[快照辅助树隐藏](/Applications/work/genoffice/repo/packages/viewer-renderers/src/docs/renderer/components/PaginationPreview.tsx:1466)、[页面 inert](/Applications/work/genoffice/repo/packages/viewer-renderers/src/docs/renderer/components/PaginationPreview.tsx:1561)。

建议：保留原内容渲染与分页，补只读链接/导航/选择层和独立的可访问阅读表示。

### P1：三格式缺少活动会话续期

服务端默认 30 分钟按最后一次 API 请求时间回收会话；Host 没有心跳或阅读活动续期。用户一直看已加载的页面，也可能被当成空闲会话回收。

影响：长时间阅读或放映后再加载音视频、尚未取得的 PDF 字节范围等，可能返回 404。已加载画面继续存在，容易让用户误以为文件损坏。

依据：[TTL 默认值](/Applications/work/genoffice/repo/apps/viewer/src/server/index.ts:14)、[回收逻辑](/Applications/work/genoffice/repo/apps/viewer/src/server/index.ts:174)、[当前 Host 生命周期](/Applications/work/genoffice/repo/apps/viewer/src/web/host.tsx:13)。

建议：活动文档续期，失效/恢复状态明确展示；关闭仍释放会话。

### P2：PDF 已保存批注只能看到画面，不能读批注正文/回复

当前挂载的附加层只有 FormLayer 和 LinkLayer，没有读取 `loadSavedAnnots` 并挂载原批注 pin、正文及线程查看组件。原 PDF App 明确在 read-only 时也读取批注。

影响：高亮、笔迹等可能已经出现在 PDF.js 画面上，但用户无法点击批注读正文、作者或回复线程。

依据：[当前页面层](/Applications/work/genoffice/repo/apps/viewer/src/web/pdf.tsx:128)、[原只读批注读取](/Applications/work/genoffice/repo/apps/pdf/src/renderer/App.tsx:2354)、[原批注层](/Applications/work/genoffice/repo/apps/pdf/src/renderer/App.tsx:9433)。

建议：迁移只读批注读取、pin 和线程展示；排除新增、回复写入、删除等编辑能力。

### P2：PPT 普通预览没有超链接点击处理

普通预览使用 `SlideThumb`，其 Konva Stage 不监听输入；补上的覆盖层只处理音视频。元素链接、文本 run 链接和幻灯片跳转仅交给 SlideShowView，普通预览没有对应 hit-test/导航。

依据：[静态 Stage 禁用事件](/Applications/work/genoffice/repo/packages/viewer-renderers/src/slides/renderer/SlideThumb.tsx:50)、[普通预览装配](/Applications/work/genoffice/repo/apps/viewer/src/web/slides.tsx:153)、[放映数据接口](/Applications/work/genoffice/repo/apps/viewer/src/web/slides.tsx:91)。

建议：沿用原链接命中算法与目标解析，增加 Viewer 只读点击层，不改变静态绘图算法。

## PPTX：未接入的首期功能

- **普通预览元素/文字超链接和文内跳转**：放映已有对应链路，普通预览未接。
- **手动缩放、适合页面/宽度**：当前只是随窗口调整展示宽度，没有用户缩放控制。
- **预览页码输入/快捷跳页**：已有前后翻页和缩略图点击，没有直接输入页码；放映内部的数字跳页不能算普通预览入口。
- **字体加载失败后的自动重试/重新测量排版**：目前打开时测量回传一次，剩余 pending 只显示警告；晚到字体的 redraw 不等于服务端重新排版。应补失败恢复并验证收敛，不把一次回传本身判为未实现。

已接入：原解析/排版/静态节点、图片/图表/文本绘图、缩略图、前后翻页；原放映动画/转场/Morph 组件、隐藏页过滤、黑白屏/数字跳页/网格等内部逻辑；放映链接；普通预览及放映的音视频播放。

其中嵌入 VP8 视频与 PCM 音频已经专项验证；不同动画效果、段落动画、Morph、隐藏页、复杂链接、外部媒体、其他编码、私有字体/CJK/RTL、EMF/WMF 等仍需实际样本验收。不能把这些已有模块全部列为“没加”。

依据：[Viewer 操作栏](/Applications/work/genoffice/repo/apps/viewer/src/web/slides.tsx:113)、[字体反馈](/Applications/work/genoffice/repo/apps/viewer/src/web/slides.tsx:55)、[放映隐藏页规则](/Applications/work/genoffice/repo/packages/viewer-renderers/src/slides/renderer/slideshow-utils.ts:19)、[放映接口装配](/Applications/work/genoffice/repo/apps/viewer/src/web/slides.tsx:167)。

## DOCX：未接入或部分接入的首期功能

- **逐块布局修正**：混合分栏、跨节内容宽度、混合网格/字距等，见 P1。
- **正常阅读视图的链接、选择复制、辅助阅读**：可见快照被 inert，见 P1。
- **只读全文搜索及匹配定位**：没有搜索 UI 或命中高亮/定位装配。
- **缩放/适合宽度/适合页面**：隐藏测量画布固定 zoom=1，可见页面没有用户缩放控制；测量应继续保持原比例，阅读缩放独立处理。
- **导航与直接跳页**：没有标题/目录/书签导航侧栏和页码输入；当前只有滚动、总页数及页脚页号。
- **页色与 header phantom**：没有读取/设置原正文画布的 `--page-bg`，也未调用原 `hfPhantomSpec` / `hfWithPhantom`。原打印快照本来使用白纸背景，因此需要明确对齐“原正文分页展示”还是“原打印预览”；当前不能据复用快照宣称保留了正文页色与对应头部布局。
- **lazy media 的 HTTP 按需链路**：服务端直接返回整份原始 DOCX；未建立原 slimDocx 占位符、hash/part 资源授权与按需回填。`setLazyMediaHashes` 调用不能替代该服务。普通整包内图片已能显示，不能说图片功能全部缺失。
- **修订/批注阅读控制**：已有标记及分页批注绘制链路，但没有修订显示模式选择、批注定位/只读线程阅读操作栏。具体展示结果仍需修订/批注语料对照。
- **打开密码错误后的重试**：当前只有一次 prompt，打开 Promise 失败后只显示错误，需要重新打开文件才能重试。

已接入：原解析 Worker 与 fallback、原自定义节点/内容 CSS/主题、嵌入字体和 numbering 初始化、表格/图片/浮动对象/公式的原组件、基本分页、统一分栏、节信息和页眉页脚解析、脚注尾注/批注/修订的参数链路、phased content、原解密、HTML/MHT altChunk 转换器。

HTML altChunk 已做浏览器链路验证；MHT 内联图片/相对资源、复杂页眉页脚/脚注/修订、长文档分阶段加载、密码、多节/浮动对象等未形成充分验收。先修缺失调用，再验收复杂排版。

依据：[当前 DOCX 装配](/Applications/work/genoffice/repo/apps/viewer/src/web/docs.tsx:47)、[密码入口](/Applications/work/genoffice/repo/apps/viewer/src/web/docs.tsx:85)、[当前布局和预览](/Applications/work/genoffice/repo/apps/viewer/src/web/docs.tsx:169)、[原 header phantom](/Applications/work/genoffice/repo/apps/docs/src/renderer/App.tsx:3145)、[原正文页色](/Applications/work/genoffice/repo/apps/docs/src/renderer/App.tsx:7078)、[整包内容接口](/Applications/work/genoffice/repo/apps/viewer/src/server/index.ts:308)。

## PDF：未接入或简化的首期功能

- **缩略图侧栏**：没有挂载原 PdfThumb 与缩略图可见区域管理。
- **书签/目录侧栏**：没有 `getOutline` 的入口，也没有原文档无目录时的标题识别目录 fallback。
- **直接跳页、当前页追踪、前后页导航**：当前只有连续滚动和总页数，没有原页码输入/当前位置/翻页控件。
- **原搜索体验**：现在只查找哪些页含文本并跳到第一匹配页；没有匹配高亮、命中数量、逐项上一处/下一处，以及原文本索引与字符位置映射。
- **适合页面/宽度与完整缩放控制**：只有 25% 步进的 25%–400% 缩放，没有原适配模式、缩放级别和快捷交互。
- **已保存批注正文/回复线程读取**：见 P2；不能据普通高亮可见判为批注查看已完成。
- **打开信息和格式限制提示**：没有原文档信息/格式特征读取与 XFA 等限制提示装配。对 PDF.js/原项目本身不支持的格式，不应额外承诺支持。
- **异常内部链接的兜底**：Viewer `goToDest` 未沿用原异常捕获和数组检查，坏目标可能产生未处理 Promise 异常。当前文内链接只跳页；原 App 本身也主要跳页，不能把未精确定位 XYZ 坐标算新增的迁移缺口。

已接入：原 PDF.js 配置、CMap/标准字体/WASM、原 canvas/TextLayer、可见页渲染释放、基本缩放旋转、只读 FormLayer、LinkLayer、密码回调和 Range。

普通文字选择复制由 TextLayer 提供；已保存高亮/笔迹等原生 annotation 及已经写入内容流的静态填表图片由 PDF.js 绘制。**没有独立 metadata 接口，不等于这些像素都没显示。** 静态填表、签名视觉外观、radio/choice、旋转后链接、CropBox/UserUnit 等仍需样本验证，不能在未验证前归入“全部未接入”。

依据：[Viewer 搜索](/Applications/work/genoffice/repo/apps/viewer/src/web/pdf.tsx:72)、[缩放操作栏](/Applications/work/genoffice/repo/apps/viewer/src/web/pdf.tsx:90)、[Viewer 链接目标处理](/Applications/work/genoffice/repo/apps/viewer/src/web/pdf.tsx:65)、[原链接兜底](/Applications/work/genoffice/repo/apps/pdf/src/renderer/App.tsx:6569)、[原搜索导航](/Applications/work/genoffice/repo/apps/pdf/src/renderer/App.tsx:9688)、[原目录 fallback](/Applications/work/genoffice/repo/apps/pdf/src/renderer/App.tsx:1445)、[原生 annotation 绘制](/Applications/work/genoffice/repo/packages/viewer-renderers/src/pdf/renderer/PdfPage.tsx:100)。

## 本期不应算作遗漏的功能

按现有开发计划：编辑、保存/另存、插入删除、AI、批注新增、表单填写/签署、密码修改、格式导出不做；双屏 Presenter、自动定时轮播和旧二进制 `.ppt/.doc` 在首期之外。原自定义放映/排练计时/只读备注入口尚未接入，可列后续增强，不能混入首期必补清单。

## 共同缺少的验收

- 固定原 Electron 版本、浏览器内核、OS、字体、viewport、DPR、locale，建立三格式逐页基线。
- 比较真实页数、换行、位置与动态播放行为；源码一致性与“有 canvas”仅证明沿用了实现，不能替代视觉/布局对照。
- 分别覆盖字体加载失败、资源缺失、密码错误、长文件、会话过期、取消转换及并发隔离。

建议补齐顺序：DOCX 原布局与只读交互边界、活动会话续期 → PDF 批注阅读与导航/搜索 → PPT 普通预览链接和缩放/跳页 → 三格式复杂语料及原程序对照。所有补齐继续限定在 Viewer 和新增 Viewer 包中。
