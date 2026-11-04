# GenOffice 解析后端接入与 1GB 大文件架构设计

状态：设计草案 v1.3。基线：当前 `main`（2026-11）。修订记录见附录 E。

实现状态（第一批，已落地）：

- `packages/parse-contract`：契约类型 + `decideProvider` + 单测（13 项）。
- `packages/zip-reader`：纯随机访问 zip 目录读取（从 `docx-engine/zip-splice` 抽出，docx-engine 全量测试通过）。
- `apps/parse-server`：`GET /v1/health`、`GET /v1/capabilities`、流式上传 + 内容寻址存储、`GET /v1/files/:id/content`（Range/ETag/HEAD）、元数据与删除；单测 8 项。
- PPTX 会话 API：`POST /v1/sessions`、`GET /v1/sessions/:id`、`GET /v1/sessions/:id/units`、`GET /v1/sessions/:id/units/:unitId`、`DELETE`；服务端用 `openPptx` + `buildRenderSlide`（启发式度量）按 slide 返回 `RenderSlide` + playback；单测 6 项。
- 解析位置：Viewer dev server 把 `/v1` 同源代理到 parse-server，因此常用链接只需 `?parse=server&fileId=<fileId>`；auto 模式对 >64MiB 的 PPTX/PDF 走服务端、小文件留本地；DOCX 超过 32MiB 明确报错“大 DOCX 暂不支持”。Viewer 的 1GiB 门槛已覆盖已知扩展名的本地文件（打开前检查 `file.size`）。
- 字体：会话返回 `ppt/fonts/*.fntdata` 中的嵌入字体列表，`GET /v1/sessions/:id/fonts/:fontId` 返回 sfnt；Viewer 同时加载内置度量字体（Carlito/Caladea/Liberation/Noto）和嵌入字体，再进入字宽回传。极老的字体可能被 Chromium OTS 拒绝，回退到替代字体并输出 warning。
- 字宽回传：`POST /v1/sessions/:id/text-widths` 接收浏览器实测宽度，服务端清空缓存 render tree、重排已加载页并返回剩余 `measurements`；Viewer 在首屏、懒加载页和放映预加载后都跑同一测量循环。
- 媒体流式/GC：parts 路由对 stored part 直接切片并支持 Range/HEAD，deflated part 流式解压；`DELETE /files/:id` 对活跃会话返回 409；周期 GC 清理过期未引用内容、执行容量上限并清临时文件。
- 指标：`GET /metrics` 输出 Prometheus 文本格式（请求/响应计数、duration histogram、errors、uploads/bytes、sessions/workers、storage、uptime、process memory）。
- 持久化/可观测：会话元数据原子写入 `<dataDir>/sessions.json`，重启后 model/units 可读、worker 懒重建；每个请求一行 JSON 日志；`/v1/health` 暴露 sessions/activeWorkers/requests/errors/uploads/bytes/parseTimeouts/tooManySessions/memory。
- 稳定性：每个 PPTX 会话一个 `worker_threads` worker，`openPptx`/`buildRenderSlide` 不在 HTTP 事件循环；超时/内存超限直接 terminate，返回 `504 parse_timeout`，`/v1/health` 不受影响；并发会话上限返回 `429`。
- PPTX 大文件：`slimPptxFile` 用 `@genoffice/zip-reader` 只把非媒体 part 复制成 stored-only zip 给解析器，`ppt/media/*` 留在磁盘、由 `GET /v1/files/:id/parts/:partPath` 按需返回；`maxParseBytes` 限制的是 slim 后的 XML 总量。实测 256MiB 媒体 deck 建会话 ~22ms、RSS +0.5MiB。
- Viewer 远程模式（MVP）：文件栏 `解析位置：自动 / 本地 / 服务端`（配置 `?server=` 时默认 auto）；`?server=http://…&parse=server` 上传 PPTX 后由服务端建会话，`Slides` 通过 `createRemotePptxSession` 懒加载：`open` 只取 model + 第一页，翻页/可见缩略图按需 `loadUnit`，放映前再补齐剩余页；PDF 直接把 `GET /v1/files/:id/content` 交给 PDF.js（服务端已支持 Range/ETag/HEAD）；Viewer 构建通过（13 项既有测试）。
- 压力冒烟：`npm run stress -w @genoffice/parse-server -- --url ... --size 1G --sessions 6`；1GiB 媒体由 slide 1 引用，实测 6 并发会话全部 201、媒体 HEAD 200/Range 206、parts 请求前后 RSS 364MB→364MB、超时注入 504 后 health 仍 200。
- 1GB 上传冒烟：本机 loopback，867MB/s，服务端峰值 RSS ≈103MB（`apps/parse-server/scripts/upload-smoke.mjs`），证明上传路径不整份缓冲。

未实现/已知限制：PPTX 媒体中 stored part 已支持 Range，deflated part 仍整段返回；首帧仍用启发式度量直到浏览器宽度返回、放映会先补齐所有页；token 模式已改为 HMAC 签名 URL（`exp`/`sig`），`<img>`/PDF.js 无需 Authorization；服务器化（租户/存储驱动/可观测性）未做。

范围（v1.3，已确认）：

- **只做 Viewer（`apps/viewer`，Web）**；后端将来部署到服务器。
- **后端解析只做 PPTX / PDF**。
- **DOCX 本期不做后端解析**：Viewer 保留现有本地 DOCX 预览（小文件），大 DOCX 明确提示不支持；后端 DOCX（流式 + 分页虚拟化）整体推迟，预留设计见附录 F。
- **不接 XLSX**；不做桌面端（Electron）集成；不做独立 Markdown/HTML Viewer。
- 1GB 目标落在 **PPTX / PDF**；PPTX 是首要大文件格式（§6）。

相关文档：[Web Viewer 移植调研](web-viewer-migration.zh-CN.md)、[Viewer 需求](../apps/viewer/REQUIREMENTS.zh-CN.md)。

---

## 0. 结论（TL;DR）

1. **不要做“整篇文档要么前端解析、要么后端解析”的二选一。** 解析是一条流水线，其中只有一部分阶段可以搬到后端：

   ```
   ① 容器索引(zip/pdf 目录)  ② XML/字节 → 文档模型  ③ 版面/渲染树  ④ DOM 测量/分页  ⑤ 资源解码
   ```

   ①②③ 可以放后端；④ 必须在浏览器（PPT 换行依赖浏览器实测字宽；DOCX 分页也依赖 DOM，但本期不做 DOCX 后端）；⑤ 两边都可，但应走 URL + Range 按需取。

2. **切换的最小单位是“解析阶段 + 字节来源”，不是“文档”。** 后端返回的是**按单元（slide / pdf page）寻址的模型 + 资源引用**，前端仍用现有组件渲染。这样 1GB 文件不需要整份进内存，切换也不会导致两套渲染实现。

3. **字节永远不进 JSON / IPC。** 上传走流式分片落盘，读取走 `Range` 206；后端进程内任何时刻只持有“窗口”而不是整份文件。这条在仓库里已有惨痛先例：`apps/docs/src/main/byte-handoff.ts` 的注释记录了 IPC 回复序列化把主进程在 1GB 文件上打爆。

4. **解析必须跑在独立进程里并带硬内存上限。** 一个 job 的 OOM 只能杀死这个 job，不能杀死服务。服务端用 `child_process.fork` 子进程池（`--max-old-space-size` + RSS watchdog）。本期没有 altChunk/Chromium 依赖（那是 DOCX 专属，已推迟）。

5. **契约先行：`packages/parse-contract` 定义唯一 DTO，本地 Provider 与远端 Provider 各自实现。** 前端 UI 只认 `DocModel / Unit / AssetRef`，不关心解析在哪发生。没有这份契约，“自由切换”会退化成两套 if-else 和两套渲染 bug。

6. **后端形态：新增独立 `apps/parse-server`（Node 22 + TypeScript），部署到服务器；Viewer 静态站 + remote provider，浏览器 Worker 本地解析作为小文件/离线路径。** 同一份契约、两种 Provider；**不做桌面端集成**。

7. **1GB 目标是 PPTX / PDF。** PPTX 靠“随机访问 archive + 按 slide materialize + 媒体外置 + 字宽回传”接住（1GB 主要是媒体）；PDF 靠 HTTP Range + PDF.js 渐进加载。**DOCX 1GB 本期不做**——它需要“后端流式 tokenizer + 前端分页虚拟化”两件大工程，已整体推迟（附录 F）。

8. **资源不抽取、按 range 读。** 图片默认留在原容器（pptx 的 zip entry、PDF 对象；DOCX 本地预览同理），后端只发 `AssetRef`（fileId + partPath + sha256），URL 支持 Range；缩略图/转码等派生资源单独缓存。**不要**把媒体 base64 进 JSON，也**不要**在上传时把媒体全部解压另存。详见 §5.10。

9. **范围收窄的代价要明说**：不做桌面端意味着没有“本机路径授权”这条捷径，服务器模式只能上传；不做 DOCX 后端意味着大 DOCX 在 Viewer 里只能明确提示不支持（不能静默失败）；不接 XLSX 意味着 `XlsxSidecarClient` 与 `MAX_RANGE_CELLS` 等现有能力本期不接；不做 MD/HTML 意味着资源包语义本期不做。相关章节保留现状描述仅作参考。

---

## 1. 现状：解析位置因格式而异

| 格式                             | 当前解析位置                                    | 入口                                                      | 字节形态                   | 主要问题                                                                                           |
| -------------------------------- | ----------------------------------------------- | --------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| DOCX（本期仅本地预览，后端不接） | Viewer：浏览器 Worker                           | `parseDocxOffThread` → `packages/docx-engine` `parseDocx` | 整份 `Uint8Array`          | `JSZip.loadAsync` + `document.xml` 全量字符串 + `ParsedDoc` 保留 bytes；大文件必炸，本期不做后端化 |
| PPTX                             | Electron：主进程；Viewer：浏览器 Worker         | `openPptx` + `buildRenderSlide`                           | 整份 `Uint8Array`          | `JSZip.loadAsync` 持有整包压缩字节；`openPptx` 打开时解析全部 slide；渲染树 JSON 可能很大          |
| XLSX（本期不接）                 | Electron：主进程 + Rust sidecar；Viewer：不支持 | `XlsxSidecarClient.open` + `read_range`                   | 文件路径（sidecar 自己读） | 现有实现是稀疏读取，但本期范围不含 XLSX；仅作参考                                                  |
| PDF                              | 渲染进程 PDF.js                                 | `PdfPage.tsx`                                             | blob URL / ArrayBuffer     | Viewer 先整份读入再建 blob；本可 Range 渐进加载                                                    |
| MD / HTML（本期不接）            | 渲染进程                                        | 各 app 的 renderer                                        | 文本 / 目录资源            | 外部资源解析需要目录语义；本期不做                                                                 |

两套实现并存，且已经出现漂移：桌面端（Electron）与 Viewer 各有一份解析/渲染代码，Viewer 用 `packages/viewer-renderers` 的源码快照（`apps/slides/src/shared/ipc.ts` 1921 行 vs Viewer 快照 1900 行）。同一个格式在两边也不完全一样：

- PPTX：桌面端在**主进程**解析并 `buildAllRenderSlides` 全量构建，字宽用 `webContents.executeJavaScript` 回传；Viewer 在 **Worker** 里跑同一引擎，媒体 >72KB 用“descriptor head + 按需字节”避免大图 OOM。
- PDF：桌面端把整份 `ArrayBuffer` 过 IPC 给 renderer；Viewer 直接 `getDocument({url})`。
- DOCX：桌面端有 512MB 上限和大文档分级；Viewer 只有 1GiB 入口上限，中间区间没有分级（未验证）。
- altChunk：桌面端走隐藏窗口 `html2docx`；Viewer **明确硬失败**（`apps/viewer/src/web/docs.tsx:100-104`）。

这些差异说明：契约必须同时覆盖“主进程宿主”和“浏览器宿主”，不能只按其中一边设计。

关键结论：

- **解析器本身大多已经与 Electron 解耦**：Viewer 已经在浏览器 Worker 里跑 `pptx-engine`（配 `node:crypto`/`node:zlib` 的浏览器 shim）和 `docx-engine`。所以“后端解析”不是重写解析器，而是**换宿主 + 换 I/O + 加内存纪律**。
- **真正缺的是三样东西**：统一的解析结果契约、可随机访问的字节源（`ByteSource`）、以及一个不会整份读入的解析执行环境。
- 仓库里已经有一半的答案：
  - `packages/docx-engine/src/zip-splice.ts` 已经定义了 `ByteSource { size; read(offset, length) }` 和 `readZipEntries(src)`，注释写明“1 GB 文档只花它 XML part 的读取量”。但该文件顶部 import 了 `node:fs/promises` 和 `node:zlib`，目前是 Node-only。
  - `packages/zip-gate` 的计量式解压（`assertZipInflatesWithinLimits`，逐 part 取消在 `declared + 1` 字节）是浏览器/Node 共用的，直接可复用。
  - `packages/docx-engine` 的 `slimDocx` + lazy media 占位符已经把“媒体不进主流程”做出来了。
  - `xlsx-sidecar` 的 session + `read_range` + 取消 + 进程退出监听，就是后端大文件会话该有的样子。

