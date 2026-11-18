# 按 v0.13.18 Electron 对齐显示

## 2026-11-18 Word 页面版式统一（后续有效要求）

用户明确要求三端 Word 使用 Electron 默认页面版式、只读不可编辑，停止支持此前默认显示模式，允许破坏性更新且不更改接口版本。本轮移除连续阅读与模式切换；旧 `view=read` 不再改变布局。此要求取代下文历史 Word 连续阅读设计，PPT/PDF 及既有接受项范围不扩大。

复用原 App 文档级行网格、字符间距与页面边距样式，隐藏测量和分页克隆同时生效；继续使用原 PaginationPreview 的页盒、切点、页眉页脚和表格跨页算法。三端均启用该组件原有的按页裁剪克隆，避免在 Android 上重复复制完整正文；阅读位置只在首次打开恢复。原生入口按实际页面首帧撤下加载遮罩，渲染进程退出时明确提示，不再把宿主一并崩溃。

真实 Web 本地/HTTP 模型、Android 在线与校验包断开后端的离线回放分别验证。F143 为20个物理页、末页字段“第16页 共16页”；同Chromium150的20页切点和抽查行框与Electron一致。Chrome157仍有累计3.6875px、Android114有1.5234375px的严格小数排版残余，不以页数相同或视觉接近关闭。一次旧WebView离线首次加载等待在刷新后恢复，后续重跑通过但原因未确认，保留记录。

当前报告、逐端结果和全部限制见 [Word页面修复报告](/Users/dddd/Downloads/genoffice-f143-20261118-audit/repair/report.md)。接口与离线包协议版本保持不变，未提交或推送。

基线为下载目录 `/Applications/work/genoffice-v0.13.18`，标签提交 `ac19c54111849d9d8fb2c508223a0389b805c247`。不修改该基线目录的实现。对应审计报告与原始截图位于 `/Users/dddd/Downloads/genoffice-v0.13.18-audit`。

用户本轮明确接受 W05、W07、S06、S08、A06、A07 为现有设计；这些项不在修复范围。其他22条按端问题参与修复及分别验证。跨端相同根因合并实现，仍按实际入口逐项验收。

| 编号 | 端与显示项                                                          | 本轮状态                   |
| ---- | ------------------------------------------------------------------- | -------------------------- |
| W01  | Web：PPT字体、标题/正文换行与重叠（F011/F013第6–7页；F152多页）     | 原问题修复并复测通过       |
| W02  | Web：符号字体（F027第3页；另见F018第20页）                          | 原问题修复并复测通过       |
| W03  | Web：Word阅读视图纸张位置、页眉及正文起点（F002/F003封面）          | 原问题已修复；严格细节残余 |
| W04  | Web：Word默认分页与页码/页脚（F002多页报告）                        | 原问题修复并复测通过       |
| W05  | Web：Word浮动工具栏遮挡表格数据（F002，滚动2200 CSS px）            | 用户接受的设计，不修改     |
| W06  | Web：大Word的Web本地模式（F009，118.43 MiB）                        | 原问题修复并复测通过       |
| W07  | Web：旧版DOC反馈表（F144）                                          | 用户接受的设计，不修改     |
| W08  | Web：加密Word错密/重试的提示显示                                    | 原问题修复并复测通过       |
| W09  | Web：长Word本地预览在第64个顶层块截断（F015/F133/F143）             | 原问题修复并复测通过       |
| W10  | Web：Word目录条目的页码字段（F143目录）                             | 原问题修复并复测通过       |
| S01  | Server：PPT字体、标题/正文换行与重叠（F011/F013第6–7页；F152多页）  | 原问题修复并复测通过       |
| S02  | Server：符号字体（F027第3页；另见F018第20页）                       | 原问题修复并复测通过       |
| S03  | Server：Word阅读视图纸张位置、页眉及正文起点（F002/F003封面）       | 原问题已修复；严格细节残余 |
| S04  | Server：Word默认分页与页码/页脚（F002多页报告）                     | 原问题修复并复测通过       |
| S05  | Server：Word嵌入对象EMF/WMF预览（F009附件位置）                     | 原问题修复并复测通过       |
| S06  | Server：旧DOC被误报为加密文档（F144）                               | 用户接受的设计，不修改     |
| S07  | Server：加密Word错密/重试的提示显示                                 | 原问题修复并复测通过       |
| S08  | Server：HTTP链路客户端浮动条遮挡Word图片（F009）                    | 用户接受的设计，不修改     |
| S09  | Server：Word目录条目的页码字段（F143目录）                          | 原问题修复并复测通过       |
| A01  | Android：PPT字体、标题/正文换行与重叠（F011/F013第6–7页；F152多页） | 原问题修复并复测通过       |
| A02  | Android：符号字体（F027第3页；另见F018第20页）                      | 原问题修复并复测通过       |
| A03  | Android：Word阅读视图纸张位置、页眉及正文起点（F002/F003封面）      | 原问题已修复；严格细节残余 |
| A04  | Android：Word默认分页与页码/页脚（F002多页报告）                    | 原问题修复并复测通过       |
| A05  | Android：Word嵌入对象EMF/WMF预览（F009附件位置）                    | 原问题已修复；严格细节残余 |
| A06  | Android：旧DOC在真机入口无法显示（F144）                            | 用户接受的设计，不修改     |
| A07  | Android：PPT预览按钮遮挡标题（F026第1页）                           | 用户接受的设计，不修改     |
| A08  | Android：加密Word错密/重试的提示显示                                | 原问题修复并复测通过       |
| A09  | Android：Word目录条目的页码字段（F143目录）                         | 原问题修复并复测通过       |

