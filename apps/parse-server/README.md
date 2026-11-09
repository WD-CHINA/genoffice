# 解析优化实施进度

更新：2026-11-07。对应方案：`parse-persistence-optimization.zh-CN.md`。整体目标仍在进行；磁盘持久化已接入实际预览，历史库保存/读取/移除已接入，生产任务与运维尚未完成。

## 已落地

- P0：创建会话在启动 worker 前预占并发名额，成功登记或失败后释放；恢复会话使用 single-flight。会话在恢复期间被删除时，关闭迟到 worker 并清理其记录。
- P0：未提供的 ServerLimits 不覆盖默认值；拒绝非正、非整数及非有限数值。
- P0：DOCX unit 响应递归重写内部资源 origin 并生成即时签名，不修改持久化 chunk；返回 private/no-store。
- P0：DOCX chunk 成功后才推进 cursor，成功重试清错误；增加 60 秒会话心跳。
- P0：DOCX 自动分流使用 32 MiB 本地上限；无扩展名本地文件在读取前检查 size。
- P0：DOCX 服务端预览先查询元数据，大文件直接进入分块模式，不先下载原文件 blob。
- P1 基础：新增 `artifact-store.ts`，规范化身份键、有限 JSON DTO 校验、二进制字体记录、增量 gzip 帧、偏移索引、哈希校验、同文件系统原子发布、失败 staging 清理及同进程任务去重。

- P1 接入：PPTX 模型/播放信息、DOCX chunks/样式、共享元数据、嵌入字体已落盘；关闭会话不删除共享产物，重启后新会话读缓存不重新解析。
- P1 接入：构建指纹包含解析相关源文件和 pnpm lockfile；产物键另含配置版本与 schema。缓存仅保存内部资源路径，读取时生成部署 URL 和签名。
- P1 接入：正文样式单独按需读取；同一存储实例的 reader 使用有界弱引用目录复用索引，避免相同文件多个会话重复持有索引副本。
- P2 部分：有界 FIFO 已接入，默认 2 个重解析/服务端布局任务、20 个排队任务，阅读会话默认上限 500（未做容量承诺）。缓存命中与同一产物的附着请求不占新的队列任务。
- P2：解析与旧服务端布局已迁移到独立 Node 子进程，保留结构化 IPC 协议，使用显式 JS bootstrap 注册 TS loader。所有源文件按路径读取；解析完成等待子进程退出后归还队列名额。
- P2：默认 8 GiB 总预算、单冷解析 4 GiB RSS 预留，布局默认 1 GiB，按 CPU 名额和内存双重准入；字宽仍只属于阅读会话。父进程独立 RSS 采样能中止子进程事件循环阻塞时的超限任务；另有堆上限和默认 10 分钟总生命周期。
- P2：提供 Linux cgroup v2 配置入口，父进程在允许解析前设置 memory.max/swap/oom.group 并分配子进程；配置失败不降级为无防护执行。开发机为 macOS，内核硬限制尚未实测，默认 RSS 看门狗存在采样间隔内的超限窗口。
- 观测：health 暴露队列、内存预留、隔离子进程的外部采样 RSS 和内存错误次数；Prometheus 增加对应 gauges，失败日志记录 PID/taskId/峰值 RSS，不输出子进程 stderr。
- P0：CLI 数字环境变量统一校验，支持明确允许的零值，拒绝空串/NaN/负数/小数与溢出定时器；服务启动前检查 heap < RSS <= 总预算，避免先创建数据库资源后才发现配置错误。
- 历史库：新增 `/v2/library` 保存、游标列表和移除引用接口；文件模式原子持久化 library.json，损坏时拒绝启动，避免误删历史。MySQL 模式新增 library_entries 唯一文件引用及外键保护。
- 历史库：显式保存的原文件跨重启保留，不被 TTL/容量 GC 删除；直接删除已保存或活跃读取的文件返回 409。移除历史引用后恢复临时回收策略。
- 生命周期：文件级锁与读租约覆盖保存、原文件/模型/字体读取和会话创建；GC 删除前重新检查引用，保护在建 DOCX chunk。上传入库串行检查原文件及产物大小；重复上传不刷新创建时间，容量失败不误删已保存的旧文件。
- Web：上传页新增历史资源保存/列表/打开/移除，与本机最近上传分开；服务地址、token 和 /viewer/ base 在导航中保留，Vite/nginx 均补充 v2 转发。
- 运行验证发现并修复：独立 worker TS 入口不能稳定依赖父进程 --import tsx；新增 JS bootstrap，显式注册 tsx 后加载解析入口。