### 1.1 现状上限（决定“多大算大”）

| 位置                        | 上限                                                                                      | 证据                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 桌面 DOCX 打开              | 512MB（Word 的 .docx 上限口径）；>230k 权重进入大文档分级                                 | `apps/docs/src/main/docs-main.ts:3946`；`apps/docs/src/renderer/large-document.ts:16-34`      |
| Viewer 打开                 | 1 GiB 只拦 URL 与“无扩展名需嗅探”的本地文件；**已知扩展名的本地文件直接放行、不检查大小** | `apps/viewer/src/web/host.tsx:18,78-83,93,107`                                                |
| 桌面 PPTX 打开              | **无上限**（1GB 会直接尝试）                                                              | `apps/slides/src/main/slides-main.ts:924`（grep 无 `MAX_OPEN_BYTES`）                         |
| 桌面 PDF 打开               | 单文件无上限；合并 1GiB                                                                   | `apps/pdf/src/main/pdf-main.ts:1225-1231,1160`                                                |
| XLSX 单次范围（本期不接）   | 100,000 单元格；默认 30s / 归档 180s 超时                                                 | `apps/sheets/src/shared/desktop-api.ts:58`；`apps/sheets/src/main/xlsx-sidecar-client.ts:5-7` |
| XLSX JS gateway（本期不接） | 总解压 256MiB（先 `readFileSync` 再拒绝）                                                 | `packages/xlsx-gateway/src/gateway/xlsx-gateway.ts:153-157,2162`                              |
| XLSX 重算（本期不接）       | 64MB 文件或网格单元格超限即跳过                                                           | `apps/sheets/src/renderer/univer-sync.ts:2565-2575`                                           |
| zip 解压                    | 10000 parts / 单 part 512MB / 总 1.5GB（计量解压，允许诚实解压 1.5GB）                    | `packages/zip-gate/src/index.ts` `DEFAULT_ZIP_LIMITS`                                         |
| PDF 单页位图                | `MAX_PAGE_RENDER_PIXELS` 限制                                                             | `apps/pdf/src/renderer/PdfPage.tsx:88-94`                                                     |
| 附件文本抽取                | 整份 `readFile` + `maxChars` 预算（PDF 无大小上限、无字符预算）                           | `packages/file-parse/src/parse.ts:96+`；`pdf.ts:138-186`                                      |

注意两点：

1. **Viewer 的 1GiB 门槛并不覆盖已知扩展名的本地文件**：`host.tsx:78-83` 对这类文件直接交给 blob URL，不做任何大小检查；所以“1GB 文件被接受”不等于“被检查过”。真正会拦的是 URL（先看 `Content-Length`）和无扩展名本地文件（读完后才比 `bytes.length`，大文件仍会先读进内存再拒绝）。
2. **即便被拦，1GiB 也只是“接受上限”，不是“能解析上限”**。`REQUIREMENTS.zh-CN.md:194` 把大文件内存列为“尚未确定量化指标”；`apps/viewer/IMPLEMENTATION_STATUS.md` 也记录 M1“大文件在客户设备上的内存占用尚未量化”。100MB–1GiB 区间目前没有分级策略（未验证实际行为）。

### 1.2 现有接缝的成熟度（能不能直接承载切换）

| 接缝                                                  | 位置                                                                                                                                 | 能否承载“本地/远端”切换                                                                                  | 最小改造                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 字节 handoff URL                                      | `apps/docs/src/main/byte-handoff.ts:44-63` + `apps/docs/src/renderer/doc-bytes.ts:2-6`                                               | **能**。它已经是“字节用 URL 取”，服务器文件路由可以直接替换一次性 token                                  | 只换 URL 来源与 TTL 语义，渲染进程不改                                                  |
| `parseDocxOffThread(bytes) → ParsedDoc`（本期仅本地） | `packages/viewer-renderers/src/docs/renderer/parse-off-thread.ts:65-91`                                                              | 函数级可换 Provider，但 `ParsedDoc` 带 Map/typed array/`internal.originalBytes`，不能 JSON；本期不接后端 | —（推迟到 DOCX 后端版本）                                                               |
| `XlsxSidecarClient`（本期不接）                       | `apps/sheets/src/main/xlsx-sidecar-client.ts`                                                                                        | NDJSON + version + requestId + 超时/取消，传输无关                                                       | 仅作协议设计参考                                                                        |
| `SlidesDataSource`                                    | `packages/viewer-renderers/src/slides/renderer/data-source.ts:3-12`                                                                  | **不够**：只抽象播放元数据/媒体字节，不抽象解析与 RenderSlide 下发；桌面端还绕过它                       | 扩成 `open(source) → {slides, fonts, measurements}` + `submitWidths()`                  |
| `OpenResult`                                          | `packages/viewer-renderers/src/slides/shared/ipc.ts:91-98`                                                                           | 能（纯数据，已跨 IPC）                                                                                   | 与 `PptxDeck` 合并成版本化 session-open 响应                                            |
| `window.slidesApi`                                    | `packages/viewer-renderers/src/slides/shared/ipc.ts:1309+`                                                                           | **不能**：读写混在一个 500+ 方法接口，组件直接调 `window.*`                                              | 拆只读端口，组件改注入                                                                  |
| `BrowserDriver`（本期不接）                           | `packages/viewer-services/src/docs/driver-contract.ts:27-46`                                                                         | 仅 DOCX altChunk 需要；本期不做 DOCX 后端                                                                | —                                                                                       |
| 外部资源协议                                          | `md-asset://`（`apps/markdown/src/main/markdown-main.ts:734-770`）、`html-asset://`（`apps/html/src/main/preview-document.ts:1-20`） | **能**：它们已经是“按文档目录解析相对资源”，且带路径边界检查                                             | 换成 HTTP 资源路由 + manifest；路径语义不变                                             |
| 桌面路径授权                                          | `apps/pdf/src/main/pdf-main.ts:1225-1231`（per-window path grant）                                                                   | 本期不适用（无桌面端）；仅作“路径授权”模式参考                                                           | —                                                                                       |
| 临时资源清理                                          | `apps/sheets/src/main/temp-files.ts:1-58`、`apps/docs/src/main/docs-main.ts:4172-4210`                                               | 能：TTL + 文件名形状约束 + 启动清扫，可直接搬到后端 temp/cache                                           | 复用目录/模式，换成 jobId                                                               |
| 格式路由                                              | `apps/viewer/src/web/host.tsx:20-44,189-194`、`preview.tsx:35-41`                                                                    | 能：给 iframe 多加一个 `session=` 参数即可                                                               | 三个 preview 组件同时接受 blob URL 与 session URL；本地小文件仍走 blob，不需要传 `File` |

仓库里**不存在** `ViewerDataSource`（只出现在 `docs/web-viewer-migration.zh-CN.md:210` 的计划里）；桌面端与 Viewer 之间也**没有共享的解析结果契约**——Viewer 用的是 renderer/engine 源码快照（`packages/viewer-renderers` 与 `apps/slides/src/shared/ipc.ts` 已出现 1921 行 vs 1900 行的漂移）。这既是风险，也是本文要补的第一块地基。

> 本期只做 Viewer，上表中 `window.slidesApi`、桌面路径授权、桌面端切换接缝**不在范围内**，保留仅为说明“为什么不能直接复用桌面实现”。

---

## 2. 核心设计判断

### 2.1 切换点：阶段可迁移，而不是文档二选一

把解析拆成阶段后，各格式的可迁移性如下（✓ 可在后端，△ 可但收益低，✗ 必须在浏览器）：

| 阶段            | PPTX                 | PDF              |
| --------------- | -------------------- | ---------------- |
| ① 容器索引      | ✓ 随机访问 zip 目录  | ✓ 无需解析       |
| ② 字节 → 模型   | ✓ 按 slide 解析      | ✓ 无需解析       |
| ③ 版面/渲染树   | ✓ `buildRenderSlide` | ✗（PDF.js 自绘） |
| ④ DOM 测量/分页 | ✗ 字宽必须浏览器实测 | ✗                |
| ⑤ 资源解码      | ✓ 按需               | ✓ Range          |

> DOCX 本期只保留 Viewer 的本地预览，不进远端流水线；它的阶段划分见附录 F。

因此契约里必须显式记录“哪些阶段已在后端完成、哪些仍待前端”：

```ts
type ParseStage = 'index' | 'model' | 'layout' | 'measure' | 'pagination'
interface DocModel {
  stagesDone: ParseStage[]
  stagesPending: ParseStage[] // 前端据此决定挂哪个组件/走哪条渲染路径
}
```

> 这也是为什么“后端负责解析文档、前端负责渲染”能成立：后端做 ①②③ 和资源，前端做 ④ 和绘制。若强行把 ④ 也搬到后端（比如服务端浏览器分页），就会引入字体/视口/版本三重漂移，且与仓库“沿用原渲染方式”的验收口径冲突。

责任划分（对外可以这样表述）：

| 角色             | 负责                                                                                | 不负责                                             |
| ---------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| 前端（浏览器）   | 渲染、DOM 测量/分页、字体加载、交互、按需取资源、本地小文件解析（含 DOCX 本地预览） | 大文件整份读入、CPU 密集解析的可靠性               |
| 后端（解析服务） | 容器索引、XML/字节 → 模型、PPT 版面、缓存、限流与隔离                               | DOM 分页、最终绘制、字体实测（必须回传浏览器结果） |

### 2.2 字节不进 JSON，也不进 IPC

所有跨进程/跨网络的数据分三类：

| 类别       | 传输方式                                                | 约束                                          |
| ---------- | ------------------------------------------------------- | --------------------------------------------- |
| 原始文件   | 上传：流式分片落盘；读取：`GET /files/:id?range=` + 206 | 服务端不 `Buffer.concat` 整个 body            |
| 派生模型   | JSON（按 unit 分页返回）                                | 单响应 ≤ 1–2MB，超出必须分页/游标             |
| 二进制资源 | `GET /sessions/:id/assets/:assetId` + Range + ETag      | 图片/音视频/字体全部外置，绝不 base64 进 JSON |

现有 `byte-handoff.ts` 的教训要制度化：任何“把整份字节塞进 IPC 回复 / JSON / base64”的路径，在大文件上都是事故。

### 2.3 一个契约，两种宿主

```
packages/parse-core (同构)          apps/viewer (浏览器 Worker)      apps/parse-server (服务器)
  ByteSource / zip reader /         LocalParseProvider               RemoteParseProvider 的服务端
  XML→model / layout 纯函数   ──►   小文件/离线（PPTX/PDF/DOCX）──►    按 unit 返回模型，部署在服务器
```

- 解析函数保持纯：输入 `ByteSource` + options，输出模型片段；不直接读 `fs`、不直接 `fetch`。
- 本地小文件直接读 `bytes`（阈值内）；服务端 `ByteSource` = `fs.promises.FileHandle.read`；远端 = HTTP Range（带本地缓存）。
- 这样“切换”只是换一个 Provider/宿主，PPTX/PDF 的算法与 DTO 不变；DOCX 本期只有本地 Provider（无远端实现），不参与切换。

### 2.4 隔离与内存纪律

- 每个解析 job 一个独立子进程（`child_process.fork`），`execArgv: ['--max-old-space-size=1024']`，一次只跑一个 job。
- 500ms 采样 RSS，超硬上限直接 `SIGKILL`，job 标记 `out_of_memory`，服务继续。
- 原生内存（zlib、WASM）不计入 V8 heap，所以**不能只靠 `--max-old-space-size`**；必须同时有 RSS watchdog 和容器/cgroup 级限制。
- 已有先例可参考：`byte-handoff` 的 TTL/上限驱逐、`zip-gate` 的计量解压、`xlsx-sidecar` 的进程退出恢复（本期不接 XLSX，但模式可复用）。

### 2.5 缓存落盘，内存只放元数据

派生结果（slide 渲染树、文本抽取、缩略图、转码媒体）写入磁盘缓存：

```
<dataDir>/cache/<sha256(file)>/<parserVersion>/<fontSetHash>/<stage>/<unit>.json
```

- 内存里只保留 LRU 元数据 + 少量热单元（总预算如 32–64MB）。
- 缓存键必须包含 parserVersion、字体集 hash、影响排版的选项；否则跨版本/跨字体会复用错误结果。
- TTL + 字节上限 + 启动时清扫孤儿目录（崩溃恢复）。

---

## 3. 统一契约：`packages/parse-contract`

新建 workspace 包，纯类型 + 纯校验，**不 import DOM / Node / Electron**（参照 `packages/viewer-services/src/docs/driver-contract.ts` 的边界写法）。

仓库里已经有几个“解析结果契约”的雏形，契约包应当**收编**它们而不是另起一套：

