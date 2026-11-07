# GenOffice Web / 移动 / 服务端运行工作流

整理日期：2026-11-06。基于 `apps/viewer`、`apps/viewer/android-demo`、`apps/parse-server` 及 `packages/viewer-renderers`、`packages/viewer-services`、`packages/parse-contract`、`packages/zip-reader` 的源码审查。

本文回答一个问题：**Web 端、Android 端和解析服务各自是怎么跑起来的，一次文件预览在三端之间如何流转。**

---

## 0. 总览

三端围绕同一个契约（`packages/parse-contract`，`/v1` HTTP API）协作：

```text
                 ┌──────────────────────────────┐
                 │   apps/parse-server (Node)   │
                 │   127.0.0.1:8787  /v1/*      │
                 │   内容寻址存储 + 会话 + worker │
                 └───────▲──────────────▲───────┘
            上传/会话/units│              │下载离线包(units+媒体+字体)
     ┌─────────────────────┘              └──────────────────────┐
     │                                                     ┌────┴─────────────┐
     │                                                     │ android-demo     │
┌────┴────────────────────┐   iframe preview.html         │ BundleDownloader  │
│ apps/viewer (Web, 静态) │◄──── host.tsx 塞参数 ──────┐   │ LocalAssetServer │
│ Vite 构建，无后端进程     │                           │   │ (127.0.0.1 回放)  │
│ host(壳) + preview(渲染) │                           │   │ WebView          │
└─────────────────────────┘                           │   └──────────────────┘
                ▲ 浏览器 Worker 本地解析（小文件）      │
                └── pptx-engine / docx-engine / PDF.js ┘
```

- **Web 端（`apps/viewer`）**：纯静态站点（Vite 构建），可完全本地解析，也可把解析切到服务端（`?parse=server` / `?parse=auto`）。
- **服务端（`apps/parse-server`）**：独立 Node HTTP 服务，负责大文件的内容寻址存储、PPTX/DOCX 会话化解析、PDF Range 读取。
- **移动端（`apps/viewer/android-demo`）**：WebView 壳应用，把服务端"已解析的模型"整包下载到本地，再由一个 loopback HTTP 服务离线回放给同一份 Web Viewer。

核心原则（来自架构文档 `docs/parse-backend-architecture.zh-CN.md`）：

1. 解析是一条流水线（① 容器索引 → ② 字节→模型 → ③ 版面/渲染树 → ④ DOM 测量 → ⑤ 资源解码），①②③ 可在服务端，④ 必须在浏览器（字宽实测），⑤ 走 URL + Range 按需取。
2. **字节永远不进 JSON / IPC**：上传流式落盘，读取走 Range 206，服务端任何时刻只持"窗口"不持整份文件。
3. 解析跑在独立 `worker_threads` worker 里，带超时与内存上限，一个 job 崩溃不拖垮服务。
4. 媒体不抽取、不 base64，留在原容器里按 part 路由 + Range 读。

---

## 1. Web 端运行工作流（`apps/viewer`）

### 1.1 启动与构建

```sh
npm run dev -w @genoffice/viewer        # 开发：http://127.0.0.1:11001（Vite 监听 0.0.0.0）
npm run package -w @genoffice/viewer    # 发布：apps/viewer/releases/genoffice-viewer/ 纯静态目录
```

- 开发服务器会把 `/v1` 同源代理到 `PARSE_SERVER_URL`（默认 `http://127.0.0.1:8787`），因此常用链接只需 `?parse=server&fileId=<id>`，不需要 `server=` 参数。
- 发布产物是静态网站（HTML + Worker + 字体 + PDF.js 资源 + 预生成 `.gz` + `nginx.conf`），无 Node 进程、无 PM2、无后端端口；生产环境用同样的 `/v1` 反向代理接到 parse-server。

### 1.2 双文档结构

