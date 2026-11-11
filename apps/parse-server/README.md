# 解析优化实施进度

> 当前功能修复见 [DOCX / PPT 验收记录](../../docs/parse-viewer-fixes-validation.zh-CN.md)；容量 / 恢复边界见 [Docker 验证记录](../../docs/parse-docker-validation.zh-CN.md)。[隔离复现环境](deploy/validation/README.md)覆盖真实 MySQL/Redis、业务课件、资源限制与冷恢复。脚注编号、分节 / 页眉页脚和远程 EMF 加载已修复；下文早期“当前限制”和计数保留用于追溯，部分已被后续实现替代，不能据旧完成度百分比宣布完成。

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

Shutdown drains current collection before closing MySQL. Every shutdown phase
(parse queue, coordinator, artifact drain, async flights, HTTP close, GC flights,
database close) is bounded by `PARSE_SERVER_SHUTDOWN_TIMEOUT_MS` (default 30 s); a
stuck phase logs `shutdown_phase_timeout` and shutdown continues.

### Staged catalog HTTP backend

Canonical export: `npm run artifact:export -w @genoffice/parse-server -- --data-dir
<dir> --artifact-key <64-hex> --out <dir> [--catalog]` materializes one packed
generation (local flat store, or with `--catalog` the ready MySQL generation,
using `MYSQL_*`) as
`document.json`, `units/<index>.json`, `fonts/<font-id>.sfnt`,
`external-media.json` and `artifact-manifest.json` (plan §4.2 layout) without
changing the runtime `units.bin` truth.

Each generation's `manifest.json` now carries optional document metadata:
`unitCount`, embedded `fonts`, parser `warnings`, and `dependencies` (a derived
bundle records its model generation). They are validated on read and were added
compatibly, so older manifests still open.

`createParseServer({ mysql, dataDir, artifactBackend: 'catalog' })` opts the primary model session paths into SQL build coordination, immutable generations and view read leases. The default remains `local`. Real MySQL HTTP tests cover cold 202, cached 201 and restored PPTX rendering without another source parse. This is a staged integration option: auxiliary offline bundles still use the local artifact layout; legacy migration, corrupt-ready repair, cross-node task state and global resource admission are incomplete. It does not yet authorize shared-root multi-instance production deployment. There is no CLI environment switch at this checkpoint.


## Consistent backup manifest and restore drill

Persistence is not a backup. `src/backup-manifest.ts` writes a versioned, SHA-256
sealed manifest covering the durable subset of a deployment: MySQL directory rows
(`parse_files`, `library_entries`, `parse_artifacts` with ready pointers and
artifact dependencies,
identity-derived keys, jobs, retirements, flat archives and high-water tombstones),
content-addressed source bytes, `meta/*.json`, `library.json`, and every canonical
`g-N` generation's `manifest.json` / `units.bin`. Sessions, read leases, storage
reservations, staging and scratch are intentionally excluded as transient state.

A second instance sharing the same `dataDir` + MySQL catalog can take the
snapshot while another instance keeps serving (`tests/backup-manifest-cross-node-mysql.test.ts`).

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

`verify` reconciles source rows, saved history, references, tombstones, artifact
dependency edges (dangling/missing parents or targets fail closed) and
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

## Optional cross-node hot cache (plan §5.1, P3.5)

`src/hot-cache.ts` is the facade over the in-process preview and an optional
Redis projection. The default is `cacheMode: 'memory'`: nothing changes, no
Redis client is created and no command is issued. `cacheMode: 'redis'` mirrors
two things only — committed preview frames (`genoffice:{db}:` + `pv:{artifactKey}:{jobId}`,
TTL 60 s, at most `previewMaxUnits` units, a field above 256 KiB suppresses the
frame) and build progress (`job:{jobId}`, TTL 5 min, one process-wide 200 ms
throttle, forced at the end). Keys are bound to the build lease `jobId` resolved
through `parse_jobs`, so a rebuild or retry never reads an older attempt.