| 雏形                                          | 位置                                                                   | 收编方式                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `PptxDeck`                                    | `apps/viewer/src/web/pptx-session.ts:1-17`                             | 升级为版本化 `PptxSessionPayload`（slides + playback + fonts + measurements + media refs） |
| PPTX worker op 协议                           | `apps/viewer/src/web/pptx-browser-worker.ts:246-290`                   | 升级为 `ParseWorkerRequest/Response` 的同构版本                                            |
| `ParseWorkerRequest/Response`                 | `packages/viewer-renderers/src/docs/renderer/parse-off-thread.ts:5-12` | 加版本号与 wire 编码器                                                                     |
| `OpenResult`                                  | `packages/viewer-renderers/src/slides/shared/ipc.ts:91-98`             | 合并进 session-open 响应                                                                   |
| `WorkbookFile` + `WorkbookRange*`（本期不接） | `apps/sheets/src/shared/desktop-api.ts:801-842,968-1024`               | 仅作 schema 设计参考                                                                       |

### 3.1 核心类型

```ts
// packages/parse-contract/src/index.ts
export type DocFormat = 'pptx' | 'pdf' | 'docx'
// v1.3：后端只接 pptx/pdf；docx 仅本地 Provider（无远端能力）

export interface FileRef {
  fileId: string
  size: number
  sha256: string
  format: DocFormat
  encrypted: boolean
}

/** 随机访问字节源：本地 File、Node FileHandle、HTTP Range 都实现它。 */
export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
  close?(): Promise<void>
}

export type ParseStage = 'index' | 'model' | 'layout' | 'measure' | 'pagination'

export interface Capabilities {
  parserVersion: string
  /** 远端只应包含 pptx/pdf；本地 Provider 可包含 docx（仅本地预览） */
  formats: DocFormat[]
  /** 每种格式后端能完成到哪个阶段 */
  stages: Partial<Record<DocFormat, ParseStage[]>>
  maxBytes: number
  /** 影响排版一致性的字体集指纹；本地/远端必须一致才能声明等价 */
  fontSetHash: string
  features: {
    lazyAssets: boolean
    rangeRequests: boolean
    fontWidthFeedback: boolean
    streamingUnits: boolean
  }
}

export interface ParseOptions {
  /** 请求后端完成的阶段；缺省由 provider 能力决定 */
  stages?: ParseStage[]
  /** 单个 unit 的序列化上限，超出由 provider 自行切分 */
  maxUnitBytes?: number
  locale?: string
  /** PPT 字宽回传用：前端已加载的字体集合 */
  fonts?: Array<{ id: string; family: string; bold: boolean; italic: boolean }>
}

export type UnitKind = 'slide' | 'pdf-page'

export interface UnitSummary {
  id: string
  kind: UnitKind
  index: number
  /** 稳定锚点：跨本地/远端解析必须一致（PPT sourceId、PDF 页码） */
  anchor: string
  bytes?: number
}

export interface DocModel {
  format: DocFormat
  parserVersion: string
  unitKind: UnitKind
  /** 可为未知：大 deck 在索引完成前不强制给出总数（避免“为了报数先全扫一遍”） */
  unitCount?: number
  /** 某一时刻的快照；渐进状态以 GET /sessions/:id 为准 */
  stagesDone: ParseStage[]
  stagesPending: ParseStage[]
  /** 资源不随模型全量下发：只给数量，资源走 assets(cursor) / asset(ref) */
  assetCount?: number
  warnings: Diagnostic[]
}

export interface AssetRef {
  id: string
  kind: 'image' | 'media' | 'font' | 'altchunk'
  mime: string
  bytes: number
  /** 内容寻址：同一资源跨会话/跨文件去重，也是缓存键 */
  sha256: string
  /** 容器内位置（pptx 的 zip entry、PDF 对象号） */
  partPath?: string
  /** 派生资源（缩略图 / TIFF→PNG / EMF 栅格化 / SVG 重着色）的来源与版本 */
  transform?: { sourceSha256: string; version: string }
  /** 懒加载资源：前端按需 GET，而不是随模型下发 */
  url: string
}

export interface Diagnostic {
  code: string
  severity: 'info' | 'warning' | 'error'
  message: string
  unitId?: string
}
```

### 3.2 Provider / Session

```ts
export interface ParseInput {
  format: DocFormat
  /** 本地解析传 File/Blob；远端解析传已上传的 FileRef */
  source: ByteSource | FileRef
  options: ParseOptions
  signal: AbortSignal
}

export interface ParseSession {
  readonly provider: 'local' | 'remote'
  /** 可能只是“索引已完成”的模型；stagesPending 说明还差哪些阶段 */
  model(): Promise<DocModel>
  units(cursor?: string, limit?: number): Promise<{ items: UnitSummary[]; next?: string }>
  unit(id: string): Promise<unknown> // 按 unitKind 收窄
  /** 资源目录分页：不要假设能一次列全（千张图的 deck） */
  assets(cursor?: string, limit?: number): Promise<{ items: AssetRef[]; next?: string }>
  asset(ref: AssetRef): Promise<Blob | URL>
  /** PPT 字宽回传（仅当 provider 声明 fontWidthFeedback） */
  submitTextWidths?(batch: TextWidthBatch): Promise<void>
  close(): Promise<void>
}

export interface ParseProvider {
  readonly kind: 'local' | 'remote'
  capabilities(): Promise<Capabilities>
  open(input: ParseInput): Promise<ParseSession>
}
```

### 3.3 版本与能力协商

- 每个响应带 `parserVersion`；本地与远端不一致时，前端**不得**把两者结果混用（例如缩略图来自后端、正文来自本地）。
- `fontSetHash` 不一致时，PPT 换行可能不同；UI 必须提示“后端字体集与本地不同，排版可能有差异”，而不是假装一致。
- 契约包提供 `isCompatible(a, b)` 与 `assertModel(model)`（运行时校验，防止服务端升级后前端崩）。

---

## 4. 前端：双 Provider + 路由 + 自由切换

### 4.1 目录与职责

```
apps/viewer/src/web/
  providers/
    local.ts        // 包装现有 Worker：pptx-browser-worker / docs parse-off-thread / pdf.js
    remote.ts       // HTTP 客户端：上传、会话、unit 拉取、asset、SSE 进度
  services/
    parse-router.ts // 决策 + 回退 + 会话生命周期
    upload.ts       // 分片上传、断点续传、hash
  settings.ts       // parseMode: 'auto' | 'local' | 'server'
```

- `LocalParseProvider`：现有 Viewer 链路原样包装，只服务**小文件/离线**场景；大文件一律走后端（PPTX/PDF）。DOCX 后端不支持，超阈值时走 `blocked` 并提示。本地解析仍按现有 `bytes` 入口工作，不强行改 `ByteSource`（这是范围收窄换来的简化）。
- `RemoteParseProvider`：实现 `ParseProvider`，把 `FileRef` 换成 `fileId`，其余 DTO 与本地完全一致。
- `ParseRouter`：唯一知道“用哪个 provider”的地方；渲染组件不感知来源。

### 4.2 决策表（auto 模式）

| 条件                                               | 决策                  | 说明                                                                  |
| -------------------------------------------------- | --------------------- | --------------------------------------------------------------------- |
| 用户选择 `local`                                   | 本地                  | 绝不上传；超限时明确报错，不静默改走后端                              |
| 用户选择 `server`                                  | 后端                  | 后端不可用则报错，不回退（避免“以为上传了其实没有”）                  |
| 格式不在 Viewer 范围（XLSX/MD/HTML）               | 不提供入口            | 本期不接；不要为这些格式做后端解析                                    |
| 文件 ≤ 本地阈值（按格式，见下表）                  | 本地                  | 零上传、零延迟、隐私最好                                              |
| 文件 > 本地阈值且后端**支持该格式**                | 后端                  | 本地大文件内存风险 > 上传成本                                         |
| 后端不可用 / 离线，且文件在本地阈值内              | 本地 + 警告           | 仍可打开                                                              |
| 后端不可用 / 离线 / 不支持该格式，且文件超本地阈值 | **拒绝（`blocked`）** | 明确提示“需要解析服务 / 该格式暂不支持”，**不能**静默回退本地导致 OOM |
| 隐私模式 / 企业策略                                | 本地                  | 策略优先级最高，UI 不得绕过；超阈值同样走 `blocked`                   |

阈值不是拍脑袋：它应由 `Capabilities` 的 `maxBytes`、浏览器 `navigator.deviceMemory`、以及一次启动自检（能否在 2× 文件大小下完成本地解析）共同决定，并且**按格式配置**：

| 格式                | 建议本地阈值                | 依据                                            |
| ------------------- | --------------------------- | ----------------------------------------------- |
| PPTX                | ~64MB                       | 解析峰值 ≈2×文件大小 + 渲染树；**1GB 走服务端** |
| PDF                 | 1GiB（前提是 Range）        | PDF.js 按页渲染，内存与页数/位图相关            |
| DOCX                | ~32MB（仅本地；后端不支持） | 超过即 `blocked` 并提示“大 DOCX 暂不支持”       |
| PPTX/PDF 之外的格式 | —                           | 本期不接 XLSX / MD / HTML                       |

### 4.2.1 格式能力矩阵（首版建议）

| 格式 | 本地能做什么                 | 后端能做什么                | 首版建议                                       |
| ---- | ---------------------------- | --------------------------- | ---------------------------------------------- |
| DOCX | 解析 + 分页（依赖 DOM）      | 不提供（本期）              | 仅本地小文件；超阈值明确提示不支持，不静默失败 |
| PPTX | 解析 + 排版 + 浏览器字宽测量 | 解析 + 排版（字宽回传闭环） | 小文件本地；>64MB 或复杂字体走后端             |
| PDF  | PDF.js，可 Range 渐进        | 只提供 Range/ETag，无解析   | 本地（把整份读入改成 Range）                   |

这张表直接回答“前端负责解析还是后端负责解析”：**不是全有全无，而是按格式和阶段分配**。

### 4.3 切换的 UI 与语义

- 设置项：**解析位置：自动 / 仅本地 / 解析服务**，持久化到 `localStorage`。
- 每文档可临时覆盖：文件栏菜单“用解析服务重新打开”。
- 切换 = **重新开会话**，不是热迁移；阅读位置通过稳定 `anchor` 恢复（页码 + 块锚点），不能用字节偏移。
- 上传需要用户同意：`auto` 模式下首次上传大文件弹一次确认（可记住）；`local` 模式永不弹、也永不传。
- 状态必须可见：文件栏显示“本地解析 / 解析服务”，以及进度、取消、失败原因（超时、内存超限、格式不支持、网络中断）。
- 回退规则：
  - 本地失败（OOM/超时）→ 提示“用解析服务重试”（需用户点击，因为可能上传大文件）。
  - 后端失败 → 若尺寸在本地阈值内，可自动回退本地并提示；否则报错。
  - 决策为 `blocked`（超大且无可用后端）→ 直接报错并给出“启用解析服务 / 仅本地打开会内存不足”的说明，**不自动回退**。
  - 任一回退都不得静默丢失当前阅读位置。

### 4.4 一致性要求（否则“切换”会变成两套结果）

1. **同一 `anchor` 语义**：PPT 用 `sourceId`，PDF 用页码。契约里写死，parity 测试覆盖。DOCX 本地预览沿用 `docxIndex`，不进远端契约。
2. **字体一致**：后端返回 `fontSetHash` 与所需字体列表；前端用 `FontFace` 加载后再测量/绘制。字体缺失时必须走原有 fallback 并提示，不能换一套字体硬排。
3. **PPT 字宽闭环不能省**：后端不得用启发式字体度量声称“最终排版”；必须下发测量 batch（key/text/family/bold/italic），浏览器 `measureText` 回传后服务端二次排版，并校验 `batchId/revision/session`。这是原项目排版算法的一部分。
4. **DOCX 本期不进远端**：`stagesPending` 不涉及 DOCX；若未来接入，后端不得声称完成分页（见附录 F）。
5. **版本一致**：`parserVersion` 不同则禁止混用同一会话的 unit。
6. **渲染组件不变**：后端只提供模型，渲染仍走 `packages/viewer-renderers` 的现有组件（Konva、Tiptap、PDF.js、Univer）。这是仓库“沿用原渲染方式”验收口径的硬约束。
7. **失败显式化**：字体缺失、后端版本不匹配、格式不支持（如大 DOCX）等必须给出明确诊断，不能静默降级丢正文。

---

## 5. 后端：`apps/parse-server` 架构

### 5.1 进程模型

```
┌─────────────────────────────────────────────────────────────┐
│ parse-server (Node 22, 单进程只做 I/O/路由/队列)              │
│  ├─ HTTP: 上传/文件/会话/单元/资源/作业/SSE                    │
│  ├─ storage: 内容寻址文件库 + 磁盘缓存 + 临时目录              │
│  ├─ queue: 有界队列 + 准入控制 + 取消                          │
│  └─ pool: 子进程池（每 job 一进程，一次一 job）                │
│       └─ pptx-worker  (--max-old-space-size=1024, RSS 上限 1.5G)│
│           PDF: 无需 worker，直接 Range 服务                      │
└─────────────────────────────────────────────────────────────┘
```

要点：