- v2 异步会话：冷访问返回 202，客户端轮询 queued/building/ready/failed；缓存命中返回 201。队列溢出返回 429，同产物共享构建，取消一个阅读会话不会中止其他请求共享的构建。
- v2 等待会话使用文件原子日志或 MySQL parse_pending_sessions 持久化，重启恢复；这是单实例等待日志，尚不是分布式任务租约。支持 v2 文件、document 和原始 units 接口，v1 保留兼容。
- Web 和 Android 接入异步等待，仅在 404/405 时回退 v1；失败与取消清理会话。Web 修复就绪时关闭页面的竞争，避免重新启动心跳。
- 打包修复 pnpm 嵌套依赖根目录识别，按包版本收集许可证。

- 损坏恢复：区分内容损坏与权限/I/O 故障，只有确定损坏的派生产物可重建；不删除原文件。重建复用既有 single-flight 与队列，旧的已检测损坏 reader 失效，避免继续输出。

- DOCX：独立阅读生命周期对象管理开会话、心跳与请求；404/410 自动重建轻量会话，按原游标重试一次。同批 chunk 成功后才提交去重标记，失败可重试；关闭后即使 fetch 忽略取消也拒绝迟到结果。切换文档重置块、测量及游标，旧请求不能清除新请求的加载锁。
- DOCX：修复异步测量被取消后仍占用“已测量”标记的问题，只有结果提交时登记。

- 磁盘：产物数据帧与 manifest 写入前按压缩字节增量预留，与上传提交共用准入锁；总额度包含原文件、已发布产物和并发预留。物理空闲检查保留 64 MiB，配额失败返回 507/异步 failed，清理 staging 并归还预留，health 可查看 reservedBytes。上传临时文件已逐块预留物理空间；DOCX scratch 已接入同一预算，闲置派生缓存压力回收已接入，高低水位已接入，跨进程租约尚未覆盖。

- 上传空间：临时数据逐块预留物理空闲，正常提交、格式拒绝与客户端断连均释放；提交检查扣除自身临时预留，避免原子移动后重复计费。临时上传在 hash/GC 前不受逻辑库配额限制，仍受单文件上限和保守物理空间检查约束。流管道失败保留 HTTP 响应能力，容量不足可返回明确 507。

- DOCX 临时空间：子进程通过独立 IPC 请求为每个压缩 chunk 和临时 manifest 预留主进程额度，父进程验证数量并返回错误码；worker 退出且 scratch 删除后归还额度。重建先清理同 ID 的遗留 scratch，避免未计费复用；chunk 写入补全短写循环。后续已接入下述正文流式路径。

- DOCX 流式路径：辅助 ZIP 使用最小 document 占位，不加载原正文；原 ZIP 条目分两遍读取元数据和块，每 200 块增量写入。ZIP CRC/实际长度验证、严格 UTF-8 解码、单块字符上限和不完整元素拒绝；修复缓冲区裁剪后的偏移错误。辅助 parts 在解压前检查 maxParseBytes，正文继续受 ZIP part/总量与单块限制。

- 缓存压力回收：上传提交和增量构建准入在不足时先回收旧解析版本，再按访问时间回收闲置产物；读取提示按 30 秒合并并尽力持久化到目录时间，重启沿用该时间。文件级锁内复核活跃读取、会话、等待者和构建，不删除历史原文件；源文件缺失或损坏索引无法确认归属时拒绝猜测回收。空间账本改为统计磁盘实际文件字节，不再依赖索引健康；health 增加 evicted/evictedBytes。