| 页面 | 入口 | 职责 |
| --- | --- | --- |
| **host**（`index.html` / `upload.html`） | `src/web/host.tsx` | 文件栏：打开本地文件、导入 URL、上传到服务端、解析位置切换（自动/本地/服务端） |
| **preview**（`preview.html`） | `src/web/preview.tsx` | 真正的渲染页，由 host 通过 **iframe** 加载，参数经 query 传递 |

host 通过 `preview.html?src=<blob或内容URL>&format=<pptx|pdf|docx>&server=&fileId=&token=&layout=&contentUrl=...` 把一切交给 iframe；iframe 内 lazy-load 对应格式组件。

### 1.3 打开文件流程（host.tsx）

```text
来源 = 本地 File（有已知扩展名） ──► 不读入内存，直接交给 iframe 用 URL
来源 = 本地 File（无扩展名）     ──► 读完字节 → formatOf() 嗅探（%PDF- / PK zip / OLE）
来源 = URL                      ──► fetch（需 CORS）→ Content-Length 预检 → 读字节 → 嗅探

上限检查：
  所有来源        MAX_BYTES = 1 GiB（URL 先看 Content-Length 再比对实际长度）
  DOCX + 本地模式  DOCX_LOCAL_MAX_BYTES = 32 MiB（超出明确报错，大 DOCX 走服务端）

解析模式 resolvedMode：
  local  → 浏览器解析
  server → 上传：POST /v1/files（带 Bearer token 可选）→ {fileId} → remote target
  auto   → 文件 > AUTO_REMOTE_BYTES(64 MiB) 时走 server，否则 local

结果：URL.createObjectURL(file) → iframe preview.html
  PDF + token 模式额外先取 GET /v1/files/:id/content-url（HMAC 签名 URL，PDF.js 无需 Authorization）
```

### 1.4 preview.tsx 格式路由

```text
format === 'pptx'          → <Slides>      本地模式：pptx-browser-worker（Worker 里 openPptx）
                                           服务端模式：pptx-remote-session / pptx-model-session
format === 'pdf'           → <Pdf>         PDF.js getDocument({url})（blob URL / 签名 contentUrl / /v1 content）
format === 'docx' + server → <DocsServer>  服务端 block-chunk 会话，懒加载 + 页面虚拟化
format === 'docx' 本地      → <Docs>        浏览器 Worker parseDocxOffThread + Tiptap 只读节点 + DOM 分页
```

### 1.5 PPTX 的两条服务端路径

| 路径 | 文件 | 排版位置 | 触发条件 |
| --- | --- | --- | --- |
| **服务端渲染树** | `pptx-remote-session.ts` | 服务端 `buildRenderSlide`（启发式度量起步） | `?layout=server` |
| **客户端排版**（默认） | `pptx-model-session.ts` + `pptx-model-worker.ts` | 浏览器 Worker 用解析模型重排，字宽由 canvas 实测回填 | 默认；Android 端也是这条 |

两条路径实现同一个 session 接口（`open / loadUnit / …`），`open` 只取 model + 第一页，翻页、可见缩略图按需 `loadUnit`，放映前再补齐剩余页。

**字宽回传闭环**（两端一致的核心机制）：

```text
服务端：buildRenderSlide（启发式度量）→ 返回待测量项 measurements[]
浏览器：FontFace 加载内置度量字体（Carlito/Caladea/Liberation/Noto）+ 会话嵌入字体
        → canvas measureText 实测
        → POST /v1/sessions/:id/text-widths {widths:[{key,width}]}
服务端：清空缓存渲染树 → 用实测宽度重排已加载页 → 返回剩余 measurements
浏览器：只重排依赖这些 key 的页；首屏、懒加载页、放映预加载后都跑同一循环
```

### 1.6 UI 链接参数

`host` 与 `preview` 共用一套显示开关：`embed`（嵌入模式全关）、`showHeader / showImport / showUrlImport / showToolbar / showSidebar / showErrors`；`url` 参数可在加载后自动导入直链文件；`theme` 可强制明暗（供 Android 宿主匹配自身 chrome）。性能数据可通过 iframe 内 `window.__viewerPerformance`（stages/worker）排查。