- **主进程不解析任何文档**，只做流式 I/O 和调度；这样即使某个解析器失控，路由/上传/其他会话不受影响。
- **独立部署，不嵌 Electron**：`apps/parse-server` 是普通 Node 服务（esbuild 单文件或 tsc 输出），可放在 nginx/ALB 后面终止 TLS。HTTP 表面抽成 `packages/parse-service`（`startServer(opts)`），便于测试和后续拆分。**不要**把服务塞回 `apps/viewer`——`apps/viewer/scripts/standalone-smoke.mjs:9-31` 与 README 有反向门禁。
- **单机起步，预留水平扩展**：文件/会话/缓存放共享对象存储 + Redis/DB，API 无状态，worker 池可拆成独立服务；本期先单机（§5.11）。
- 子进程池大小 = `min(cpu 核数, floor(内存预算 / 单 job 上限))`，默认单 job 上限 1.5GB、总预算 4GB 时最多 2–3 个并发解析。
- 子进程崩溃/OOM → 该 job 失败，池补位；子进程死亡时由主进程回收并重建。
- 取消：HTTP 断开 / `DELETE /sessions/:id` → `AbortSignal` → 主进程 `kill(worker)`；PDF 只中断流。
- 主进程一旦持有解析中的大对象，就回到 `byte-handoff.ts` 注释里那次 1GB 事故的老路；这也是解析必须在子进程里的原因。

### 5.2 API 面（v1）

```text
# 能力（创建会话前先协商）
GET    /v1/capabilities             {parserVersion,formats,stages,maxBytes,fontSetHash,features}

# 文件
POST   /v1/files                    流式上传（Content-Length 或 chunked），返回 {fileId,size,sha256}
POST   /v1/files/:id/parts          分片续传（Content-Range），返回已收字节
GET    /v1/files/:id                {format,mime,size,encrypted,sha256}
GET    /v1/files/:id/content        Range 206 + ETag（PDF 渐进加载、原文件兜底）
GET    /v1/files/:id/parts/:partPath 容器内资源 Range（pptx 图片、嵌入字体）
DELETE /v1/files/:id

# 会话（创建是异步的：索引完成即返回，模型/单元渐进可用）
POST   /v1/sessions                 {fileId, options} -> 202 {sessionId, state:'indexing'}
GET    /v1/sessions/:id             {state,progress,model?,warnings}
GET    /v1/sessions/:id/units?cursor=&limit=    UnitSummary[]
GET    /v1/sessions/:id/units/:unitId           按格式的 unit 负载
GET    /v1/sessions/:id/assets?cursor=&limit=   AssetRef[]（分页，不一次列全）
GET    /v1/sessions/:id/assets/:assetId         Range 资源（派生/转码后）
POST   /v1/sessions/:id/text-widths             PPT 字宽回传（batch/revision/key 校验）
DELETE /v1/sessions/:id

# 作业（长任务：文本抽取、缩略图等）
POST   /v1/jobs                     {kind,fileId,options} -> {jobId}
GET    /v1/jobs/:id                 {state,progress,error}
GET    /v1/jobs/:id/result          二进制或 JSON
DELETE /v1/jobs/:id

# 事件
GET    /v1/events?sessionId=        SSE：progress / warning / done / error
```

设计约束：

- 所有响应都带 `parserVersion`、`sessionId`、`requestId`；错误用统一 `{code,message,retryable}`。
- **鉴权与 CORS**：`GET /v1/capabilities`、`GET /v1/health` 可匿名；其余接口要求 `Authorization: Bearer <token>`（或同源 HttpOnly cookie）。CORS 只允许 Viewer 的部署 origin，不允许 `*`。
- **`POST /v1/sessions` 不得同步返回完整模型**：1GB 文件的索引就可能超过 HTTP 超时。首响应只给 `sessionId + state`，模型/单元通过 `GET` 或 SSE 渐进获取。
- **`GET /v1/capabilities` 必须在创建会话前可缓存**；`parserVersion`/`fontSetHash` 变化时前端重新协商，不能沿用旧缓存。
- 单元接口必须支持游标，**任何单响应不得超过约 1–2MB**；超出的 unit 由服务端切分。
- 上传先校验 `Content-Length`，再在实际写入时二次限流；两者都不能省（chunked 没有声明长度）。
- 资源接口支持 `Range`、`If-None-Match`、`Cache-Control: private, max-age=...`；**默认不抽取媒体**，直接按 `partPath` 从原文件读，只有派生资源才走 `assets/:assetId`。

### 5.3 上传与存储

```
HTTP body ──stream──► hash(sha256) ──► 临时文件(fd 直写) ──► fsync? ──► 内容寻址库 files/<sha256[0:2]>/<sha256>
                                                        └──► 配额检查 / 超限即 abort + unlink
```

- 用 `stream.pipeline(req, hash, writeStream)`，边写边算 hash；**不**先收完再算。
- 断点续传：按 `Content-Range` 写入临时文件对应偏移；客户端重试幂等（`PUT /parts/:n`）。
- 去重：hash 命中已有文件则直接返回 `fileId`（跳过重复上传），但配额仍按引用计数/租户计。
- 临时目录权限 0700；崩溃后启动扫描清理超过 TTL 的目录。
- 配额：单文件上限（建议 2GB）、租户总存储、并发上传数。

### 5.4 每格式解析流水线（1GB 目标）

#### PPTX

```
随机访问 zip 目录
  → 读 presentation.xml / slide 列表 / 主题 / 母版 / 布局（小 part）
  → 每 slide 按需 materialize（presentation.xml.rels + slideN.xml + 继承链）
  → 版面：buildRenderSlide（服务端字体度量 + 前端回传修正）
  → 媒体：只存 AssetRef，按页/可见区懒加载
```

- **现有 `PackageArchive.open` 会把每个 entry 全量 inflate 进 `Map`**（`pptx-engine/src/zip.ts:90-98`），这是 PPTX 最大的炸点：1GB deck 峰值约 2.5–3GB，且 Slides 打开路径**没有任何尺寸上限**（`slides-main.ts:924`）。后端必须先做“按需读 part”的 archive，而不是复用这个构造函数。
- 现有 `openPptx` 打开即解析全部 slide；大 deck 应改为“索引 + 按需 materialize”，或保留小文件快路径。
- 渲染树按 slide 落盘；前端一次只取当前页 ± 邻页。
- 字体测量闭环沿用 [web-viewer-migration](web-viewer-migration.zh-CN.md) 的设计：服务端下发测量 batch，浏览器 `measureText` 回传，服务端二次排版。
- 媒体已有现成缓解：Viewer 的 72KB “descriptor head + 按需字节”（`browser-media.ts:174-220`）可直接搬到后端模型里，作为 AssetRef 的轻量替代。

#### PDF

- 后端**不需要解析**：`GET /files/:id/content` 支持 Range，前端 PDF.js 渐进加载。
- **前提是前端拿到的是 HTTP URL，不是 blob URL**。Viewer 现在是 `getDocument({url: blob})`（`pdf.tsx:92`），blob URL 基本不会发 Range；要么改成服务端 URL，要么整份读入（就不是大文件方案了）。
- 后端可选提供：文本抽取（逐页 `pdfjs-dist`，worker 隔离）、缩略图、搜索索引——都走 job，不阻塞预览。
- 加密 PDF：密码只在请求内存中，不落盘、不写日志；错误次数限流。
- 附件文本抽取路径（`file-parse/src/pdf.ts`，桌面附件/AI 用，**本期不接**）目前是 `readFile` + `new Uint8Array(bytes)` 双份拷贝；若未来接，需加 cap 或改走 parse-server 逐页作业。

#### 5.4.1 模型序列化边界（很容易被低估）

现有解析结果**不是**可直接 JSON 化的对象，契约必须显式定义 wire 形态：

| 现有对象              | 不可直接传输的部分                       | wire 形态                                                                                 |
| --------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `RenderSlide`（PPTX） | 媒体 data URL / descriptor、字体度量对象 | `RenderSlideWire`：媒体 → `AssetRef`；字体 → 字体 id + `fontSetHash`；度量值随 batch 回传 |
| PDF                   | —                                        | 只传页码/元数据；页面位图由 PDF.js 自己取                                                 |

规则：

- 单个 unit 的 wire 负载 ≤ 2MB；超出由服务端切分（PPT 按 slide）。
- 二进制一律 `AssetRef.url`，前端按需 `GET`（可 Range、可缓存）。
- 模型里不得出现绝对路径、临时目录、内部 session id 以外的实现细节。
- 契约包提供 `assertRenderSlideWire/assertPdfMeta` 运行时校验，防止版本漂移后前端崩在渲染深处。

### 5.5 内存与进程隔离（防 1GB 撑爆的核心）

| 机制             | 做法                                                                             | 说明                                                   |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 子进程           | `fork` + `--max-old-space-size=1024`                                             | V8 堆硬顶，超了子进程自己 OOM，不牵连主进程            |
| RSS watchdog     | 每 500ms 读 `/proc/<pid>/status`（或 `process.memoryUsage().rss` 由子进程上报）  | 原生内存不受 V8 限制，必须独立监控；超 1.5GB `SIGKILL` |
| 容器限制         | 生产部署给 parse-server 容器设 memory limit                                      | 最后一道防线；OOM killer 杀容器而不是宿主机            |
| 单 job 单进程    | 一个 worker 同时只处理一个 job                                                   | 避免两个大文件叠加；也简化取消                         |
| 流式 I/O         | 上传/下载/解压全程 stream，`highWaterMark` 有界                                  | 不出现 `Buffer.concat(全部)`                           |
| 单元化           | 解析结果按 unit 落盘，内存只留当前 unit                                          | 1GB 文档的模型不需要同时驻留                           |
| 资源外置         | 媒体/字体不 base64、不进模型 JSON                                                | 避免 JSON 放大 33% + 双份字符串                        |
| 计量解压         | `zip-gate` 逐 part 取消 + 总量上限                                               | 防 zip bomb；1GB 输入也要设总解压预算                  |
| 禁止整包 inflate | 不复制 `pptx-engine` 的 `PackageArchive.open`（每 entry 进 Map，`zip.ts:90-98`） | 这是 PPTX 最确定的雷                                   |
| 不重复门禁       | 每次打开都跑一次计量解压会付一次全量解压 CPU                                     | 后端只在“打开”做一次，结果落缓存                       |

补充：

- **不要用 `worker_threads` 的 `resourceLimits` 作为唯一防线**：它能限制 V8 堆，但 `zlib`/WASM/`Buffer` 的原生分配不完全计入；子进程 + RSS 更可控。
- **不要让主进程持有 `Buffer` 引用**：上传完成后立即落盘并释放；会话只存 `fileId`。
- **缓存与源文件分盘**（或至少分目录 + 配额），避免缓存写满磁盘导致上传失败。
- **“有 lazy media 就安全”是错的**：pptx 的媒体外置必须自己做（按 part 读 + AssetRef），不能指望引擎自动省内存。

### 5.6 准入控制与背压

| 参数         | 建议默认                     | 行为                                 |
| ------------ | ---------------------------- | ------------------------------------ |
| 单文件上限   | 2GB                          | 超限 413，早于读取 body              |
| 单次解压总量 | 4×文件大小 或 4GB（取小）    | 超限中止并标记 `zip_budget_exceeded` |
| 单 part 上限 | 512MB（沿用 zip-gate）       | 超限拒绝                             |
| 并发上传     | 4                            | 超限 429 + Retry-After               |
| 并发解析 job | `min(cpu, memBudget/jobCap)` | 队列有界（如 32），超限 503          |
| 队列等待超时 | 60s                          | 超时 503，不无限排队                 |
| 会话 TTL     | 空闲 15min / 硬 1h           | 到期释放 worker/临时目录             |
| 文件 TTL     | 24h                          | 到期删除（可配置）                   |
| 缓存上限     | 磁盘 20GB，LRU               | 超限按字节淘汰                       |
| 单元响应上限 | 2MB                          | 超出切分                             |

背压链路：HTTP 流 → 队列 → worker → 磁盘。任何一段满都向上游返回 429/503，而不是把数据堆在内存里。

现有代码里的上限可直接作为参数起点（但注意覆盖范围）：

| 现有上限             | 值                                     | 覆盖范围                                                   |
| -------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `DEFAULT_ZIP_LIMITS` | 10k parts / 512MiB part / 1.5GiB total | pptx 引擎（DOCX 本地预览也用）；**是“宽恕门”不是内存预算** |
| `MAX_OPEN_BYTES`     | 512MiB                                 | 只有桌面 Docs 主进程；Viewer/parse-server 需另设           |
| `MEDIA_HEAD_BYTES`   | 72KiB/图                               | Viewer 的 PPT 媒体 descriptor                              |
| handoff              | 8 pending / 1GiB / 60s                 | 桌面 Docs 主进程暂存的整份字节（历史参考）                 |

### 5.7 缓存与磁盘布局

```
<dataDir>/
  files/<sha256[0:2]>/<sha256>          # 原始文件（内容寻址，只读）
  sessions/<sessionId>/                 # 会话级派生（可清理）
  cache/<sha256>/<parserVersion>/<fontSetHash>/<stage>/<unitId>.json
  tmp/<jobId>/                          # 上传/转换临时目录（0700，启动清扫）
  meta.sqlite                           # 文件/会话/配额元数据（可选）
```