- 高低水位：逻辑配额默认超过 90% 尝试回收到 80%，提供有序整数环境变量配置；预算准入和 GC 共用目标计算。保护对象使水位无法下降时，只要仍符合硬上限可继续；预算路径的软压力失败扫描退避 30 秒，硬上限和物理空间始终复查。上传提交扣除自身已移动的预留，避免软水位重复计费。health.storageBudget 暴露阈值。

- 重启临时对账：监听端口前清扫超过一小时的已识别上传 .part、构建 staging 和无引用 DOCX 目录；保留新目录、未知名称及持久会话/等待日志引用。运行时跟踪活跃上传（含校验/提交期间）和构建目录，年龄不会覆盖所有权；周期 GC 同步执行 staging 清理，DOCX 孤儿清扫宽限最多一小时。仍是单实例年龄/日志对账，尚无跨进程租约与完整产物目录对账。

## 最近验证

- 本轮重启临时对账：服务端 110 项通过、3 项 MySQL 测试跳过；验证重启删除旧孤儿、保留新目录/未知名称/日志引用，周期 GC 保留等待会话目录；活跃上传与构建即使人为修改为旧时间仍可继续完成。类型检查和 ESLint 通过。

- 本轮水位控制：服务端 107 项通过、3 项可选 MySQL 测试跳过；验证跨高水位回收到低水位、小写入不重复扫描、活跃保护下退避仍不突破硬上限、无序/非法百分比拒绝启动，以及真实 HTTP 上传在硬配额以下即触发闲置缓存回收。类型检查和 ESLint 通过。

- 本轮缓存回收：服务端 103 项通过、3 项 MySQL 测试跳过；覆盖活跃阅读阻止回收、关闭后上传成功且保存原件仍在、扩容后重建、冷构建通过预算回收另一份缓存、旧版本/访问顺序跨重启，以及损坏索引仍计入容量。

- 本轮正文流式：99 项服务端测试通过、3 项 MySQL 测试跳过；真实 1201 段大正文在辅助 ZIP 预算仅 16 KiB 时成功生成 7 个持久块，逐段校验 Unicode 文本顺序；另验证懒批次背压、CRC 损坏、64 KiB 跨缓冲区偏移、单块超限与截断 XML。尚未完成 GB 正文/RSS 曲线验收。

- 本轮 DOCX 临时空间：94 项服务端测试通过、3 项 MySQL 测试跳过；真实 DOCX 在子进程申请空间失败时返回 507，scratch/worker/名额/预留归零，原文件保留，扩容重启后成功读取。

- 本轮上传临时空间验证：服务端 93 项通过、3 项可选 MySQL 测试跳过；覆盖逐块空间不足清理、真实 HTTP 507、真实 chunked 上传断连后归还与重传，以及格式拒绝清理。

- 本轮磁盘预留验证：服务端 88 项通过、3 项可选 MySQL 测试跳过；覆盖并发预算竞争、关闭配额仍检查物理空间、manifest 超额清理，以及真实 507 后原文件保留、扩容重启可成功重试。类型检查与本轮改动 ESLint 通过。

- 本轮损坏恢复验证：84 项通过，3 项 MySQL 集成测试因未启动实例而跳过；新增 4 项覆盖损坏索引/缺失数据、并发重建、同长度坏帧、元数据准入校验和真实 v2 API 重建。类型检查和本轮改动 ESLint 通过。