### 1.7 已知限制

- 仍需读取并解压整份 PPT（本地模式），初始排版覆盖全部页面；超大文件首次解析成本仍在。
- 含 HTML/MHT altChunk 的 DOCX 在页面明确提示无法转换（Web 端硬失败）。
- PDF、Word 的加载路径未做本轮优化。

---

## 2. 服务端运行工作流（`apps/parse-server`）

### 2.1 启动与配置

```sh
npm run dev -w @genoffice/parse-server   # node --import tsx src/bin.ts
# → http://127.0.0.1:8787，数据目录 ./.parse-server-data
```

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `PARSE_SERVER_PORT / HOST` | `8787` / `127.0.0.1` | 监听地址（建议反代前保持 loopback） |
| `PARSE_SERVER_DATA_DIR` | `.parse-server-data` | 内容存储、元数据、临时上传、chunk |
| `PARSE_SERVER_TOKEN` | 无 | 设置后非公开路由要求 `Authorization: Bearer` |
| `PARSE_SERVER_ALLOWED_ORIGINS` | 空 | CORS 白名单（逗号分隔） |
| `PARSE_SERVER_MAX_UPLOAD_BYTES` | 2 GiB | 上传上限 |
| `PARSE_SERVER_PARSE_TIMEOUT_MS` / `WORKER_MEMORY_MB` / `MAX_SESSIONS` | — | worker 超时 / 内存 / 并发会话上限（超限 429） |
| `MYSQL_*` | 无 | 开启 MySQL 持久化（`parse_files` / `parse_sessions` / `parse_chunk_manifests` 三表） |

### 2.2 API 面（v1）

```text
GET    /v1/health                  {ok, sessions, activeWorkers, errors, memory, …}
GET    /metrics                    Prometheus 文本
GET    /v1/capabilities            契约版本 + formats(pptx/pdf/docx) + stages + limits + fontSetHash

POST   /v1/files                   流式上传 → {fileId(sha256), size, format}
GET    /v1/files/:id               元数据
GET    /v1/files/:id/content       Range / ETag / HEAD（PDF 主路径）
GET    /v1/files/:id/parts/:path   OOXML part（媒体/图表），stored 支持 Range，deflated 流式解压
GET    /v1/files/:id/content-url   token 模式下的 HMAC 签名内容 URL（?exp=&sig=）
DELETE /v1/files/:id               活跃会话存在时 409 file_in_use

POST   /v1/sessions                {fileId,width?} → 201 {sessionId, state, model, fonts}
GET    /v1/sessions/:id            {state, model}（也作心跳）
GET    /v1/sessions/:id/units      单元摘要（cursor/limit，≤500/页）
GET    /v1/sessions/:id/units/:id  PPTX: {slide, playback, measurements}
                                  DOCX: {blocks}（block-chunk，200 blocks/chunk）
POST   /v1/sessions/:id/text-widths  字宽回传 → 重排 → 剩余 measurements
GET    /v1/sessions/:id/fonts/:id  嵌入字体 sfnt 字节
DELETE /v1/sessions/:id            释放会话
```

`capabilities` 声明的阶段能力：`pptx: [index, model, layout]`、`pdf: []`（PDF.js 自绘）、`docx: [index, model]`。

### 2.3 上传与存储（内存纪律）

```text
POST /v1/files（请求体即文件流）
  → 边流式写临时文件边计算 sha256，全程不 Buffer.concat 整份
  → 原子移动到 files/<sha256[0:2]>/<sha256>（内容寻址，天然去重）
实测：1 GiB 上传 ~867 MB/s，服务端峰值 RSS ≈103 MB（上传路径不缓冲整份文件）
```

### 2.4 PPTX 会话流水线（大文件不爆内存的关键）

