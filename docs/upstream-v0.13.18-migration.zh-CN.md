# v0.13.18 上游合并与 Viewer 私有包迁移

日期：2026-11-17。目标标签：`v0.13.18`，提交 `ac19c54111849d9d8fb2c508223a0389b805c247`。
共同上游基线：`8c170596b6c2a5fc92a858dfd6f064c7762d835e`；本地起点：`07285b045`。

## 合并方式

先在 `codex/sync-v0.13.18` 隔离工作树合并完整上游标签，再单独提交私有包迁移。
上游合并解决 `.prettierignore`、根 `package.json`、`package-lock.json`、DOCX/PPTX 引擎入口的冲突。
继续采用 pnpm，保留本地流式 DOCX 解析、阅读/样式上下文、嵌入字体读取及 PPTX 按需归档读取接口。
上游 `parseNotesPart` 现返回 notes/separator 对象：流式解析按新接口解构并输出脚注/尾注分隔线，初始化内容控件组序号。

根目录校验工具显式声明 jszip、xmldom 依赖；原脚本直接引用根目录的 HarfBuzz/PDF.js 资源和 tsx 入口，也补齐对应依赖。
Viewer、viewer-renderers、viewer-services 补齐 pnpm 隔离解析所需的直接依赖与类型依赖；开发脚本从所属应用定位 Vite。

## 私有包迁移

- `viewer-renderers`：对原快照做三方迁移，更新 Word 编辑器 schema、字体规则、表格宽度、页眉页脚、脚注及分页基础模块；包含新增模块和传递资源。PPT 绘制/动画/变形及 PDF 批注、目录、搜索模块同步。
- `viewer-services`：同步字体发现、字体宽度及 shaping 帮助模块，保留仅抽取媒体/解密帮助函数的边界。
- 来源清单标记目标标签，并说明只读、远程媒体、连续阅读等适配；README 对应更新。
- Viewer 接入新的 `text-layout/font-rules`、文档文字上下文与静态字体解析入口；缺失主题字体继续使用自带 SC 字体，切换文档清理上下文。
- 本地、服务端和 Android 离线 PPT 排版的浏览器字宽反馈区分 kerning 模式；canvas 绘制安装上游字偶距设置，避免排版与绘制使用不同规则。
- 解析指纹覆盖字体度量源码/测量数据、word-faces 和私有服务源码，避免仅修改这些内容时复用旧缓存。

现有 Word **连续只读阅读**、PPT 媒体重试/限流/资源回收、PDF 旧内核入口、Android 离线校验与回放均保留。
Word 连续阅读不显示 PAGE/NUMPAGES/SECTIONPAGES 的纯页码页眉页脚。

同步的桌面功能（旧 DOC/PPT 转换入口、MP4 导出、PDF 编辑/打印等）不等于新增了 Viewer 的操作入口。
当前 Viewer 仍按其原有三格式和只读边界工作。

## 回归与证据

证据前缀：`/tmp/genoffice-v01318-`；浏览器/设备结构化证据目录：`/tmp/genoffice-v01318-validation/`。

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 共享字体度量 | 62 通过 | `engines-tests.log` |
| PPTX 解析 | 1335 通过，1 跳过 | `engines-tests.log` |
| PPT 渲染 | 432 通过 | `engines-tests.log` |
| DOCX 解析 | 2236 通过，1 跳过；新增流式脚注回归另行通过 | `engines-tests.log`、`reading-context-tests.log` |
| 私有 Viewer 类型/单测 | 144 通过 | `delivery-types.log`、`viewer-tests-delivery.log` |
| 服务端真实依赖 | 572 通过，0 跳过 | `server-real-tests-verified.log` |
| 字体/表格/分页规则门禁 | 通过 | `font-rules.log`、`table-rules.log`、`page-cut-rules.log` |
| Viewer 生产包/静态边界 | 通过 | `viewer-package-final.log`、`standalone.log` |
| 三格式入口 | 6 场景通过，拒绝 12 个旧入口 | `preview-entry.log` |
| 三格式界面 | 明暗主题、320/375/768/1440px、短视口、触控及嵌入通过 | `ui.log`、`validation/ui/` |
| Word 连续阅读 | 15 场景通过 | `validation/word/browser-report.json` |
| PPT 缓存重开 | 像素差异 0 | `validation/pixel.json` |
| Android 构建/原生 | 新 APK 构建、安装；50 项通过 | `android-build-delivery.log`、`android-install-delivery.log`、`android-native-delivery.log` |
| Android Word / PDF | Word 5 组在线/离线通过；PDF 冷启动、SHA-256、Range 206 通过 | `validation/android-word-accepted/`、`validation/android-pdf-accepted/` |
| Android PPT / 音视频 | 50 页离线重开、40 次跳页通过；13 个音视频的 Range/播放/seek，以及在线/离线音频预览与放映触控通过 | `validation/android-pptx-delivery.json`、`validation/android-media-reused/device-results.json` |
| Docker 精简镜像 | 构建及三格式 HTTP 检查通过；XML 解析依赖实为 5.12.1 | `docker-build-accepted.log`、`validation/docker-smoke.json` |