## 来源与适配

- 长 Word：直接保留 Electron `apps/docs/src/renderer/file-actions.ts` 的 `PHASED_APPEND`、`TRACK_IGNORE`、`TABLE_TRAILING_SKIP` 事务标识，避免尾部被静默拒绝。
- 密码：原样复制 `PasswordDialog.tsx`、`PasswordInput.tsx`、`icons.tsx`；样式仅抽取原密码表单相关规则，宿主异步等待与取消为薄适配。HTTP、独立上传页与 Android 使用同一 HTML 组件。
- Word 显示：复用 `viewerLayout`、`measureBlocks`、`prepareFlow`、`sliceFlow`、`PaginationPreview`、`HeaderFooterArea` 及 `toc-refresh`；HTTP 输入仍是实际服务端解析模型，没有回退为原文件在浏览器重解析。默认打印、可切阅读，与 Electron 对应模式对比。
- 为使用同一个 Electron 文档布局，HTTP 客户端按顺序取齐正文块后交给同一个只读编辑器；服务端仍流式解析并保持资源 URL。原先仅按连续阅读窗口挂载单元的客户端路径被统一文档布局替代，内存行为需实测，不以纯函数测试代替真机。
- OLE：服务端媒体已从 slim ZIP 移走时保留原 EMF/WMF 预览的资源引用，客户端调用上游同一 `metafileToDataUrl` 转换器。该分支只作用于已经提供 `mediaUrl` 的远程解析；Electron 原文件解析路径不变。
- PPT：复用私有快照中原字体扫描/解析/回退与 SFNT 单字面导出；构建时按原解析器导出字体选择和度量快照，客户端测量与绘制加载对应字体。Node 服务端同样使用原度量及字体资源，HTTP 字体路由与离线 bundle 携带这些数据。恢复 `packages/pptx-render/src/text-layout.ts` 与 v0.13.18 一致的符号处理。
- 私有 Node 边界修正 `opentype.js` 的 CJS/ESM 导入，以及原 HarfBuzz 1.5.0 的工厂/WASM 路径；不改字体选择算法。该依赖与下载项目实际安装版本一致。

## 测量校正

原 W03 记录的桌面纸顶 y=32 与44差距，复查 JSON 后确认 Electron 当时 scrollTop=12，目标为0；它不是纸外 padding 的缺陷。本轮保持源44px规则。正文额外位移及页眉入流问题已修复；恢复源 row-fill 装饰后，Web/HTTP连续阅读仍有小数累计差异，严格验收保留W03/S03。

PPT已重新启动未修改的基线并等待字体/页面稳定；保留原审计证据，区分请求字体名与实际有效字体。三路线30例模型比较的框误差<1e-12px，行数/逐行内容/有效字体差异均0；Android另做实机截图对照。

## 实测结果与限制

原22条范围中18条已按原问题复测关闭；W03、S03、A03、A05原主要问题修复，仍保留4条严格细节残余，未判定最终验收通过。用户接受的6条设计不改。详细记录、全部课件路径、复现步骤与证据见 [修复复测报告](/Users/dddd/Downloads/genoffice-v0.13.18-audit/repair/修复复测报告.md)。