```text
POST /v1/sessions {fileId}
 1. slimPptxFile：用 @genoffice/zip-reader 只读中央目录，
    把所有"非媒体" part 拷进一个 stored-only 的瘦 zip；ppt/media/* 留在磁盘
 2. 每个会话一个 worker_threads worker（--max-old-space-size + RSS watchdog），
    在 worker 里 openPptx 解析瘦包（maxParseBytes 默认 256 MiB XML，而非原文件大小）
 3. GET units/:index → buildRenderSlide（启发式度量）+ playback + measurements
    渲染树里的媒体引用改写为绝对 URL：/v1/files/:id/parts/<partPath>
 4. 浏览器回传字宽 → 服务端清缓存重排 → 循环直到无待测量项
 5. 会话内嵌字体（ppt/fonts/*.fntdata）经 /v1/sessions/:id/fonts/:fontId 下发

实测：256 MiB deck（空白页 + 256 MiB stored 媒体）开会在 ~22 ms、RSS 增量 ~0.5 MiB
故障隔离：解析超时 → 504 parse_timeout；worker OOM → 422；并发超上限 → 429；
         /v1/health 全程 200 不受影响
```

### 2.5 DOCX block-chunk 会话（Gate A.3）

```text
createDocxBlockParser 解析 word/document.xml → 顶层 block 切分 → 200 blocks/chunk
chunk 持久化 <dataDir>/chunks/<sessionId>/（manifest.json + chunks.bin，含偏移与 SHA-256）
正文图片改写为 /v1/files/:id/parts/... URL；嵌入字体走 session fonts 路由
重启后从 sessions.json + 磁盘索引恢复，worker 懒重建（首个 unit/fonts/text-widths 请求时）
```

注意：这是 block 级会话，**不是** 1 GB DOCX 全方案——前端分页虚拟化已推迟（见架构文档附录 F）。

### 2.6 生命周期、可观测性与持久化

- **会话持久化**：元数据原子写 `<dataDir>/sessions.json`；TTL 清扫过期会话。
- **GC**：周期清理超过 `CONTENT_TTL_MS` 的未引用内容、执行 `MAX_STORE_BYTES` 容量上限（最旧未引用优先）、清临时上传。
- **日志**：每请求一行 JSON（`http_request`：requestId/method/path/status/duration），错误额外 `request_error`。
- **指标**：`/metrics` 输出请求/响应计数、duration histogram、错误、uploads/bytes、sessions/workers、存储、uptime、进程内存。
- **MySQL（可选）**：文件与会话元数据入库，大内容字节与 chunk 仍留在本地磁盘；Viewer 不直连 MySQL。

### 2.7 压测工具

```sh
npm run stress       -w @genoffice/parse-server -- --url … --size 1G --sessions 6   # 1GiB deck + 并发 + 超时注入
npm run stress:docx  -w @genoffice/parse-server -- --url … --file /tmp/docx-large-real.docx
npm run fixture:docx-large / fixture:docx-1g   # 生成合成大 DOCX
```

---

## 3. 移动端运行工作流（`apps/viewer/android-demo`）

一个"离线演示"壳应用（`com.genoffice.viewerdemo`，Java，AGP 8.10.1 / compileSdk 35），把 Web Viewer 嵌进 WebView 并从解析服务下载**已解析的模型**离线渲染。

### 3.1 构建