- 上轮 parse-server：83 项测试通过，包含隔离 MySQL 实例上的 3 项集成测试；除 P0/产物存储外，覆盖真实 PPTX/DOCX 在全部会话关闭、服务重启后的缓存复用、字体字节一致、图片鉴权、版本隔离、会话字宽隔离、队列 FIFO/溢出/关闭。
- 实际接口测试：一个冷解析占满队列时，10 个缓存阅读会话均可成功建立；另一个冷任务返回 429，缓存打开不重复调用解析入口。
- viewer：41 项测试通过，新增历史客户端错误处理与鉴权/服务地址传递测试。
- parse-server 和 viewer 类型检查通过。
- 改动文件 ESLint 无错误，`host.tsx` 初始化 effect 存在原有 exhaustive-deps warning。
- 真实 MySQL 9.7 隔离实例验证：跨重启保留、外键拒删、并发去重与分页、移除引用后 GC 均通过，未访问用户数据库。
- `npm run test:library -w @genoffice/viewer` 已通过本地 Chrome：保存失败注入与重试、真实 PPTX 预览、服务重启后的缓存复用、移除历史记录；截图 `/tmp/genoffice-library-ui/library-flow.png` 已检查。
- 新增子进程故障注入：不同 PID 和二进制 IPC、CPU 阻塞时 RSS 杀进程、总生命周期、异常退出、非法 cgroup 拒绝执行、PPTX/DOCX 内存失败后 HTTP 仍健康并可重试、队列内存归还均通过。
- 未进行 Linux 真实 cgroup OOM、Windows 内存采样、Android 真机、MySQL 产物/任务租约或 8 核 16 GiB 压测。

- Chrome 增补 65 MiB DOCX 容器远程分流验证：实际文档可见、使用 v2 且未下载原文件；在首次读取列表前真实删除会话，自动重开成功，解析产物构建数仅增加 1，确认恢复不重解析。截图已检查。这不代表大正文流式解析已完成。
- Android 主应用与 instrumentation APK 构建通过；新增异步就绪、兼容回退、429 与失败保留旧包用例已编译，未连接设备，未执行设备测试。

## 下一步（保持完整方案范围）

1. P0 的 DOCX 失效恢复、取消/重开隔离已接入并补故障测试；继续补复杂文档与长时阅读验证。CLI 与运行时配置校验已统一。
2. 补充复杂 PPTX 模型/渲染保真验证、损坏产物重建与完整资源依赖清单；上传准入已统计产物占用，已补产物增量写入预留，仍需补完整临时空间对账及跨进程压力回收。
3. 接入 MySQL 产物/任务索引、租约和 generation、崩溃对账与版本迁移；历史库索引及永久原文件引用已落地，跨进程生命周期仍待实现。
4. v2 异步会话及 Web/Android 等待状态已接入；继续补任务目录、跨进程租约与最后一个等待者取消后的调度策略。
5. 在 Linux 委派 cgroup 上验证内核 OOM/进程组清理，并补压力下的实际 RSS 曲线及关闭宽限期；独立子进程、内存预留、外部 RSS 看门狗已落地。
6. DOCX 正文双遍流式读取与批量落盘已接入；继续实现前端有界 chunk 缓存、构建期间增量首屏、Android 下载清单/校验/续传/空间管理和大正文压测。
7. 完成 GC/配额/备份恢复、压测与灰度回滚验收。

## 当前限制

ArtifactStore 已接入业务接口，但目前只支持单服务进程去重，没有跨进程租约、MySQL 产物/任务索引、完整临时空间预留或备份恢复。历史库按实例共享，尚无多用户归属。已支持损坏索引、缺失数据与已检测到的损坏帧在重开时单次重建；打开会话前校验 document 记录。尚未读取的页或字体不全量预校验，首次读取损坏帧仍返回错误，重开后修复。原文件与产物字节已纳入上传准入配额，产物写入已增量预留，上传临时文件已逐块保护，DOCX scratch 已接入预算，压力下闲置派生产物回收已接入，跨进程一致性与故障对账仍待实施；显式保存的原文件不会被自动删除。客户端仍保留小 DOCX 全量本地渲染。DOCX 已移除全量 document.xml、slices、blocks 与 parsedChunks 的持有，使用正文双遍流读取、最多 200 块一批落盘；辅助 parts、元数据索引和单个 XML 块仍在内存，单块上限 64 Mi UTF-16 字符。产物仍构建完后整体发布，尚无解析中的增量首屏。独立进程隔离及采样式 RSS 限制已验证；Linux cgroup 内核硬限制、真实 GB 正文压测、500 阅读会话压测及 Android 真机未完成。nginx 配置已补路由，但本机没有 nginx 可执行文件，尚未执行 nginx -t。