- 缓存写入用“临时文件 + rename”保证原子性（仓库已有 `atomic-write.ts` 可参考）。
- 缓存命中前校验 `parserVersion`/`fontSetHash`/选项 hash；不匹配视为 miss。
- 淘汰：按目录字节 LRU；启动时清理孤儿 session/tmp。

### 5.8 可观测性

- 每个 job 记录：`jobId/fileHash/format/size/queueWaitMs/parseMs/peakRssBytes/units/outcome`。
- 指标：队列深度、活跃 worker、RSS/磁盘水位、拒绝原因分布、缓存命中率、首 unit 延迟。
- 日志不写文件路径（隐私），只写 fileId/hash 前缀；错误带 code 便于前端提示。
- 压测门槛：1GB 文件单 job 峰值 RSS ≤ 1.5GB；主进程 RSS 与文件大小无关（只有流缓冲）。

### 5.9 安全

| 威胁                | 防护                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| zip bomb            | 复用 `zip-gate` 计量解压；额外总解压预算；单 part 上限。注意它是“宽恕门”不是内存预算：允许 1.5GiB 诚实解压，且需要整包 `Uint8Array` |
| XML bomb / 实体扩展 | `fast-xml-parser` 禁用 DTD/实体；限制节点数/深度/属性长度                                                                           |
| 路径穿越            | zip entry 名规范化，拒绝 `..`、绝对路径、重复规范化、符号链接                                                                       |
| 超大图片/像素炸弹   | 解码前查宽高与像素上限；TIFF/EMF 解码设上限（仓库已有 TIFF 处理）                                                                   |
| 字体炸弹            | 字体数量/单字体大小上限；`opentype.js` 解析失败降级                                                                                 |
| SSRF                | 后端不代下载任意 URL（沿用 Viewer 现状）；如必须，白名单 + 禁内网 + 超时                                                            |
| 加密文件            | 密码只在请求内存；不落盘、不写日志；错误限流                                                                                        |
| 沙箱                | worker 无网络、只读源文件、只写 job 目录；容器 non-root + 只读 rootfs                                                               |
| 资源耗尽            | 单位数/输出字节/并发/队列/磁盘全部有上限                                                                                            |

### 5.10 资源存储与分发（图片 / 字体 / 音视频）

先纠正一个容易误解的点：**仓库里没有统一的媒体库或对象存储**。图片默认仍在文档容器里（OOXML 的 zip entry、PDF 对象流），所谓“存储”主要是“原文件 + 容器内位置”；“懒媒体”也不是把图片抽出来另存，而是**不把字节搬进渲染进程**。

#### 5.10.1 现状：各宿主怎么存、怎么取

| 场景                      | 存在哪                                                                                                                                      | 怎么取                                                                                         | 生命周期                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------ |
| OOXML 内嵌资源            | 文档 zip：`word/media/*`（本地 DOCX）、`ppt/media/*`                                                                                        | 解压对应 entry                                                                                 | 随文档                               |
| DOCX Viewer（仅本地预览） | 浏览器内存（整包 zip + 逐个 `Blob`）                                                                                                        | JSZip 读 entry → `URL.createObjectURL`                                                         | 页面/iframe 生命周期                 |
| PPTX 桌面                 | 主进程内存 `archive`（全部 entry 的 `Map`）                                                                                                 | `makeMediaResolver` 转 **base64 data URL** 塞进 RenderSlide；音视频 `getMediaData` 返回 base64 | 会话生命周期                         |
| PPTX Viewer               | 渲染树只放 **72KB descriptor head**，真实字节按需取                                                                                         | worker `bytes(ref)` → 页面 `Blob` → blob URL                                                   | 切页/卸载时 revoke                   |
| PDF                       | PDF 内部对象流                                                                                                                              | PDF.js 解码到 canvas，不抽取                                                                   | 页面；只有“导出图片”才写用户目录 PNG |
| AI 附件                   | 只存元数据 `{name,path,ext,sizeBytes}`，**不存字节**                                                                                        | 用时读文件转 base64 做多模态                                                                   | 引用，文件移动即断链                 |
| 临时/恢复                 | docs `userData/docs-autosave/<sha1>.docx`；sheets `temp/genoffice-sheets-sessions/<uuid>.xlsx`；粘贴图 `temp/genoffice-pasted/pasted-*.png` | —                                                                                              | TTL/启动清理（粘贴图 7 天）          |

> 表中 XLSX / Markdown / HTML / AI 附件 / 桌面端相关行**不在本期范围**；DOCX 仅保留本地预览，不做后端解析。本期后端只处理 pptx/pdf。

三条事实：

1. **默认不抽取**：打开文档不会生成 `media/` 目录或缩略图库；资源仍归原文件。
2. **内存里常见 base64/blob**：PPTX 桌面把图片转 data URL 进 RenderSlide（+33%），Viewer 用 blob URL；这是“显示层”的临时形态，不是持久化。
3. **PPTX Viewer 的 72KB descriptor head 是现有最接近“资源句柄”的做法**：渲染树只放头部，真实字节按需取；后端应把它升级成 `AssetRef`。

#### 5.10.2 后端设计：内容寻址 + 不抽取 + Range

```
files/<sha256[0:2]>/<sha256>                  # 原文件，不可变，唯一真源
cache/<sourceSha256>/<transformVersion>/...   # 缩略图/转码等派生资源
tmp/<jobId>/                                  # 上传/转换临时，TTL 清扫
```

1. **原文件内容寻址**：上传流式落盘、边写边算 sha256、去重；文件不可变，删除靠引用计数 + TTL。
2. **资源默认不抽取**：`AssetRef = {fileId, partPath?, sha256, mime, size, transform?}`。pptx 的图片就是容器里的 part，按 range 从原文件读。
3. **三类资源、三个入口**：

   | 资源        | 入口                                   | 说明                                                         |
   | ----------- | -------------------------------------- | ------------------------------------------------------------ |
   | 容器内 part | `GET /v1/files/:id/parts/:partPath`    | pptx 图片、嵌入字体；Range + ETag，不落缓存                  |
   | 派生资源    | `GET /v1/sessions/:id/assets/:assetId` | 缩略图、TIFF→PNG、EMF/WMF 栅格化、SVG 主题重着色；落磁盘缓存 |
   | 整文件      | `GET /v1/files/:id/content`            | PDF 渐进加载、原始下载                                       |

4. **模型里只放句柄，不放 URL**：PPTX 的媒体用 `{sha256, partPath}` 引用，URL 由前端按 session 拼；这样缓存、迁移、换后端都不会把地址写死进模型。
5. **派生资源单独缓存**：键必须含 `sourceSha256 + transformVersion + 影响结果的选项`（如 SVG 主题、DPI）；否则跨版本复用会画错。缓存按字节 LRU，原文件只读。
6. **去重 / GC / 配额**：`sha256` 去重；引用计数（file、session）；会话 TTL 到期释放；启动时清扫孤儿 `tmp/` 与无引用缓存；配额按租户/单文件/单资源三层。
7. **上传是唯一入口**：本期只做服务器模式，没有“本机路径直读”的捷径；因此上传必须流式（`fetch(file)`/分片），并且去重（同 sha256 不重复存）。
8. **Range 与缓存头**：媒体响应必须支持 `Accept-Ranges`/`206`/`ETag`/`If-None-Match`；音视频必须 Range（不要 base64 data URL）；`Cache-Control: private, max-age=...` 由资源类型决定。
9. **安全**：MIME 嗅探优先于扩展名；SVG 以 `image/svg+xml` 提供但不在同源文档上下文执行脚本；TIFF/EMF 解码设像素上限；zip entry 路径规范化；单资源大小上限（建议 64–128MB，音视频另设）。

#### 5.10.3 与现有代码的映射

| 现有实现                                           | 后端对应                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| Viewer PPTX 72KB `MEDIA_HEAD_BYTES` + `bytes(ref)` | `AssetRef` + 按需 `GET`（不再把整段 base64 塞渲染树）             |
| `md-asset://` / `html-asset://`                    | 资源包 manifest + `GET /packages/:id/files/*`（保留相对路径语义） |
| `apps/pdf` 导出图片（`export-images.ts`）          | 仍由前端/桌面导出，后端不参与                                     |

#### 5.10.4 不要做的三件事

1. **不要把媒体 base64 进 JSON/DTO**：+33% 且多一份字符串，1GB 文件直接翻倍。
2. **不要在上传时把媒体全部解压另存**：1GB 文件会先产生一份等量或更大的“媒体库”，而且和原文件失去一致性。
3. **不要把资源 URL 写死进文档模型**：模型里只放 `sha256 + partPath`，URL 是会话/部署相关的派生信息。

### 5.11 服务器部署与安全（将来部署）

> 本期只做 Viewer，但后端将来要部署到服务器；这一节把“能跑”与“能上线”分开。单机内网可用最低配置，公网多租户按完整清单。

#### 5.11.1 拓扑

```
浏览器（Viewer 静态站，CDN）
   │ HTTPS（同域 /v1 或独立 api 域）
   ▼
nginx / ALB（TLS、请求体上限、超时、限流）
   ▼
parse-server（无状态 API：鉴权、会话、上传、Range、SSE）
   ├─ 存储：本地磁盘（单机）或 S3/OSS（多机）
   ├─ 元数据/会话：SQLite（单机）或 Postgres/Redis（多机）
   └─ worker 池（可拆成独立服务）：pptx 解析；PDF 只做 Range 服务
```

- **API 无状态**：会话状态放 DB/Redis，文件与派生结果放对象存储；这样加机器不用 sticky session。
- **上传**：小文件可走 API 代理流式写；大文件建议 presigned URL 直传对象存储，API 只收 `fileId + sha256` 并做服务端校验（需对象存储支持 CORS/Range）。
- **Range**：对象存储或 nginx 直接支持；不要经 Node 转发整个文件。

#### 5.11.2 鉴权与租户

- 认证：`Authorization: Bearer <token>`（服务间/CLI）或同源 `HttpOnly; SameSite=Lax` cookie（浏览器会话）；token 不落日志。
- 授权：每个 `fileId/sessionId` 绑定 `tenantId/ownerId`；所有读写校验归属，资源 URL 用短时签名或同源 cookie，禁止裸 ID 越权。
- CORS：只允许 Viewer 的部署 origin；预检缓存；不要 `*`。
- CSRF：cookie 模式需要 CSRF token 或 `SameSite` + 自定义头校验。
- 配额：租户存储、并发 job、单文件大小、日上传量；超限 429/413 并给出可读原因。

#### 5.11.3 存储与生命周期

- `StorageDriver` 抽象：`local`（单机）与 `s3`（多机）；接口只需 `putStream/getRange/stat/delete`。
- 内容寻址 + 引用计数；会话 TTL、文件 TTL、缓存 LRU；删除时先删元数据再异步清对象（避免悬挂引用）。
- 静态加密（对象存储 SSE 或磁盘加密）；密钥不入库；日志脱敏。
- 备份：元数据库定期备份；对象存储开版本/生命周期；缓存可重建，不必备份。

#### 5.11.4 可观测性与运维

- 指标：请求量/延迟/错误码、上传字节、队列深度、worker RSS、磁盘水位、缓存命中、每格式首 unit 延迟。
- 日志：结构化，带 `requestId/sessionId/fileId`，不写路径/内容；错误带稳定 `code`。
- 告警：RSS 超限、OOM 率、队列积压、磁盘 >80%、5xx 比例。
- 容量：1GB 文件按“上传带宽 + 存储 + 解析峰值”估算；去重能显著降低重复上传成本。

#### 5.11.5 安全清单（公网）

TLS 强制；鉴权/授权；CORS 白名单；上传大小/速率限制；zip/XML bomb；路径穿越；SSRF 关闭；worker 无外网、只读源文件、只写 job 目录；容器 non-root + 只读 rootfs；依赖漏洞扫描；审计日志。

---

## 6. 1GB：PPTX 与 PDF

> 本期 1GB 目标只落在 **PPTX / PDF**。PPTX 是重点：1GB 的绝大部分是媒体，按 slide materialize + 媒体外置即可把前端内存与文件大小解耦；PDF 只需要 Range。DOCX 推迟，预留设计见附录 F。

### 6.1 PPTX

| 步骤   | 现状                                                                                       | 设计后                                                   |
| ------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 读取   | 整份 `Uint8Array`（`readFile`）                                                            | 随机访问 `ByteSource`，只读目录与所需 part               |
| 打开   | `JSZip.loadAsync` 把**每个 entry 全量 inflate 进 `Map`**（`pptx-engine/src/zip.ts:90-98`） | 只解析 central directory；按 slide materialize           |
| slide  | `openPptx` 打开时解析全部 slide                                                            | 只索引 slide 列表；按需解析当前页 ± 邻页                 |
| 渲染树 | 全量 `RenderSlide[]`                                                                       | 按 slide 落盘/下发，单响应 ≤2MB                          |
| 媒体   | base64 data URL 进渲染树（+33%）                                                           | `AssetRef` + `GET /files/:id/parts/...` + Range          |
| 字宽   | 主进程 `executeJavaScript` / Viewer 6 轮测量                                               | 服务端下发 measurement batch，浏览器回传，服务端二次排版 |
| 峰值   | ≈2.5–3GB（1GB deck）                                                                       | worker ≤1.5GB；前端只持当前页 ± 邻页                     |