```sh
# 1. 先构建 Web Viewer 发布目录（Gradle 同步进 APK assets）
cd apps/viewer
VIEWER_BASE=/viewer/ node scripts/build.mjs
rm -rf releases/genoffice-viewer && mkdir -p releases/genoffice-viewer
cp -R dist/web/. releases/genoffice-viewer/

# 2. 构建 APK
cd android-demo && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

四个核心类：`MainActivity`（设置页 + WebView 壳）、`BundleDownloader`（离线包下载）、`BundleStore`（`files/bundles/<fileId>/` 存储）、`LocalAssetServer`（127.0.0.1 loopback HTTP 回放）。

### 3.2 下载离线包（BundleDownloader）

```text
输入：解析服务地址 + fileId(sha256) + 可选 token（设置页或 adb intent 传入）
 1. POST /v1/sessions 建会话；后台线程每 60s GET /v1/sessions/:id 心跳（下载大媒体期间也续期）
 2. GET /v1/sessions/:id/layout → 写 layoutInfoFile（尺寸/页数/字体表）
 3. 逐页 GET /v1/sessions/:id/layout/slides/<i>
    → rewrite()：把模型里的绝对 .../v1/files/<id>/parts/... URL 改写为同源相对路径
    → 写 layoutSlideFile(i)
 4. 收集模型引用的媒体分片（图片/音频/视频）与嵌入字体，下载到 bundle 目录
 5. 写 manifest.json + complete 标记（staging 完成后原子生效；更新失败保留旧包）