### Aged temporary data after restart

Before listening or resuming waiting sessions, the service reaps recognizable
UUID upload .part files, staging directories and unreferenced DOCX scratch older
than one hour. Fresh paths, unknown names and durable session/waiter references
are retained. Periodic GC also reaps staging and scratch orphans. In-process
ownership protects active uploads through validation/commit and active staging
builds even if their timestamps are old.

This is single-instance age/journal reconciliation. It does not establish shared
filesystem leases, recover a full artifact catalog or prove that another server
process has stopped; sharing one data directory remains unsupported.


## Authoritative PPTX offline bundles

`GET /v2/sessions/:id/bundle` lazily builds a persistent offline manifest after
PPTX readiness. It declares canonical model JSON, fonts with explicit
`resourcePath`, and every `ppt/media` ZIP entry, including unused media. Each
resource has its raw byte size and SHA-256. ZIP size/CRC are verified while
hashing. External media are reported separately; their availability is not
covered by the offline guarantee. Bundle schema is 1; model schema is 2.
Existing older model artifacts rebuild once from the retained source.

`GET/HEAD /v2/sessions/:id/bundle/resources/<path>` serves only declared paths,
with bearer authentication, private/no-store and SHA ETags. Buffered resources
and stored ZIP media support byte Range and If-Range; compressed ZIP media
fall back to a full 200 response. Manifest hrefs are session-specific.

The auxiliary artifact is keyed by the primary model artifact and its content
digest. It shares the bounded queue and reserves up to 512 MiB without launching
another source parser. Ordinary online preview does not hash all media.
Concurrent downloads share the build; closing a viewing session does not cancel
shared work. Queue saturation returns 429. Health `sourceParsesStarted` counts
source parsing; `buildsStarted` includes auxiliary artifact builds as well.


## MySQL artifact catalog foundation

`MysqlDatabase.init()` creates `parse_artifacts` and `parse_jobs`.
`MysqlArtifactCatalog` provides transactional claim, renewal, completion and
failure with database-clock expiry and generation fencing. Previous ready
metadata remains usable during a replacement build. Completion records only a
validated immutable generation path and manifest digest; the caller is
responsible for making those files durable before registration.

This catalog is not yet wired into ArtifactStore. Running multiple parse-server
writers against a shared data directory remains unsupported. Generation files,
read leases, reconciliation and publication integration must land together.
The real database tests are opt-in via `PARSE_TEST_MYSQL_SOCKET` and require an
isolated disposable instance; each test creates and drops its own database.


## Immutable generation disk layer

`ArtifactGenerations.publish()` reserves a generation exclusively, writes and
flushes the existing frame format, atomically renames staging, and synchronizes
directories before returning the manifest SHA and byte/unit summary. Existing
empty and complete generation paths are never replaced. `open()` validates the
catalog path, manifest digest and summary. Post-rename failures retain the
complete unregistered directory for reconciliation instead of deleting it.
Directory synchronization is required; unsupported filesystems fail publication.

The disk layer has a real MySQL fencing integration test but is not yet connected
to live ArtifactStore sessions. Shared-writer deployments remain unsupported
until read leases, publication coordination, recovery and generation GC land.


## Shared build coordinator foundation

`ArtifactCoordinator` combines catalog claims, periodic renewal, a conservative
monotonic lease watchdog and immutable disk publication. Readers may cancel
without cancelling shared builds. Lost leases and shutdown signal cooperative
builders; publication reconfirms ownership before SQL readiness. Ambiguous SQL
completion never causes generation deletion.

This remains a component, not the live session backend. Before enabling shared
writers it still needs read leases, generation-aware accounting/GC, worker abort
wiring, task-state mapping, migration, corruption recovery and reconciliation.


## Generation quota accounting