内置浏览器两次连接超时，本轮浏览器证据使用项目 Playwright 脚本驱动本机 Chrome；不宣称已通过内置浏览器验收。
真实数据库使用本轮独立 MySQL/Redis Unix socket；业务课件为已有本地副本，未向外部服务上传。
设备断网检查移除本轮 USB 后端映射，不能视为关闭设备所有网络。媒体静音检查证明解码/播放推进，不证明可听音质。
本轮不是一小时长稳、生产容量或与 Office 逐像素保真的验收。

Android Word 回归原脚本仍使用分页选择器，本次改为当前连续阅读流程：逐源单元遍历到尾、脚注尾注、图像/外部请求、只读约束、零纸张页/页码控件，以及独立单元格文本零遗漏/零重复；保留包完整性、断开后端和在线/离线字体一致性检查。

服务端增加字偶距回归后的一次全套复跑中，共享构建协调器的 1 秒等待在并发负载下超时（571 通过、1 失败），原始日志 `server-real-tests-final.log` 保留。未放宽断言或产品超时；使用 `--maxWorkers=2` 重跑完整 572 项通过。

PDF 设备探针原来强依赖 `server` 查询参数，统一同源入口已省略此参数；本次探针使用 `location.origin` 默认值，继续验证 206、ETag、Content-Type 和原文件头部字节，原 404 失败记录保留在 `android-pdf.log`。

PPT 50 页离线演练发现客户端仍对本地会话发送远端进度心跳，产生 404。最终在统一客户端进度更新入口跳过保留的 `local` 会话：本地回放无远端租约/偏好存储，阅读锚点仍保存在 localStorage；真实远端会话继续发送带鉴权的心跳，单测分别验证两条路径。最终不修改 Android 宿主协议，也不把 404 加入错误忽略列表。原失败报告保留为 `validation/android-pptx-failed.json`。

远程样式上下文同时携带脚注/尾注编号格式，防止逐单元编辑器初始化恢复默认编号。新增单测和实际浏览器样本确认大写罗马脚注为 `I`、十进制尾注为 `1`（`validation/note-numbering.json`）。

Docker 生产/验证镜像同步复制新的指纹输入（字体源码、测量数据、word-faces 与私有服务源码），并固定到本轮实际测试的 fast-xml-parser 5.12.1，防止源码可运行但精简镜像启动缺文件。


媒体诊断保留了原先连续创建/销毁原生播放器时，3138×1602 的 `media5.mp4` seek 超时的记录，单资源冷启动与旧 APK 基线对照也保留。最终探针按音频/视频各复用一个播放器、完成后移除一次性事件监听并清除超时；在同一进程内按原次序检查全部 13 个资源，仍使用原来的 20 秒元数据/10 秒 seek/10 秒播放预算与 Range/时间推进断言，没有跳过资源或强制转码。完整新 APK 复跑通过。此结果不宣称任意数量原生播放器实例的压力测试通过。

本轮媒体实际 UI 触控选中的是音频对象，在线/离线预览和放映均可达并持续推进；8 个视频资源的检查为实际解码、尺寸、Range 与中段 seek，不外推为逐个视频对象均完成 UI 触控。

最终安装 APK 与构建文件 SHA-256 一致，见 `validation/apk-identity.json`；结构化检查索引为 `validation/verification-index.json`。最终恢复 USB 映射，停止本轮独立 HTTP、数据库与容器验证进程，不清空设备应用数据。