落地要点：

1. **随机访问 archive**：`PackageArchive` 目前只能从 bytes 构建（`zip.ts:80-104`），只读后端需要新写一个 reader（不改编辑路径）。
2. **按 slide 索引**：`presentation.xml` + `presentation.xml.rels` + `slideN.xml` + 继承链（母版/布局/主题）按需读；不要打开即解析全部 slide。
3. **媒体外置**：渲染树里只放 `AssetRef`；TIFF→PNG、SVG 主题重着色、JPEG EXIF 方向等兼容逻辑仍在服务端做，但结果作为派生资源缓存。
4. **字宽闭环**：沿用 [web-viewer-migration](web-viewer-migration.zh-CN.md) 的 `text-widths` 设计；服务端不得用启发式度量声称“最终排版”。
5. **首屏**：只返回首页 + 邻页；缩略图按需；不要把全 deck 的 `RenderSlide` 一次下发。
6. **峰值目标**：单 worker ≤1.5GB；前端只持当前页 ± 邻页；媒体字节按需 Range。

风险：字体测量闭环的收敛性（CJK/RTL/私有字体）、大图/TIFF/EMF 解码、母版/主题继承的完整性。PPTX 是本期**先达标**的格式。

### 6.2 PDF

- 后端**不需要解析**：`GET /files/:id/content` 支持 Range，前端 PDF.js 渐进加载。
- **前提是前端拿到 HTTP URL，不是 blob URL**：Viewer 现在是 `getDocument({url: blob})`（`pdf.tsx:92`），blob URL 基本不发 Range；必须换成服务端 URL。
- 前端按页释放 canvas（`MAX_PAGE_RENDER_PIXELS` 已有）；只渲染可见页/缩略图。
- 只读表单/批注/链接层沿用现有 `PdfPage`/`FormLayer`/`LinkLayer`。
- 加密 PDF：密码只在请求内存中，不落盘、不写日志；错误次数限流。
- 1GB PDF 的瓶颈在网络与 PDF.js 内存，不在服务端；服务端只做 Range/ETag。

### 6.3 可达性小结

| 格式 | 1GB 方案                                           | 关键前提                                |
| ---- | -------------------------------------------------- | --------------------------------------- |
| PPTX | 随机访问 archive + 按 slide materialize + 媒体外置 | 新写只读 archive reader、字宽回传闭环   |
| PDF  | Range + PDF.js 按页                                | 前端改 HTTP URL、按页释放 canvas        |
| DOCX | **本期不做**（推迟）                               | 需流式 tokenizer + 分页虚拟化，见附录 F |

**本期关键路径是 PPTX**：先打通 PPTX 1GB，再接 PDF Range，最后做服务器化。DOCX 不进入本期关键路径。

---

## 7. 与现有代码的接入点

### 7.1 直接复用

| 能力                 | 位置                                                                                                     | 用途                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 计量解压 / zip bomb  | `packages/zip-gate`（`streamBytes`、`assertZipInflatesWithinLimits`）                                    | 后端上传校验与解析前置                                                       |
| 随机访问 zip         | `packages/docx-engine/src/zip-splice.ts`（`ByteSource`、`readZipEntries`、`openZipFile`）                | PPTX 的 I/O 基础（zip 格式通用，与 docx 语义无关）                           |
| PPTX 媒体 descriptor | Viewer 的 72KB head + `bytes(ref)`（`apps/viewer/src/web/browser-media.ts:174-220`）                     | 升级成 `AssetRef` + 按需 GET                                                 |
| HTTP/SSE 模式        | `apps/shell/src/main/mcp/mcp-server.ts`                                                                  | 路由/SSE/loopback/Host-Origin 校验/body cap 参考                             |
| 1GB 教训             | `apps/docs/src/main/byte-handoff.ts`                                                                     | 禁止整份字节过 IPC/JSON；TTL + 上限驱逐                                      |
| 文本抽取 worker      | `apps/shell/src/main/file-index/extract-worker.ts`                                                       | `worker_threads` 池 + 空闲回收/超时重启的先例                                |
| 文件级预检           | `packages/cli/src/limits.ts`（`readZipDirectory`、`assertPackageWithinLimits`、`MAX_COMPRESSION_RATIO`） | Node-only，只读 EOCD+CD、按比例判 bomb，不整份读入；后端 pre-open 可直接复用 |
| 媒体按 range 服务    | `packages/viewer-services/src/docs/lazy.ts`（`prepareDocMedia`）                                         | 目前无调用方，但“从文件按 range 取媒体”的样例可借鉴                          |
| 临时资源清理         | `apps/sheets/src/main/temp-files.ts:1-58`                                                                | TTL + 文件名形状约束 + 启动清扫                                              |
| 单文件打包           | `packages/cli/build.mjs`                                                                                 | esbuild 单文件；服务端也可照此打单文件                                       |

### 7.2 需要重构 / 新建（按优先级）

1. **`zip-splice.ts` 拆纯读**：把 `ByteSource`/`readZipEntries` 与 `node:fs`/`node:zlib` 分离成 `zip-reader.ts`（纯，可测试），Node 侧保留 `openZipFile`。服务端只需要 Node 版本。
2. **`pptx-engine/zip.ts` 随机访问化（本期最大后端改造）**：`JSZip.loadAsync` 改为按需读 part；`openPptx` 支持“只索引不解析全部 slide”。`PackageArchive` 目前只能从 bytes 构建（`zip.ts:80-104`），且编辑路径会改 `entries`（`index.ts:2409`）；只读后端只做“读”的 archive。
3. **PPTX 媒体外置**：渲染树里不再塞 base64 data URL，改为 `AssetRef` + `GET /files/:id/parts/...`；TIFF→PNG、SVG 主题重着色、JPEG EXIF 方向等兼容逻辑保留在服务端，结果作为派生资源缓存。
4. **PPTX 字宽回传**：沿用 Viewer 的 measurement batch 设计（服务端下发 key/text/family/bold/italic，浏览器 `measureText` 回传，服务端二次排版），并校验 `batchId/revision/session`。
5. **`viewer-services` 导出拆分**：按 `./browser` 与 `./node` 拆 export map（现状靠 import 习惯，浏览器 bundle 可能误触 Node 模块）。
6. **补一个 file-backed 计量门**：`assertZipInflatesWithinLimits` 只接受 `Uint8Array`（`zip-gate/src/index.ts:106`），后端需要 `ByteSource` + `streamBytes` 的按 range 版本；`readZipEntries` 已有 `ByteSource`，把两者组合即可（未验证性能）。
7. **Viewer PDF 改 HTTP URL**：blob URL 基本不会发 Range（`pdf.tsx:92`、`host.tsx:115-117`），要拿到渐进加载必须换成服务端 URL。
8. **DOCX 本地预览保持现状**：不进后端、不改解析路径；大 DOCX 在 UI 上明确提示“暂不支持服务端解析”。

### 7.3 新增