The cache carries no truth. Ready pointers, generations, build/read/download
leases, quotas, pressure ledgers and artifact indexes stay in MySQL and on disk;
a cache hit is only negative evidence ("there is a first frame / a progress
value"), and every positive `ready` decision still performs the normal claim and
ready-pointer validation. `lookup`/progress reads fall back to "unknown" on a
miss, timeout, malformed value, breaker-open or connection error, and the HTTP
layer keeps returning the normal `202 pending`/`409` states — never a 5xx. A
failed build deletes both keys. `FLUSHALL`, eviction and a replica switch are
just cache misses.

Configuration: `cacheMode` (`PARSE_SERVER_CACHE_MODE=redis`), `redis` config
(`REDIS_HOST`/`REDIS_PORT` or `REDIS_SOCKET`, optional
`REDIS_USERNAME`/`REDIS_PASSWORD`/`REDIS_DB`/`REDIS_TLS`), and
`cacheCommandTimeoutMs` (default 80, one attempt, no retry),
`cacheBreakerMs` (default 5 s after three consecutive failures),
`cacheProgressTtlMs`, `cacheProgressThrottleMs` and `cacheMaxFieldBytes`.
Redis mode requires MySQL plus `artifactBackend: 'catalog'`: the shared
`parse_jobs` row is what lets another instance address the projection. Rollback
is switching back to `memory`; keys expire by TTL and no persistent data is
rewritten. `/v2/capabilities` advertises `thresholds {docxAutoRemoteBytes,
pptxAutoRemoteBytes, docxFullRenderBytes}` so viewers do not hardcode deployment
policies; the same limits are validated before startup.

`/v1/health.cache` (`mode`, `enabled`, `hits`, `misses`,
`hitRate`, `errors`, `timeouts`, `breaker`) and the
`genoffice_cache_*` series (`_hit_total`, `_miss_total`, `_error_total`,
`_timeout_total`, `_hit_rate`, `_latency_seconds` histogram, `_breaker_open`)
report the layer. `cache_evictions`/`cache_bytes` are intentionally left to a
Redis exporter or `MEMORY USAGE` sampling instead of parsing `INFO` on the
request path. The first projection read on a waiting instance performs one
`parse_jobs` lookup (via `activeJob`) to resolve the build's `jobId`; a local
preview or a cached read never touches SQL.

Cross-instance waiter attach: durable v2 waiters live in
`parse_pending_sessions`, so an instance that did not create a session can
resolve the row lazily and serve its current status, shared preview frames and
progress. Such a waiter is read-only on the attaching instance: it never starts
a competing build, heartbeat only renews the row, and DELETE forgets the local
cache without deleting the builder's row. Attaching to *ready* generations still
requires the instance to hold the same data directory because multi-instance
shared local directories are not supported; the remote view is a status/first-
screen view, not a full session migration.

P3.5 boundary: one Redis instance with ACL/TLS support, the two channels above,
and single-threaded command execution. Sentinel/Cluster, capacity drills,
alerting, canary rollout and master/replica failover are part of P4 and have not
been exercised on this checkout.

Local drills exist but are not target-hardware acceptance:

- `npm run sessions:load -w @genoffice/parse-server -- --sessions 500 --strict`
  starts a real server, warms one shared artifact, opens 500 v2 reading sessions
  against it and reports create/status latency plus per-session RSS growth.
  File-mode run: 500/500 ready, 1 build, status p95 0.5 ms, +103 MiB / ~211 KiB
  per session. `--mysql --catalog` (isolated DB) run: 500/500 ready, 1 build,
  create p95 70 ms, status p95 0.6 ms, +31.6 MiB / ~65 KiB per session.
  `--instances 2` (two servers sharing one dataDir + MySQL catalog) run:
  500/500 ready, 251/250 sessions per instance, 1 shared build, create p95
  75 ms, status p95 0.3 ms, +38.7 MiB / ~79 KiB per session. Local synthetic
  baselines, not deployment claims.
- `npm run cache:slo -w @genoffice/parse-server` (or
  `PARSE_TEST_REDIS_SOCKET=… node --import tsx scripts/cache-slo-drill.mts --strict`)
  seeds a committed preview through the observer path, drives concurrent reads
  against real Redis and reports hit rate, p95 bucket, average latency and error
  rate; `--strict` exits non-zero when the §5.1 SLO is missed. A loopback run of
  800 requests measured hit rate 1.0 / p95 bucket 1 ms / 0 errors (not a
  deployment claim).
- Fault tests cover slow-but-alive Redis (reply delay → timeout + breaker
  fail-fast), bulk simultaneous TTL expiry, hot-key read storms, cache-down
  degradation without 5xx, and `FLUSHALL`/delete-as-miss behaviour. Cross-node *session* state (the durable waiter journal) is still
instance-local, so a reader instance must know the session to attach.

## Bearer token rotation

Rotate the API bearer token without a hard cut-over:

1. Deploy with `PARSE_SERVER_TOKEN=<new>` and `PARSE_SERVER_PREVIOUS_TOKEN=<old>`.
2. Roll clients/proxies to the new token; old-token requests (including signed
   content-url refreshes and font fetches) keep working.
3. After the overlap window, redeploy without `PARSE_SERVER_PREVIOUS_TOKEN`.

Media signatures are always minted with the current token; the previous token is
only an auth overlap, never a second signing secret. `previousToken` without
`token`, or equal to it, is rejected at startup.

## Build fingerprint injection

Source deployments must pin the artifact parser fingerprint in the build, not let
each process hash sources at startup. The build step is:

```sh
export PARSE_SERVER_BUILD_FINGERPRINT=$(
  npm run -s fingerprint -w @genoffice/parse-server -- --version "$PARSER_VERSION"
)
```

`scripts/build-fingerprint.mts` hashes the parser packages and `pnpm-lock.yaml`;
`--out build/parse-fingerprint.json` records the version/hash and `--check`
fails the build (or CI) when the recorded value no longer matches the sources.
The runtime only reads the injected value (`PARSE_SERVER_BUILD_FINGERPRINT`).

## Deployment switches and v2 contract extras

`bin.ts` parses deployment switches strictly and aborts startup on an unknown
value: `PARSE_SERVER_ARTIFACT_BACKEND=local|catalog`,
`PARSE_SERVER_STORAGE_ADMISSION=instance|shared`,
`PARSE_SERVER_PREVIOUS_TOKEN` (accept the old bearer token during an explicit
rotation window; new requests should use `PARSE_SERVER_TOKEN`),
`PARSE_SERVER_CANONICAL_ARTIFACT_EXPORT=1` (staged: materialize
`document.json`/`units/*.json`/`fonts/*.sfnt` sidecars next to each packed
generation; bytes go through the storage reservation and are skipped on
`storage_full`; packed `units.bin` remains the runtime truth), and
`PARSE_SERVER_SHUTDOWN_TIMEOUT_MS` (hard cap per shutdown phase, default 30 s;
a stuck phase logs `shutdown_phase_timeout` and shutdown continues),
`PARSE_SERVER_DOCX_AUTO_REMOTE_BYTES` / `PARSE_SERVER_PPTX_AUTO_REMOTE_BYTES` /
`PARSE_SERVER_DOCX_FULL_RENDER_BYTES` (client routing thresholds advertised via
capabilities; defaults 32/64/64 MiB),
`PARSE_SERVER_ASYNC_SESSIONS_V2=1|0` (process kill switch), and
`PARSE_SERVER_V2_ROLLOUT_PERCENT=0..100` (deterministic canary: files whose
`parseInt(fileId[0..4],16) % 100` is below the percentage use v2; the rest get
404 and fall back to v1), `PARSE_SERVER_V2_ROLLOUT_HEADER` (optional header such
as `x-tenant-id`; when present, its sha256 bucket replaces the file bucket so a
tenant/user is rolled out consistently), `PARSE_SERVER_V2_ROLLOUT_RAMP_PER_HOUR`
(time-based auto ramp: effective percentage = min(target, hours_of_uptime × ramp);
default 0 keeps the target fixed), `PARSE_SERVER_V2_AUTO_PAUSE_ERROR_RATE`
(0–100 server-error percentage over the last 60 s / ≥20 v2 creates that pauses
the v2 route for 5 min with 404/v1 fallback; 0 disables), and the restore gate
`PARSE_SERVER_RESTORE_MANIFEST=<manifest.json>` with
`PARSE_SERVER_RESTORE_DEEP`, `PARSE_SERVER_RESTORE_READ_ONLY` and
`PARSE_SERVER_RESTORE_INVALIDATE`. A restore toggle without a manifest path is a
startup error, read-only wins over invalidate, and a malformed manifest aborts
before any server resource is created. `local` stays the code default when the
backend variable is absent; `catalog` makes the MySQL catalog/generation/lease
paths the default for that process and requires MySQL. A subprocess test
(`tests/deployment-e2e.test.ts`) starts `bin.ts` with only those environment
variables, parses once, restarts and proves the artifact is reused without a
source parse, then checks SIGTERM exits cleanly and the restore-gate/missing-MySQL
startup failures.

`parse_sessions` stores only the lightweight reading record:
`id`, `file_id`, `width`, `parser_version`, `format`, `artifact_key`,
`expires_at`, `created_at`, `last_used`. `artifact_key`/`expires_at`/`format`
are added idempotently on startup (including on tables created by an older
release), the legacy `base_url`/`model`/`fonts` columns are relaxed to NULL and
are no longer written; rows written by an older release are still read as a
fallback. GET/heartbeat touches refresh `expires_at` and the v2 ready body
exposes it. v1 and v2 responses still return `model`/`fonts`, but by lazily
reading the published artifact document (no parser worker; only a missing or
damaged artifact falls back to a reopen/rebuild), so a session truly references
its shared artifact. File-index mode stores the same fields in `sessions.json`.
Rollback note: a previous release reading a new row sees `model = NULL` and
cannot restore that session, although its artifact and source remain and can be
rebuilt; the reading position/layout preferences are still client-side.

Staged rollback: `PARSE_SERVER_ASYNC_SESSIONS_V2=0` disables the v2 async
session routes (they answer 404, capabilities report `features.asyncSessions:
false`) while the whole v1 synchronous contract stays functional, so clients
fall back exactly as they do for older servers. Use it as the first rollback
step (v2 async → v1, then optionally `artifactBackend=catalog → local`, then
cache `mode=redis → memory`). This is a process-level switch; it does not delete
sessions, artifacts or files.

`POST /v2/sessions` optionally accepts bounded `layoutPrefs`
(`zoom` 0.25–4, `page`, `anchor {unitId, blockIndex?, offsetPx?}`, ≤2 KiB,
unknown keys rejected). The preference is carried through the durable waiter and
persisted in `parse_sessions.layout_prefs`; `GET /v2/sessions/:id` echoes it
while pending and after ready, and it survives a restart. It is a per-session
reading hint only — it never enters the shared model/artifact cache, and v1
bodies are unchanged.

Cross-instance ready attach: any instance that shares the documented deployment
precondition (one `dataDir` + one catalog) lazily loads a durable ready session
created by another instance on `GET /v2/sessions/:id`, its units and heartbeat.
Attaching opens the ready generation read-only through the catalog and never
rebuilds the model or takes over a live builder's leases; `DELETE` stays owned
by the creating instance. Crash takeover: if a remote **pending** waiter still
exists and its shared build lease is gone (same parser version/fingerprint), the
next status poll may resume the build here; SQL claim fencing still guarantees a
single winner.

Last-waiter cancellation: every instance serving a pending session registers a
durable reader row (`parse_pending_readers`, 120 s TTL renewed by GET/heartbeat).
`DELETE` removes only that instance's reader; the shared waiter and its build stay
alive while any other reader remains. When the last reader leaves, the pending row
is dropped and a build that finishes later discards its bytes instead of
publishing them (a running build is not aborted mid-flight). Crashed readers
expire by TTL. Object storage / instances without a shared filesystem are not
supported yet.

`POST /v2/sessions/:id/heartbeat` also accepts an optional bounded
`layoutPrefs` body to update the reading position incrementally (ready sessions
persist it in `parse_sessions.layout_prefs`, locally-owned waiters in their
journal; remote waiters stay read-only).

`POST /v1/files/:fileId/part-url` (bearer auth) re-signs one part path and
returns `{url, expiresAt}`; viewers call it after a 403/expired signature or a
deployment-origin change instead of reopening the reading session. Traversal and
control characters are rejected.

v2 ready views/document expose an opaque `layoutKey` (plan §4.1):
sha256(artifactKey + rendererVersion + width + fontSetHash + measurementProfileHash).
Layouts are immutable per key, so clients can cache a laid-out deck across
sessions and re-lay out only when the width/font set/artifact changes.

v2 DTO envelopes carry an independent version: `/v2/capabilities.dtoVersion`,
`dtoVersion` on v2 session/document/status envelopes, and the
`X-Genoffice-Dto-Version` header on every `/v2/` response. v1 envelopes are
unchanged.

v2 contract completions: `POST /v2/sessions/:id/heartbeat` renews only the
lightweight reading session (200 with `state` and `pollAfterMs`; 404 for an
unknown id) and never touches a build lease or ready pointer. `GET
/v2/sessions/:id` on a ready session adds `artifactKey`, terminal `progress`
(`unitsProduced`/`unitCount`/`percent`), `pollAfterMs: 0` and
`complete: true`; the v1 body is unchanged. `GET
/v2/sessions/:id/bundle-manifest` aliases the existing `/bundle` manifest (no
sub-resources on the alias).

Startup reconcile runs before the listener: canonical `g-N` directories older
than one hour are removed when their artifact key has **no** `parse_artifacts` row
(a publish that renamed but crashed before the SQL completion). Any catalog row,
including a building lease, protects its generations; an unreadable catalog fails
closed and only logs a sanitized code. The pass is bounded (500 keys per startup)
and its result is exposed as `/v1/health.maintenance.startupReconcile`.

Artifact dependencies are recorded in `parse_artifact_dependencies`: every
ready artifact gets a `file` edge to its source inside the `complete()`
transaction, and a derived offline bundle additionally records an `artifact`
edge to the model generation it was hashed from (`ArtifactSession`).
`fileInUse` consults `hasDependencyOnFile` as an extra conservative source-GC
guard, and rows cascade when the directory row is archived.

Saved history now carries the plan §5 columns: `library_scope` (instance),
`retention` (`saved`) and `deleted_at`; `parse_files` gains
`storage_state`/`verified_at`. Removing a history entry is a soft delete: the
row keeps its identity for audit/backup reconciliation but clears its `file_id`
reference, so it stops protecting the source from GC (temporary retention applies
again) and disappears from listings. Tombstones are purged after 30 days.
Re-saving the same file creates a fresh active row; file-index mode mirrors the
same semantics in `library.json`.

`POST /v2/sessions` accepts an `Idempotency-Key` header (8–128 chars,
`[A-Za-z0-9._:-]`): a replay returns the same `sessionId` and its current
state (201 ready or 202 building) instead of opening a second durable waiter.
A bounded in-process cache (`idempotencyTtlMs`, default 10 min;
`idempotencyMaxEntries`, default 256) serves fast replays. With MySQL configured
the key is also written to the durable `parse_idempotency` ledger: another
instance or a restarted process replays the same `sessionId`; concurrent retries
merge via a pending claim (the loser waits for and replays the winner's body).
File-index mode keeps the process-local cache only. Uploads are naturally
idempotent by content addressing and `POST /v2/library` by its unique file
reference.

## Observability metrics (plan §11)

`GET /metrics` now also exposes the metrics the plan asks for beyond requests and
children RSS: `genoffice_parse_unit_read_latency_seconds` (histogram around one
unit/model read; cache and artifact hits included, layout excluded),
`genoffice_parse_job_queue_age_seconds` (oldest build waiting for CPU/memory),
`genoffice_parse_gc_deleted_bytes_total` (source TTL/eviction bytes + legacy flat
archives + physical bytes reported by the background sweeper, including
generation, staging and pressure collections), `genoffice_parse_bundle_failure_total`,
`genoffice_parse_signature_refresh_total` (DOCX resource descriptions re-signed at
response time), `genoffice_parse_artifact_miss_total` /
`genoffice_parse_artifact_corrupt_total` (artifact-store lookups that found
nothing / corruption reports), and the storage split
`genoffice_parse_storage_source_bytes` / `_artifact_bytes` / `_staging_bytes`
alongside the existing total. `/v1/health.artifacts` carries the same
`misses`/`corruptions` counters, and async-session failure logs include
`sessionId` + `jobId`. The legacy `genoffice_parse_storage_bytes` remains the
single content-store total for existing dashboards.

## Capacity pressure: withdrawing rebuildable ready generations

When the shared storage budget crosses its high watermark, `reclaimArtifacts`
only records a byte target and requests an urgent generation sweep. The
withdraw/retire transactions never run under the storage admission `GET_LOCK`.
In the background sweep `ArtifactReadyEviction` enumerates ready rows by
`last_access_at` (`listReadyEvictionCandidates`) with SQL fences for live read
leases, live builders and a surviving source row; it then proves the source bytes
are still on disk, compare-and-clears the exact ready pointer with
`withdrawReady` (state `reclaimed`, `error_code=artifact_reclaimed`), and deletes
the generation via the existing irreversible `retireGeneration` authorisation.
The source file, saved library history and the generation high-water mark are
never touched; the next open re-parses into a new generation. Normal-capacity
access withdraws nothing, and hard-cap exhaustion still fails closed with 507
instead of waiting for asynchronous reclaim.

Configure with `readyEvictionIdleMs` (default 60 s) and
`readyEvictionBatchSize` (default 16), or
`PARSE_SERVER_READY_EVICTION_IDLE_MS` / `PARSE_SERVER_READY_EVICTION_BATCH_SIZE`.
`/v1/health` exposes `readyEviction` (pending bytes, rounds, cumulative counts,
last result); the sweep report adds `readyWithdrawn`, `readyCollected` and
`readyBytes`.

Multiple instances race on the same SQL rows: compare-and-clear plus
irreversible retirement make duplicate passes harmless. This is derived-cache
eviction, not a source or library retention policy.

## Fleet-wide pressure budget

The pressure signal is still recorded in memory (`request()` runs inside the
storage admission `GET_LOCK` and must never touch SQL), but the **amount the
whole fleet may reclaim** is shared. `src/storage-pressure.ts` keeps one row per
deployment in `parse_storage_pressure`: `register()` merges concurrent signals
with `MAX` (never `SUM`), starts a numbered round after expiry, and returns the
remaining budget. Before each withdrawal the background sweeper, outside the
admission lock, issues a single conditional `UPDATE` that atomically pre-charges
the generation's bytes against `target_bytes - reclaimed_bytes`. Only a
successful delete keeps the charge; a lost compare-and-clear race, refused
retirement, missing source or IO error refunds it. A crashed process can only
leave an over-charge (fewer caches reclaimed), never an under-charge, so no
claim leases, heartbeats or startup reconciliation are needed. A satisfied
round gets the shorter cooldown expiry so persistent pressure is re-evaluated
without waiting for the full round TTL. If the ledger cannot be read, the pass
fails closed instead of falling back to unbounded per-instance reclamation; the
hard limit still returns 507 in the same round.

Configure with `pressureRoundMs` (default 5 min) and `pressureCooldownMs`
(default 30 s), or `PARSE_SERVER_PRESSURE_ROUND_MS` /
`PARSE_SERVER_PRESSURE_COOLDOWN_MS`. `/v1/health` exposes `sharedPressure`
(round, target/reclaimed/remaining bytes, expiry). The per-instance 30-second
soft-pressure backoff is still local jitter; `MAX` merging makes the global
target independent of how many instances signalled.

## Incremental first frame while a build is running

`src/artifact-preview.ts` keeps a bounded, in-process snapshot of units whose
gzip+sha256 frames have already been committed by `ArtifactWriter.append`. The
observer is attached to the parent-process `ArtifactStore` (`previewObserver`),
never to `ArtifactSessionInput`, because inputs are structured-cloned into the
isolated parse worker. A snapshot never writes SQL, never touches a published
generation, and never marks an artifact ready: `complete` here means "all frames
written", not "manifest published".

A building v2 session advertises `features.incrementalPreview` and returns
`previewable`, `complete: false`, `progress`, and `availableUnits` from
`GET /v2/sessions/:id`. `GET .../document`, `GET .../units?cursor=` and
`GET .../units/:unitId` serve only committed units; uncommitted units answer
`202` with `state: 'pending'`, `code: 'unit_pending'`, `retryAfterMs` and
`pollAfterMs`. Without a snapshot the existing `409 session_not_ready` remains,
offline bundle requests stay closed while building, and `state` never becomes
`ready` before the full manifest. Failed builds drop the snapshot immediately.

Configure with `previewMaxUnits` / `previewTtlMs` (or
`PARSE_SERVER_PREVIEW_MAX_UNITS` / `PARSE_SERVER_PREVIEW_TTL_MS`);
`/v1/health.maintenance.incrementalPreview` reports retained snapshots. The
preview lives only in the build owner's process by default; enable the optional
hot cache below to share it across instances. Shared session journaling and
cross-node task-state mapping remain separate gaps.