- Web本地与真实HTTP：F002 17页/145块、F015 27页/365块、F133 25页/414块、F143 20页/247块、F009 15页/104块。实际末页滚动、正文与页脚独立核对；F143物理页20显示“第16页 共16页”。长正文不再截断64块。
- Android ABGBB24402203309 / Android12 / WebView114.0.5.302，2000×1200横屏：上述Word实际在线验证，PPT F011第6–7、F027第3、F152第1/3/5、F018第20页分别验证。下载后移除本轮USB映射复测PPT/Word离线资源。以真实WebView结果为准，不用桌面代替。
- 密码Agile/Standard×本地/HTTP/独立上传，Chrome与Android各6例原HTML表单、错误重试、正确密码继续通过；Chrome取消并再次打开2例通过。
- Viewer 186测试通过；Server 487通过/91跳过；DOCX Engine 2237通过/1跳过；PPTX Render 433通过。类型、变更源文件定向lint、format通过。数据库门控跳过不算真实数据库通过；HTTP实际链路另有请求/画面记录。

## 来源与宿主适配补充

- 字体快照直接调用原Node字体解析器/SFNT导出器及HarfBuzz度量，保留核心token一致性检查；私有依赖harfbuzzjs1.5.0与下载基线实际版本一致。Word在blocksToPmDoc前加载原字体/stand-in，并安装原familyVerticalMetrics provider，避免表格初始化时固化替代字体尺寸。
- `viewer-layout.ts`的`modernAnchorFloats`来自基线App.tsx:3896–3900；`docx-page-pass.ts`装配原planByElement、measureBlocks、prepareFlow、sliceFlow及setRowFills。未启用docGrid时不给原canvas注入占位pitch，否则会影响原lineLeadPx计算。表格split-row fill既影响打印也影响阅读，沿用源装饰与稳定重测。
- Android WebView114不支持原CSS round()表达式，调用原snapLineToPitch数值实现并保留pt→px单位转换。图片只改为共享Blob URL，未重采样。可选visiblePages只挂载邻近原页面JSX，所有原页盒子和分页切点保留；ready/DOM提交/滚动/resize均重新跟踪，避免末页漏绘。来源登记仍保留，未整体取消核心比对。

## 未关闭的严格细节

1. W03/S03/A03：原封面布局修复后，F002 Electron连续阅读总高9804.9296875px，Web/HTTP9801.859375px；首段相对起点差0.0078125px，逐表格/段落小数累计3.0703125px；Android总高9804.921875px，比源少0.0078125px，同样保留严格残余。未将其当作用户接受项。浏览器布局量化只是当前推测，仍需逐项归因。没有按课件写补偿数值。
2. A05：原缺失预览恢复。Android240×82小EMF有1872个像素差异（主要涉及标签文字栅格；白底RGB最大210/255、平均3.09565/255）；8192²大WMF解码像素与源一致，Web/HTTP两张预览PNG字节与源一致。维持原设备Canvas不能承诺逐像素相同；统一渲染PNG会引入渲染服务/部署边界，不静默改造或降级。

本轮是对原清单的针对性修复复测，不声称176文件每页每状态全部重做像素验收。基线6527源文件和课件176文件哈希未变，未提交或推送代码。

Android OLE另以原字体记录扫描器和有界gzip解压做转换前字体预检，字体请求只绑定原字面；Microsoft YaHei UI的源Canvas回退通过CDP确认为PingFang SC。单次worker调用原metafileToDataUrl并在返回PNG后终止，释放大Canvas；源转换器绘制算法/8192²尺寸不变。最新APK冷启动及断网F009都为15页，两个预览在线/离线PNG字节相同。A05的1872像素严格残余按“中”保留，不继续使用早期404像素读数。

根npm run lint会扫描Android生成产物而报错，记录在修复报告；本轮59个变更源文件定向ESLint通过。未改全局lint规则或Electron源文件来回避检查。

HTTP冷加载补充：构建中的v1预览单元可以是带elements的原始slide model。`pptx-remote-session.ts`只发布带nodes的已排版帧；其他单元继续等待ready，不交给源NodeBody绘制，也不提前提示已可预览。已有可绘制首帧能力保留，新增原始模型回归测试。F152真实POST202冷启动已复测通过；Android原生WebView另走server-layout打开F018第20页，fonts=loaded、alerts=[]。这一边界无对应Electron增量传输入口，Electron `apps/slides/src/renderer/App.tsx:876`接收主进程完整open结果；源排版/绘制不变。

页码复核补充：宿主隐藏导出预览组件附带的`pv-pageno`辅助物理号，保留文档原页脚字段，与Electron正常文档视图一致。F143本地/HTTP均为20个物理页、末页“第16页 共16页”，AndroidF002为17页、末页字段17；辅助号均display:none，末页原内容已挂载。证据`footer-final.json`、`android-footer-final.json`及对应截图。