| 新增                              | 内容                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/parse-contract`         | 类型 + 校验 + 能力/版本协商（纯，不 import DOM/Node/Electron）                          |
| `packages/parse-service`          | HTTP 表面 + 存储/队列/worker 管理，导出 `startServer(opts)`；便于测试与后续拆分         |
| `packages/parse-core`（可选）     | 服务端解析阶段实现：zip-reader、slide 索引、unit 序列化                                 |
| `apps/parse-server`               | 独立 Node 服务：`src/{bin,config}` + 复用 parse-service；`tests/{api,limits,lifecycle}` |
| `apps/viewer/src/web/providers/*` | local/remote provider + router + settings                                               |

### 7.4 非目标（本期明确不做）

| 非目标                    | 说明                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| DOCX 后端解析             | 不做流式 tokenizer、不做分页虚拟化；Viewer 保留现有本地 DOCX 预览（小文件），大 DOCX 明确提示不支持。预留设计见附录 F。                 |
| 桌面端（Electron）集成    | 不做 shell 内嵌服务、不做 `utilityProcess`、不改 docs/slides/sheets 的 `window.*Api`。桌面端未来若要接，复用同一 `parse-service` 即可。 |
| XLSX                      | 不接 `xlsx-sidecar`、不做 Univer 只读 UI；`XLSX_ZIP_LIMITS`/`MAX_RANGE_CELLS` 等仅作参考。                                              |
| 独立 Markdown/HTML Viewer | 不做资源包导入与 `<base>` 语义；Viewer 仍只支持 PPTX/PDF/DOCX（DOCX 仅本地）。                                                          |
| 本机路径授权              | 服务器模式只能上传；没有“按本地路径直读”的捷径。                                                                                        |
| 保存/编辑                 | 后端只读，不提供保存、批注写入、表单填写。                                                                                              |

**服务端部署约束（替代桌面打包约束）**：

| 约束             | 影响                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| Node ≥ 22.12     | 与仓库根 `engines` 一致；服务端可独立安装                                 |
| 反向代理终止 TLS | nginx/ALB 负责 HTTPS、请求体上限、超时；Node 只监听内网                   |
| 共享存储         | 单机用本地磁盘；水平扩展要对象存储（S3/OSS）+ Redis/DB，见 §5.11          |
| 无 Chromium 依赖 | 本期不做 DOCX altChunk，服务端不需要 Playwright/Chromium（简化部署）      |
| 静态资产         | Viewer 仍独立静态发布；后端只提供 `/v1/*`，不托管 Viewer 页面（可选同域） |
| 日志/隐私        | 不记录文件路径与内容；只记 fileId/hash 前缀、jobId、耗时、结果码          |

---

## 8. 实施计划

**本期关键路径是 PPTX 1GB**：先打通服务端 PPTX（随机访问 + 按 slide + 媒体外置 + 字宽回传），再接 PDF Range，最后服务器化。DOCX 不在本期关键路径。

| 阶段                         | 内容                                                                                                                                                 | 产出/验收                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **0. 探针（1–2 周）**        | 1GB pptx 现状压测；契约草案；`zip-reader` 纯化；PPTX 随机访问/按 slide 的 spike                                                                      | 记录现状峰值 RSS 与失败点；spike 结论；契约通过类型检查                      |
| **1. 服务端 MVP（2–3 周）**  | `apps/parse-server`：capabilities/上传/内容寻址/Range/会话；PPTX 结构解析（非流式，worker 隔离 + 上限）；PDF Range；Viewer remote provider + 切换 UI | Viewer 用 `?parse=server` 打开 PPTX/PDF；1GB 上传不炸服务；大图文档不 base64 |
| **2. PPTX 大文件（3–4 周）** | 随机访问 archive；按 slide materialize；媒体 `AssetRef` + Range；字宽回传闭环；RSS watchdog + 配额 + 磁盘缓存                                        | 1GB PPTX 首屏 + 翻页；worker 峰值 ≤1.5GB；取消/断网可恢复                    |
| **3. 服务器化（2–3 周）**    | 鉴权/CORS/TLS 反代；租户与配额；`StorageDriver`（本地→S3）；会话/缓存外置；可观测性/告警                                                             | 公网部署清单通过；多用户并发；重启后会话/文件可恢复                          |
| **4. 验收（2–3 周）**        | parity 矩阵、1GB 压测、资源专项、故障注入、安全测试、部署文档                                                                                        | 见 §9；差异清单与修复                                                        |

> 工期是工程判断，不含生产级多租户、集群化、旧版 `.doc/.ppt`。**估算偏乐观**：PPTX 随机访问 archive 与字宽回传闭环都是新代码，阶段 0 的 spike 可能推翻阶段 1–2 的估算；服务器化（阶段 3）也没有历史代码可抄。
>
> 总工期粗估 **8–12 周**（1 人全职、复用现有解析/渲染代码）；去掉 DOCX 后不再有“两个大工程叠加”的不确定性。

### 8.1 第一批可落地的 PR（建议顺序）

1. **`packages/parse-contract` 骨架**：类型 + `decideProvider` + 单测（纯函数，零依赖）。
2. **`apps/parse-server` 最小闭环**：`GET /v1/capabilities` + `POST /v1/files`（流式落盘）+ `GET /v1/files/:id/content`（Range）+ 健康检查 + 1GB 上传压测。此 PR 就能验证“后端不会被上传撑爆”。
3. **`zip-reader` 纯化**：从 `docx-engine/zip-splice.ts` 抽出 `ByteSource` + `readZipEntries`，Node 测试；现有调用点行为不变。
4. **PPTX 远程解析 MVP**：随机访问 archive + 按 slide materialize + 资源路由（`parts/assets`），Viewer remote provider 接 PPTX；同时把切换 UI 做出来。
5. **PPTX 媒体外置 + 字宽回传**：去掉渲染树里的 base64；接 measurement batch 闭环。
6. **PDF Range**：Viewer 把 blob URL 换成服务端 URL，验证渐进加载与按页释放。
7. **服务器化**：鉴权/CORS/配额/`StorageDriver`/可观测性，单独 PR 系列。

每步都可独立合并、独立回滚，不要求一次性替换现有解析路径。

---

## 9. 验证矩阵

### 9.1 一致性（本地 vs 后端）

- 同一 fixture 分别用 local/remote 解析，归一化 `DocModel` 后 diff（unit 数、锚点、文本、资源引用、警告）。
- 渲染截图对照：PPT 字形坐标/换行；PDF 页面/文字层。DOCX 仅本地预览，不在后端 parity 范围。
- 字体集不同时必须报告“不可比”，不得用宽松阈值掩盖布局差异。
- 覆盖：嵌入/私有字体、CJK/RTL、复杂表格/图表、浮动对象、动画、加密文件。
- **资源一致性**：同一 fixture 的 `AssetRef` 集合（sha256/partPath/mime/bytes）本地 vs 后端 diff；同一图片在本地 blob URL 与后端 Range URL 下渲染结果逐像素一致。

### 9.2 1GB 压测

| 指标                    | 门槛                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 服务主进程 RSS          | 与文件大小无关（< 300MB）                                                                                              |
| 单 worker 峰值 RSS      | ≤ 1.5GB                                                                                                                |
| 首 unit 返回时间        | ≤ 5s（索引 + 首块/首 slide）                                                                                           |
| 上传吞吐                | 受网络限制；断点续传可恢复                                                                                             |
| 取消                    | 5s 内释放 worker/临时目录                                                                                              |
| 连续打开 10 个 1GB 文件 | 无 RSS 单调增长、无 fd 泄漏                                                                                            |
| 资源内存                | 打开 1GB 图片密集文档时，服务 RSS 不随图片总字节增长（只有 range 读缓冲）；派生缓存增长受 `ASSET_CACHE_MAX_BYTES` 限制 |

### 9.2.1 PPTX 1GB 专项

| 指标   | 门槛                                                         |
| ------ | ------------------------------------------------------------ |
| 首屏   | 打开到第 1 页可见 ≤ 8s（含上传/索引，视网络）                |
| 翻页   | 跳到任意页 ≤ 2s；缩略图按需加载                              |
| 媒体   | 大图/视频不一次性进内存；切页释放上一个媒体                  |
| 字体   | 字体加载后二次排版收敛（CJK/RTL/私有字体）；不收敛时明确提示 |
| 内存   | 前端只持当前页 ± 邻页；worker 峰值 ≤1.5GB                    |
| 稳定性 | 刷新/断线后可从 session 恢复；页数/sourceId 不漂移           |

### 9.2.2 服务器部署专项

- 鉴权：匿名只能访问 capabilities/health；越权 fileId/sessionId 返回 404/403。
- CORS：只允许配置的 Viewer origin；预检正确。
- TLS/反代：大文件上传/下载超时、请求体上限、Range 透传。
- 并发：N 个用户同时 1GB 上传/解析，队列与配额生效，无互相 OOM。
- 重启：服务重启后文件/会话/缓存可恢复（或明确失效），无悬挂临时文件。
- 存储：本地磁盘与 S3 driver 行为一致（Range/ETag/删除）。

### 9.3 故障注入

- worker OOM / 超时 / 崩溃 → job 失败、池补位、其他会话不受影响。
- 上传中断 / 客户端断开 → 临时文件清理、无半成品会话。
- 磁盘满 / 缓存写失败 → 明确错误，不破坏源文件。
- 后端 5xx/网络抖动 → 前端回退或明确提示。

### 9.4 安全

- zip bomb（复用 `zip-gate` 测试语料）、XML bomb、路径穿越、超大图片、加密文件错误密码、并发刷接口。
- 资源专项：`partPath` 穿越/符号链接、MIME 伪装（扩展名与实际字节不符）、SVG 内脚本、TIFF/EMF 像素炸弹、Range 越界/负数/超长、跨租户 fileId 越权、派生缓存投毒（不同 source 命中同一 cache key）。

---

## 10. 风险与未决问题

1. **PPTX 字宽闭环是本期最大风险。** 服务端排版的换行依赖浏览器实测字宽；如果 measurement batch 不收敛（CJK/RTL/私有字体/复杂脚本），就会出现换行/位置漂移。必须沿用原 `text-widths` 闭环并做对照，不能用启发式度量冒充最终排版。
2. **PPTX 随机访问 archive 是新代码。** `PackageArchive` 目前只能从 bytes 构建（`zip.ts:80-104`），且编辑路径会改 `entries`（`index.ts:2409`）。只读后端要新写 reader；母版/布局/主题继承链容易漏读。
3. **一致性风险（通用）。** 仓库已有“源码一致不等于视觉一致”的教训（`apps/viewer/IMPLEMENTATION_STATUS.md`）。没有 parity 测试，不要上线“切换”。
4. **字体/环境差异。** 服务端字体集与用户浏览器不同会导致 PPT 换行不同；要么后端下发字体并让前端加载，要么明确降级提示。
5. **1GB 上传成本与隐私。** 大文件上传耗时可能超过解析本身；`local` 模式只适合小文件；`auto` 要有明确提示与记忆。上传必须流式（`fetch(file)`/分片），不能在浏览器里先 `arrayBuffer()`。
6. **Viewer 的“纯静态”约束。** 需求 B-01 要求静态站点；本文方案保持“Viewer 静态站 + 独立 parse-server”，不破坏该约束。反向门禁 `apps/viewer/scripts/standalone-smoke.mjs:9-31` 仍禁止把 server 塞回 Viewer。
7. **服务器化工作量被低估。** 本期只做 Viewer 不等于只做前端：公网部署要鉴权、租户/配额、CORS/TLS、存储抽象（本地→S3）、会话外置、可观测性/告警。这些没有历史代码可抄，§8 阶段 3 是独立工作。
8. **PDF Range 的前提未满足**：Viewer 现在把 blob URL 交给 PDF.js（`pdf.tsx:92`），blob URL 基本不发 Range；必须改成 HTTP URL 才谈得上渐进加载。
9. **1GB 峰值是推导值，未实测**：基于仓库内既有测量（PPTX `PackageArchive` 全量 inflate 峰值、zip-gate #759 的 794MB/3.12GB RSS）与代码结构推算；阶段 0 必须用真实 1GB 样本补 profiling。
10. **CORS / CSP 未验证**：Viewer 静态页 fetch 远程后端受 CORS/CSP/混合内容约束；仓库里没有现成配置，需单独验证。
11. **新 UI 的工程约定**：新增设置项/状态文案要进 i18n 分片（`zh.ts` + 各语言 shard），颜色必须用 `tokens.css` 语义 token；新增 workspace 要加进根 `test`/`typecheck` 脚本与 CI。
12. **加密 PPTX/PDF**：密码校验/解密位置（浏览器还是服务端）未设计；服务端处理时密码不能落盘/写日志。
13. **DOCX 推迟的后果**：大 DOCX 在 Viewer 里只能明确提示“暂不支持服务端解析”，不能静默失败；产品需要接受这个边界（本地预览仍可用）。
14. **范围收窄的代价**：不做桌面端/XLSX/DOCX 后端/MD/HTML 意味着复用面变小；`parse-server` 需要自己的构建/部署/CI 通道，不能依赖 Electron 打包。

---

## 附录 A：契约骨架（示意）

```ts
// packages/parse-contract/src/index.ts —— 纯类型，不 import DOM/Node/Electron
export type ParseMode = 'auto' | 'local' | 'server'

export interface SwitchPolicy {
  mode: ParseMode
  /** 按格式的本地阈值；缺省视为 0（只能后端） */
  localMaxBytes: Partial<Record<DocFormat, number>>
  allowUploadWithoutConsent: boolean // 默认 false
  privacyLocalOnly: boolean // 企业策略，优先级最高
}