```

### 3.3 离线回放（LocalAssetServer + WebView）

```text
LocalAssetServer 绑定 127.0.0.1 随机端口，同一 origin 提供两类路由：
  /viewer/*  → APK assets 里打包的 Web Viewer 静态资源（构建时 VIEWER_BASE=/viewer/）
  /v1/*      → 按解析服务契约回放缓存包：
               sessions（POST 返回 model: stagesDone=[index,model,layout]）
               units/:i、layout、layout/slides/:i、fonts/:id（读缓存文件）
               files/:id/parts/*（RandomAccessFile 切片，支持 Range/206 → <video> 可拖进度条）
               text-widths（POST 直接返回 {}——离线模型保留服务端启发式布局）

WebView：JavaScript + DOMStorage 开启、mediaPlaybackRequiresUserGesture=false、
         allowFileAccess=false、keepScreenOn（放映不熄屏）
加载 URL：
  http://127.0.0.1:<port>/viewer/preview.html?src=bundle&format=pptx
    &server=<base>&fileId=<id>&layout=client&theme=dark
  （直接加载 preview 文档，跳过 host 壳，避免二次加载与白屏 frame）
首屏揭示：revealWhenReady 轮询 document.querySelector('.viewer-slide-stage canvas')
         或 [role=alert]，配合 postVisualStateCallback 再撤掉原生 loading
```

**同源设计**是关键：页面与 `/v1` API 同 origin → 无 CORS、canvas 不被跨域污染、音视频直接播本地缓存文件。渲染走 Web 端同一条 `pptx-model-session` + `pptx-model-worker` 客户端排版路径。

### 3.4 联调

```sh
# 电脑上起解析服务（8790），上传拿 fileId
cd apps/parse-server && PARSE_SERVER_PORT=8790 PARSE_SERVER_DATA_DIR=/tmp/parse-demo-data \
  node --import tsx src/bin.ts
curl -X POST --data-binary @deck.pptx http://127.0.0.1:8790/v1/files

adb reverse tcp:8790 tcp:8790     # 设备经 USB 访问电脑服务
adb shell am start -n com.genoffice.viewerdemo/.MainActivity \
  --es server http://127.0.0.1:8790 --es fileId <sha256> --ez download true
```

### 3.5 已知限制

- 放映按当前页窗口（±1 + 可见缩略图）淘汰离屏模型、渲染树与测量缓存；回访需重新拉取（公网延迟明显）。
- 在线会话每分钟续期；媒体签名默认 12 小时有效，超时需重新打开。
- 离线包按 fileId 存放，无空间回收与多包管理。
- 演示允许 `127.0.0.1` 明文 HTTP（`network_security_config.xml`）；正式产品应使用 HTTPS。

---

## 4. 三端联动：一次预览的完整时序

### 4.1 Web · 服务端模式打开大 PPTX

```text
用户(host.tsx)                parse-server                     iframe(preview.tsx)
  打开文件/auto(>64MiB)
  ├─ POST /v1/files ───────► 流式落盘 + sha256
  │◄──────────────────────── {fileId}
  ├─ createObjectURL(file) + iframe 参数注入 ──────────────► Slides 组件
  │                                   POST /v1/sessions ──► slim + worker openPptx
  │                                   ◄── {sessionId, model, fonts}
  │                                   GET  units/0 ────────► buildRenderSlide(启发式)
  │                                   ◄── {slide, playback, measurements}
  │   浏览器 FontFace 加载(内置度量字体+嵌入字体)，
  │   canvas 实测 → POST text-widths ─► 服务端清缓存重排
  │   ◄── 剩余 measurements（循环直到清零）
  │   翻页/缩略图 → GET units/:i 按需；放映前补齐
  │   <img>/<video> → GET files/:id/parts/* (Range)
```

### 4.2 Android · 离线打开

```text
设置页(server+fileId)
  ├─ BundleDownloader: 建会话 → layout → 逐页模型(URL改写) → 媒体 → 字体 → manifest+complete
  ├─ LocalAssetServer.startAndWait() (127.0.0.1:随机端口)
  └─ WebView.loadUrl(preview.html?src=bundle&layout=client&theme=dark)
        → 全部请求命中本地回放（同源、Range、无 CORS）
        → Worker 客户端排版 + 字体回填 → 首个 canvas 绘出后撤 loading
```

### 4.3 职责分界（对外表述）

| 角色 | 负责 | 不负责 |
| --- | --- | --- |
| 浏览器前端 | 渲染、DOM 测量/分页、字体加载、交互、按需取资源、小文件本地解析 | 大文件整份读入、CPU 密集解析的可靠性 |
| 解析服务 | 容器索引、XML→模型、PPT 版面、缓存、限流与 worker 隔离 | DOM 分页、最终绘制、字体实测（必须回传浏览器结果） |
| Android 壳 | 会话下载与 URL 改写、本地回放服务、WebView 生命周期 | 任何解析/排版逻辑（全部复用 Web Viewer） |

---

## 5. 关键设计约束速查

1. **契约唯一**：`packages/parse-contract` 是唯一 DTO（`DocModel / Unit / AssetRef / Capabilities`），UI 只认契约不关心解析在哪发生；`parserVersion` / `fontSetHash` 不一致时不得混用两端结果。
2. **字节不进 JSON/IPC**：一切二进制走 URL + Range；派生模型单响应 ≤1–2 MB，超出分页/游标。
3. **一文件一 worker**：PPTX/DOCX 会话各占一个 `worker_threads` worker（超时/内存上限可终止），HTTP 事件循环不跑解析。
4. **媒体外置**：`ppt/media/*` 留在原容器，渲染树引用 `/v1/files/:id/parts/*` 绝对 URL，浏览器按需取。
5. **字宽闭环不可省**：PPT 换行依赖浏览器实测字宽；省略回传步骤会导致换行/位置漂移。
6. **渲染方式不替换**：PPT 保留 Konva 静态绘制链，Word 保留 Tiptap 节点 + DOM 分页，PDF 保留 PDF.js；禁止"整份转图片/PDF"等替代路径。
7. **只读边界**：Viewer 产品面无编辑、无写回、无 AI；服务端不提供任何文档修改 API。

## 6. 相关文档索引

- 需求：`apps/viewer/REQUIREMENTS.zh-CN.md`；开发计划：`apps/viewer/DEVELOPMENT_PLAN.zh-CN.md`；交付状态：`apps/viewer/IMPLEMENTATION_STATUS.md`
- 服务端架构全量设计（含 1GB 推演、附录 F DOCX 预留设计）：`docs/parse-backend-architecture.zh-CN.md`
- 无 Electron 移植调研（六格式研究）：`docs/web-viewer-migration.zh-CN.md`
- 稳定性回归验收：`apps/viewer/docs/resilience-validation.md`
- 移动端构建与联调：`apps/viewer/android-demo/README.md`