Artifact quota scans now include regular files recursively beneath each key,
including incomplete/unregistered generations and corrupt indexes. Symlinks
are not followed. The legacy collector skips keys containing subdirectories;
legacy eviction/recovery only removes its two top-level payload files and an
empty root, so a concurrently created generation cannot be recursively erased.
Generation-aware GC still requires catalog and reader-lease integration.
Reservation admission remains single-instance; this change does not establish
a global multi-process storage quota.


## Generation reader lease foundation

The catalog now supports `pin`, `renewRead` and `releaseRead` using database-clock
expiry and unique reader tokens. Pinning selects ready metadata and registers its
generation in the same artifact-row transaction. Old readers can renew after a
new generation becomes ready. Expired tokens observed during renewal are retired;
wrong owner/generation tokens cannot mutate another reader. Reader rows restrict
catalog deletion until released or safely reaped.

These leases are not yet wired into live HTTP/ArtifactReader lifetimes or the
collector. They establish the database protocol, not shared-filesystem read
protection on their own.


## Leased reader handle foundation

`ArtifactReadHandle.open()` pins the current generation before opening it and
provides guarded reads and metadata. Renewal and a monotonic local deadline
invalidate a lost lease. Its signal rejects waiters immediately; normal close
waits for underlying reads to settle before releasing the catalog token. Late
results are fenced, failed opens release their pin, and close is idempotent.

The handle is tested with real MySQL across publication and renewal failure,
but is not yet the live HTTP/ArtifactSession reader. Generation collection,
reader index sharing and lifecycle integration remain required. Close may wait
for OS/SQL work to finish; local cancellation is not a hard IO timeout.


## Generation retirement and collection foundation

`retireGeneration()` transactionally checks ready/build/read ownership before
recording an irreversible retirement. It retires expired reader tokens, fences
expired builders and prevents their subsequent mutations. `collect()` deletes
only that generation after the retirement transaction commits; SQL errors leave
files intact. Repeated collection handles late unreferenced writer output.
Retirement history also prevents silently resetting the generation counter by
deleting the catalog row. MySQL servers now schedule this collector automatically.

Generation staging uses a separate `gen-<key>-g-<n>-<uuid>` namespace, protected
from legacy UUID age-only cleanup. Lease-aware staging reconciliation, ready-cache eviction and final catalog/source
purging still need implementation. Candidate discovery and periodic scheduling
are enabled for MySQL, but generation-backed HTTP sessions and shared writers
remain unsupported.


## Generation candidate sweeper foundation

`ArtifactGenerationSweeper.sweep(limit, graceMs)` discovers canonical generation
directories and delegates every eligible deletion to transactional retirement.
It resumes across bounded batches, advances past protected/failed candidates,
retries on the next pass and reports sanitized error codes. Newer, unknown and
symlink entries remain untouched. Concurrent calls share one pass.

Defaults are 64 examined generations and a one-hour grace period. `hasMore`
requires caller-driven continuation; the live MySQL collection service now owns
periodic scheduling, continuation, retry backoff and shutdown. Lease-aware staging
reconciliation, pressure-admission integration and live generation sessions remain pending.


## Collection scheduling and shutdown component

`ArtifactCollectionService` owns explicit start/request/close, non-overlapping
passes, short continuation delays and periodic retries. Defaults are ten minutes
between full passes, 25ms between batches and one second error backoff; manual
requests cannot bypass backoff. Its snapshot contains bounded results and safe
error codes. Closing stops scheduling, closes the sweeper and drains current work.
The sweeper itself stops after its current collection and rejects new passes.

MySQL createParseServer now starts this service and drains it before closing the
pool. Source references are protected; live generation session/build lifetimes
and staging reconciliation still need integration before enabling shared writers. Legacy file-wide cleanup now avoids
recursive key deletion and skips generation layouts, including mixed directories.


## Catalog source retention in live server paths

MySQL servers now include artifact catalog references in `fileInUse`. TTL/quota
cleanup, explicit file deletion and failed-upload cleanup preserve referenced
sources and their legacy cache. DELETE returns `file_in_use` (409); database
lookup errors fail closed. A real HTTP/restart test covers preservation and
normal expiry after the test reference is removed.