export function decideProvider(input: {
  policy: SwitchPolicy
  size: number
  format: DocFormat
  localCaps: Capabilities
  remoteCaps?: Capabilities
  online: boolean
}): { provider: 'local' | 'remote' | 'blocked'; reason: string } {
  const localMax = input.policy.localMaxBytes[input.format] ?? 0
  const localFits = input.size <= localMax
  if (input.policy.privacyLocalOnly)
    return localFits
      ? { provider: 'local', reason: 'privacy-policy' }
      : { provider: 'blocked', reason: 'privacy-policy-too-large' }
  if (input.policy.mode === 'local')
    return localFits
      ? { provider: 'local', reason: 'user-forced-local' }
      : { provider: 'blocked', reason: 'user-forced-local-too-large' }
  const remoteSupported = input.remoteCaps?.formats.includes(input.format) ?? false
  if (input.policy.mode === 'server')
    return remoteSupported
      ? { provider: 'remote', reason: 'user-forced-server' }
      : { provider: 'blocked', reason: 'server-unsupported-format' }
  const localSupported = input.localCaps.formats.includes(input.format)
  if (!localSupported && remoteSupported) return { provider: 'remote', reason: 'format-not-local' }
  if (localFits) return { provider: 'local', reason: 'small-file' }
  if (remoteSupported && input.online) return { provider: 'remote', reason: 'large-file' }
  return { provider: 'blocked', reason: 'too-large-or-unsupported' }
}
```

## 附录 B：后端参数建议

| 参数                     | 建议值                              | 备注                               |
| ------------------------ | ----------------------------------- | ---------------------------------- |
| `MAX_UPLOAD_BYTES`       | 2 GiB                               | 早于 body 读取拒绝                 |
| `MAX_UNCOMPRESSED_BYTES` | min(4×fileSize, 4 GiB)              | 解压总预算                         |
| `MAX_PART_BYTES`         | 512 MiB                             | 沿用 zip-gate                      |
| `JOB_HEAP_MB`            | 1024                                | `--max-old-space-size`             |
| `JOB_RSS_LIMIT_MB`       | 1536                                | watchdog 阈值                      |
| `WORKER_POOL_SIZE`       | min(cpu, floor(MEM_BUDGET/JOB_RSS)) | 默认 2–3                           |
| `QUEUE_MAX`              | 32                                  | 超出 503                           |
| `QUEUE_WAIT_MS`          | 60_000                              |                                    |
| `SESSION_IDLE_MS`        | 15 min                              |                                    |
| `SESSION_MAX_MS`         | 60 min                              |                                    |
| `FILE_TTL_MS`            | 24 h                                |                                    |
| `CACHE_MAX_BYTES`        | 20 GiB                              | LRU                                |
| `UNIT_MAX_BYTES`         | 2 MiB                               | 响应上限                           |
| `MAX_ASSET_BYTES`        | 128 MiB                             | 单图片/字体；音视频另设            |
| `ASSET_CACHE_MAX_BYTES`  | 10 GiB                              | 缩略图/转码派生缓存                |
| `MEDIA_HEAD_BYTES`       | 72 KiB                              | 沿用 Viewer 的 PPT 媒体 descriptor |
| `THUMB_MAX_PX`           | 512                                 | 缩略图边长上限                     |
| `AUTH_TOKEN_TTL`         | 24 h                                | 服务端 token/会话有效期            |
| `CORS_ORIGINS`           | Viewer 部署域                       | 不允许 `*`                         |
| `RATE_LIMIT_UPLOAD`      | 例如 10/min/租户                    | 上传限流                           |
| `STORAGE_DRIVER`         | `local` 或 `s3`                     | 单机/多机切换                      |

### 部署规格参考

| 规格      | 内存             | 并发解析                                 | 适用                   |
| --------- | ---------------- | ---------------------------------------- | ---------------------- |
| 开发/单机 | 8 GB             | 2（2×1.5G + 主进程/缓存）                | 本地开发、单机内网     |
| 小规模    | 16 GB            | 4–6                                      | 内部部署、几十人       |
| 生产      | 32 GB+，独立磁盘 | 按 `MEM_BUDGET / 1.5G` 计算，留 30% 余量 | 多租户需再加隔离与配额 |

原则：**先按“单 job 峰值”算并发，不要按 CPU 核数算**。解析是内存瓶颈，不是 CPU 瓶颈。

## 附录 C：与旧方案/已删除服务的关系

`docs/web-viewer-migration.zh-CN.md` 提出过 Node 服务方案；更早的代码里确实实现过一版，路径不是 `apps/viewer-server`，而是 **`apps/viewer/src/server/`**（配 `apps/viewer/src/web/api.ts`），在 `350a2f457`（2026-10-14，转静态前端）与 `c63c76d4c`（2026-10-15，移除 Node 依赖）两次提交中被删除，合计约 3475 行。删除后仓库加了反向门禁：`apps/viewer/scripts/standalone-smoke.mjs:9-31` 断言发布目录与 app 目录都不含 `server/`、`ecosystem.config.cjs`、`pm2-start.sh`、`runtime-package.json`；README 也写明“没有 Node 进程、PM2 或后端端口”。

从 git 恢复的旧服务要点（对本文设计有直接参考价值）：

- `node:http` 单端口同时服务 API 与静态站；cookie `viewer=<64hex>` 的 owner 会话；`/api/*` 未初始化 401；Origin 白名单默认 `127.0.0.1:11001`。
- 上传 1 GiB、文件表 64、会话 12、会话 TTL 30 min、小 JSON 8 KiB、worker RPC 60s；`Range` 媒体；`text-widths` 字宽回传；`worker_threads` 跑 PPTX 解析。
- 存储 `VIEWER_DATA_DIR`（默认 `runtime/.viewer-data`）+ TTL 清扫。
- altChunk：并发 2、HTML ≤16 MiB、`mkdtemp` + 60s 超时 + `browser.close()` 取消。
- URL 导入：DNS 预解析、默认禁私网、重定向 ≤5、45s 超时、`content-length` 与流式字节双上限。
- 发布：esbuild 双入口（server + pptx-worker）→ `dist/server/*.mjs`，`external: ['playwright-core']`，PM2 `max_memory_restart: 800M`、`NODE_OPTIONS=--max-old-space-size=768`，`pm2-start.sh` 装 nvm/Node22。

**为什么本文不把它复活**：

1. 产品边界已改为“纯静态 Viewer”（`REQUIREMENTS.zh-CN.md` B-01），且门禁测试会失败；把服务塞回 `apps/viewer` 等于同时改需求、测试与文档承诺。
2. 旧服务的进程模型是“主进程内 `worker_threads`”，且 PM2 上限 800M；对 1GB 文件来说这是**必然 OOM 重启**的配置。本文要求解析在独立子进程 + RSS watchdog，旧结构需要重做。
3. 旧服务的 DTO 仍是“服务端返回可渲染结果”，没有区分“解析阶段”与“DOM 阶段”，也没有统一契约；直接复用会把 DOCX 分页/PPT 字宽一致性问题带进来。

**仍然值得继承的资产**：`packages/viewer-services/src/docs/driver.ts`（Playwright + 本机 Chrome 的 `BrowserDriver`，当前无消费者）、`docs/decrypt.ts`、`docs/lazy.ts`；以及旧服务的限额/会话/TTL 数值。本文的 `apps/parse-server` 是这些经验 + 新契约 + 新内存纪律的重新实现，而不是回滚。

> v1.2 起后端确定要部署到服务器，旧服务里“cookie owner 会话 / 上传 1GiB / 会话 TTL / Range 媒体 / text-widths 回传”这些设计重新变得有参考价值；**不能继承的是** PM2 `max_memory_restart: 800M` 与 `--max-old-space-size=768`——那对 1GB 文件是必然 OOM 的配置。v1.3 起不做 DOCX 后端，旧服务的 altChunk/Chromium 部分本期不需要。

与 `docs/web-viewer-migration.zh-CN.md` 的关系：

- 保留其核心判断：Node 负责入口/存储/任务，PPT 字体测量闭环，DOCX 分页留在浏览器（本期不做 DOCX 后端，未来再虚拟化），altChunk 用 Playwright（本期不需要）；XLSX 用 sidecar 一条本期不接。
- 修正其边界：不再把“整个 Viewer”迁到服务端，而是把**解析阶段**做成可选后端；Viewer 静态站保持可用。
- 补齐其缺失：统一契约、切换策略、1GB 内存纪律、进程隔离、配额/背压、缓存落盘、parity 验收。

## 附录 D：仓库内可引用的实测数据（不是本文实测）

| 数据                                           | 数值                                                                                                                | 来源                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| DOCX 分页 renderer 工作集（DOCX 后续版本参考） | ≈300MB + 17KB/block + 150B/char；30k blocks/3M chars → 1.26GB/1945 页/17s；20k blocks/14M chars → 2.8GB/4080 页/32s | `apps/docs/src/renderer/large-document.ts:1-34`     |
| DOCX 拒绝线（DOCX 后续版本参考）               | 权重 >230k（≈2.8GB）直接拒绝                                                                                        | 同上 `HUGE_DOC_REFUSE_WEIGHT`                       |
| XLSX Full Load（本期不接，仅参考）             | 1M stored cells ≈280MB heap / ~800MB renderer RSS；20M box cells ≈1.1GB heap                                        | `apps/sheets/src/renderer/app-constants.ts:62-79`   |
| XLSX 重算（本期不接，仅参考）                  | IronCalc 冷导入 ≈460B/cell（8.7M cells ≈4GB），超 64MiB/2M cells 禁用                                               | `apps/sheets/src/renderer/univer-sync.ts:2560-2576` |
| zip bomb 事故                                  | 亚 MB 输入造成 794MB / 3.12GB RSS                                                                                   | `packages/zip-gate/src/index.ts` 文件头注释（#759） |
| 旧 Viewer 服务上限                             | `--max-old-space-size=768`、PM2 `max_memory_restart: 800M`                                                          | git `c63c76d4c^:apps/viewer/ecosystem.config.cjs`   |
| Electron IPC 1GB 事故                          | IPC 回复序列化整份 buffer 打爆主进程                                                                                | `apps/docs/src/main/byte-handoff.ts:4-9`            |

用途：阶段 0 的 1GB 探针应把这些“既有测量”替换成本环境的真实 RSS/时间曲线；在此之前，§6 的峰值都是推导值。

## 附录 E：修订记录

### v1.3（2026-11-03）

按“先不做 DOCX”修订：

1. **DOCX 后端整体推迟**：后端解析范围收窄为 **PPTX / PDF**；Viewer 保留现有本地 DOCX 预览（小文件），大 DOCX 明确提示不支持，不静默失败。DOCX 的流式解析/分页虚拟化设计移入附录 F 作为预留方案。
2. **删除 DOCX 相关设计**：§2.1 阶段表、§4.2/4.2.1、§5.4 流水线、§5.5/5.6、§5.10 资源映射、§6、§7、§8、§9、§10 中的 DOCX 后端内容；`UnitKind` 收敛为 `slide | pdf-page`。
3. **删除 altChunk/Chromium 依赖**：本期不做 DOCX altChunk，服务端不需要 Playwright/Chromium；§5.1 进程模型、§5.11 部署、§7.4 约束同步简化。
4. **§6 重写为“PPTX/PDF 的 1GB 方案”**：PPTX 随机访问 + 按 slide materialize + 媒体外置 + 字宽回传；PDF Range + HTTP URL。
5. **计划缩短**：§8 改为“探针 → 服务端 MVP → PPTX 大文件 → 服务器化 → 验收”，总工期粗估 **8–12 周**；DOCX 不再是关键路径。
6. **验收/风险更新**：§9 用 PPTX 1GB 专项替代 DOCX 分页虚拟化专项；§10 重写为 PPTX 字宽闭环/随机访问/服务器化/加密等风险，并明确“DOCX 推迟”的产品边界。

### v1.2（2026-11-03）

按已确认的四条范围决定修订：

1. **范围收窄为 Viewer + 服务器后端**：只做 `apps/viewer`（Web），后端将来部署到服务器；支持 PPTX/PDF/DOCX；**不接 XLSX**；**不做桌面端集成**；不做独立 MD/HTML Viewer。相关章节（§1.2 桌面接缝、§7.4）标记为非目标或仅参考。
2. **DOCX 1GB 从“建议限制”改为“硬目标”**：§6 重写为“后端流式 tokenizer → block chunk + 前端分页虚拟化”的具体设计（增量分页、页描述、虚拟列表、锚点跳转、字体重排、搜索、内存预算、降级）；删除“先限制到 100–200MB”的结论。
3. **删除 XLSX**：从 §1 表格（标记不接）、§2.1 阶段表、§4.2/4.2.1、§5.4 流水线、§5.6 上限、§5.10 资源、§6、§7、§8、§9 中移除；`DocFormat` 收敛为 `'docx' | 'pptx' | 'pdf'`。
4. **新增 §5.11 服务器部署与安全**：拓扑、鉴权/租户、存储抽象（本地→S3）、可观测性/运维、公网安全清单。
5. **计划重排**：§8 改为“探针 → 服务端 MVP → PPTX 大文件 → DOCX 后端流式 → DOCX 前端虚拟分页 → 服务器化 → 验收”，明确 DOCX 为关键路径，总工期粗估 15–22 周。
6. **验收/风险更新**：§9 增加 DOCX 分页虚拟化专项与服务器部署专项；§10 重写为 DOCX 虚拟化/流式 tokenizer/服务器化/加密/上万页 UX 等风险。
7. **简化本地路径**：本地解析只服务小文件/离线，不再要求 `ByteSource` 改造与 host→iframe `File` 交接（服务器模式上传即可）；`file-parse` 不在本期范围。
8. **附录**：B 增加 DOCX chunk/页缓冲/服务端参数；C 说明旧服务在服务器部署下的参考价值与不可继承项；D 标注 XLSX 数据仅参考。

### v1.1（2026-11-03）

按评审意见修订：

1. **新增 §5.10 资源存储与分发**：现状表（各宿主怎么存/怎么取）、内容寻址 + 不抽取 + Range 的后端设计、与现有代码的映射、三条“不要做”。
2. **修正 §1.1 事实错误**：Viewer 的 1GiB 门槛只覆盖 URL 与“无扩展名需嗅探”的本地文件；已知扩展名的本地文件直接放行、不检查大小（`host.tsx:78-83`）。
3. **契约改为可渐进**：`DocModel.unitCount`/`assetCount` 改为可选；新增 `ParseSession.assets(cursor)` 分页；删除含糊的 `UnitKind 'page'`；`AssetRef` 增加 `sha256`/`partPath`/`transform`。
4. **会话创建改为异步**：`POST /v1/sessions` 返回 202 + `sessionId`，不再同步返回完整模型；新增 `GET /v1/capabilities`。
5. **补 `blocked` 决策**：`decideProvider` 在“超大且无可用后端 / 强制本地超限 / 隐私模式超限”时返回 `blocked`，不静默回退本地。
6. **补前置条件**：§7.2 增加“解析器入口接受 `ByteSource`”；明确 host→iframe 需要 `postMessage`/`MessagePort` 传 `File`；§8.1 第 3 步改为“先改入口再改 I/O”。
7. **补范围缺口**：§10 增加 Viewer 无 XLSX UI、桌面端切换接缝、CORS/CSP、i18n/主题/根脚本、远程鉴权租户。
8. **补验收与参数**：§9 增加资源一致性/资源内存/资源安全专项；附录 B 增加 `MAX_ASSET_BYTES`、`ASSET_CACHE_MAX_BYTES`、`MEDIA_HEAD_BYTES`、`THUMB_MAX_PX`。
9. **工期提醒**：明确“同一核心两宿主”需要重写 zip/parse 层，资源存储/路径授权等未计入粗估。

### v1.0（2026-11-03）

初稿：现状审计、阶段可迁移模型、`parse-contract` 契约、`apps/parse-server` 架构、1GB 逐格式推演、接入点与实施计划。

## 附录 F：DOCX 预留设计（本期不做）

> 本附录保留 v1.2 的分析，供未来版本启动 DOCX 后端时直接使用；本期不实现、不排期。

### F.1 为什么推迟

DOCX 1GB 需要两件独立的大工程，且互相耦合：

1. **后端流式解析**：`word/document.xml` 可能 2–5GB，必须流式 tokenizer → block chunk，不能 `file.async('string')`。
2. **前端分页虚拟化**：现有 Word 预览是“整篇一个 Tiptap editor + 全量分页”；1GB 文档全量分页要 3–10GB（实测 20k blocks / 14M chars 已到 2.8GB），必须改成“按页/按块挂载的只读视图”。

任一侧不做，1GB DOCX 都不成立；而分页虚拟化还会触碰“沿用原渲染方式”的验收口径（Tiptap 局部挂载是否可行需 spike）。

### F.2 未来接入时的最小设计

| 层   | 设计                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约 | 新增 `unitKind: 'block-chunk'`（本期已从 `UnitKind` 移除）；`DocModel.unitCount` 可为未知；chunk 带 `docxIndex` 锚点                                                       |
| 后端 | 随机访问 zip；读小 part（styles/numbering/settings/rels/页眉脚注）；`document.xml` 流式切 block（~500/chunk）；chunk 落盘 + 游标；媒体 `AssetRef` + 懒加载；服务端不做分页 |
| 前端 | 增量分页 → 页描述（`pageIndex/blockRange/height/anchors`）→ 虚拟列表（可见页 ±3）→ 锚点跳页（最近 checkpoint 重排）→ 字体重排 → 跨 chunk 搜索                              |
| 渲染 | 优先沿用 Tiptap 节点/分页 DOM 的“按页/按块只读挂载”；若 spike 失败，才考虑只读页渲染器，并重新评审验收口径                                                                 |

### F.3 启动前必须通过的 spike

1. **流式 tokenizer**：同一 fixture 的流式 block 序列（`docxIndex` + 文本 + 关键属性）与现有全量 `parseDocx` 一致；覆盖跨段表格、修订、`sdt`、`sectPr`。
2. **Tiptap 局部挂载**：多实例/按页挂载下，表格、修订、脚注、浮动对象行为与整篇 editor 一致；页高测量可增量进行。
3. **页描述/虚拟列表**：10k+ 页滚动、跳页、搜索、字体重排的内存与稳定性达标。

### F.4 产品边界（本期）

- 大 DOCX（超过本地阈值）在 Viewer 中明确提示“暂不支持服务端解析”，不静默截断、不假装成功。
- 本地小 DOCX 预览保持现状（浏览器 Worker + Tiptap + 分页），不因本期后端改造而回退。
- 若未来启动 DOCX 后端，按 §F.2 接入，不改动 PPTX/PDF 的契约与流程。