Retention is conservative for all catalog rows, including failed tasks. Final
catalog purging/high-water archival and generation-backed session activation
remain pending; this guard does not enable the new backend by itself.


## Live maintenance lifecycle

Legacy GC tasks are tracked and drained before metadata flush and pool shutdown.
Closing stops new rounds and subsequent file deletions while completing the
current mutation. MySQL servers start generation collection after listening;
its regular interval follows gcIntervalMs. ParseServer.gc also requests collection
asynchronously. Inspect health.maintenance.gcTasks and generationCollection for
progress; awaiting gc does not wait for all generation batches.

Shutdown drains current collection before closing MySQL. This does not impose
hard OS/SQL IO timeouts or enable generation-backed parsing/HTTP readers.

### Staged catalog HTTP backend

`createParseServer({ mysql, dataDir, artifactBackend: 'catalog' })` opts the primary model session paths into SQL build coordination, immutable generations and view read leases. The default remains `local`. Real MySQL HTTP tests cover cold 202, cached 201 and restored PPTX rendering without another source parse. This is a staged integration option: auxiliary offline bundles still use the local artifact layout; legacy migration, corrupt-ready repair, cross-node task state and global resource admission are incomplete. It does not yet authorize shared-root multi-instance production deployment. There is no CLI environment switch at this checkpoint.


## Consistent backup manifest and restore drill

Persistence is not a backup. `src/backup-manifest.ts` writes a versioned, SHA-256
sealed manifest covering the durable subset of a deployment: MySQL directory rows
(`parse_files`, `library_entries`, `parse_artifacts` with ready pointers and
identity-derived keys, jobs, retirements, flat archives and high-water tombstones),
content-addressed source bytes, `meta/*.json`, `library.json`, and every canonical
`g-N` generation's `manifest.json` / `units.bin`. Sessions, read leases, storage
reservations, staging and scratch are intentionally excluded as transient state.

The catalog is read inside `START TRANSACTION WITH CONSISTENT SNAPSHOT`; files are
hashed while that transaction is open; a **separate** pool connection then re-reads
the critical rows (a repeatable-read snapshot cannot observe later commits). If
they changed, no manifest is produced and the operator must retry. The manifest
digest is `sha256(canonicalJson(...))`, so tampering or truncation is rejected.

Recovery is a drill, not just a file copy:

```sh
# snapshot (read-only); MYSQL_DATABASE selects the MySQL catalog, otherwise filesystem mode
PARSE_SERVER_DATA_DIR=/srv/parse MYSQL_DATABASE=genoffice \
  npm run backup:check -w @genoffice/parse-server -- snapshot \
  --data-dir=/srv/parse --out=/backup/genoffice-manifest.json

# verify AFTER restoring the files and database; exits non-zero unless ok && readyAllowed
PARSE_SERVER_DATA_DIR=/srv/parse MYSQL_DATABASE=genoffice \
  npm run backup:check -w @genoffice/parse-server -- verify \
  --data-dir=/srv/parse --in=/backup/genoffice-manifest.json --deep
```

`verify` reconciles source rows, saved history, references, tombstones and
artifact dependencies; proves each file's size and hash; and opens every live
ready pointer through `ArtifactGenerations.open` (plus per-frame gzip/sha256 with
`--deep`). Missing sources or lost history are fatal. A generation that cannot be
proven is withdrawn with the catalog's compare-and-clear `invalidateReady`, so the
service rebuilds it instead of advertising unverified bytes. `--no-invalidate`
is a read-only drill and fails closed if a bad ready pointer remains.

`createParseServer({ ..., restoreCheck: { manifest, deep } })` runs the same drill
before listening and refuses to start on source/catalog loss or an unverified
ready pointer; `/v1/health` exposes `restore` with the result and counts. This is
a same-directory restore verification, not an off-site backup/copy mechanism:
scheduling, retention, off-host media and a full cross-machine recovery exercise
still belong to deployment.
