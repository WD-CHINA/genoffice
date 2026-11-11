# 解析优化实施进度

更新：2026-11-11。当前功能修复见 [DOCX / PPT 修复验收](parse-viewer-fixes-validation.zh-CN.md)，容量及恢复边界见 [Docker 验证记录](parse-docker-validation.zh-CN.md)。对应方案：`parse-persistence-optimization.zh-CN.md`。持久化、可选 Redis 热缓存、业务课件重启复用、Linux 内核 OOM、GB 正文与独立数据库冷恢复均有实测；脚注编号与格式、远程分节 / 页眉页脚和最大 PPT 的 EMF 首页图片已修复并复验。下文保留实施历史，不再引用旧“七成 / Redis 未开始”等过时百分比作为当前状态。

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

- Android 本地完整性：离线 manifest 增加 bundleSchemaVersion=1 和逐文件 size/SHA-256 清单，complete 保存 manifest 哈希；发布前校验模型/字体必需文件，后台打开前重算资源哈希，拒绝缺页、截断、同长度篡改及路径越界。未完成包不能创建本地回放会话；发布重命名中断导致目标缺失时恢复已封存的 .previous。旧版无校验清单的包需重新下载。本项是本地缓存完整性，尚非服务端 artifactKey/schema/源哈希清单。

- Android 下载取消：设置页按钮和 Activity 销毁接入取消；中断排队睡眠、异步断开活动 HTTP、在媒体块和 SHA-256 读取中检查中断，最终关闭本次阅读会话并清 staging。已完成包原子发布前保留；发布是提交点，进入后不撤销。下载进度按代次隔离，取消后不再覆盖 UI；共享服务端构建不随单个下载者取消。

- Android 空间保护：开始下载先检查余量；媒体/字体按 Content-Length 做单资源预检，未知长度逐写入块检查，模型/manifest/complete 写入同样保留 64 MiB。检查发生在 staging，不删除旧完整包；已有缓存读取不要求额外空闲。仍非整包容量预算或跨应用磁盘预留，缓存配额/清理界面及权威清单仍待完成。

## 权威离线包清单（新增）

- PPTX 离线清单和资源接口已接入。清单含辅助 artifactKey、主模型 modelArtifactKey、解析指纹、schema、每个资源的大小/SHA-256；显式字体路径支持 `embed:0` 等非文件名 ID。清单覆盖全部 ppt/media，未引用媒体也下载；外部媒体另行列明。
- 清单按需生成独立持久辅助产物，绑定主模型记录内容摘要，共用有界队列，不重复启动源解析。正常在线预览不提前读取全部媒体。ZIP 校验和清单失败不破坏已就绪预览；单个下载者取消、关闭会话后共享构建仍继续。
- Android 优先读取服务端清单，逐资源验证源大小和哈希，成功后 sourceVerified=true；仅清单 404/405 兼容旧流程并标记 false。下载地址由配置服务及验证路径生成，不信任 href。整包容量预检加元数据余量，写入中继续检查 64 MiB 余量。包含外部媒体时明确拒绝完整离线，部分离线提示仍待实现。
- 原先“尚非服务端清单”“整包预检待完成”描述为早期检查点，现由本节替代。仍按 fileId 存目录；续传、版本目录、缓存管理仍待实现。

## 最近验证

- 2026-11-10 复跑（HEAD `de677f0d`，独立 MySQL 9.7.1）：默认全量 42 文件通过 / 9 跳过、295 项通过 / 63 跳过；带隔离真实 MySQL 串行全量 **51 文件 / 358 项全部通过、无跳过**（修夹具后）；viewer 69 项、parse-server 与 viewer 类型检查、改动文件 ESLint 与 `git diff --check` 通过；华为 AGS5-W00 真机 instrumentation **33 项通过**（23.2 秒）。同时修复 `tests/storage-pressure-mysql.test.ts` 的夹具缺陷（`createBlankPptx` 的 ZIP 时间戳仅 2 秒粒度，同窗三次上传被内容寻址去重成 1 个产物，用例却期望 3 个 ready，导致 `expected 0 to be 2`）；产品语义另用三个不同字节文件独立复现为「只撤 1 个、只删 1 代、剩余 2 个 ready」。完成度量化与缺口排序见 [完成度评估](parse-optimization-completion.zh-CN.md)。

- 最新完整服务端回归：116 项通过、3 项可选 MySQL 测试跳过（2026-11-07）。离线包 6 项测试覆盖大小/哈希、字体、未引用及压缩媒体、鉴权/Range、重启复用、CRC 故障、队列饱和和取消后共享构建；日志 `/tmp/genoffice-server-current-test.log`。
- 最近已确认 Android 全套 19 项通过；真实后端联调两次下载并校验本地模型/嵌入字体回放，源解析一次、主模型及辅助包共两次产物构建。该次使用只读 Android 36.1 模拟器，不代表真机或 8 核 16 GiB 容量结论。复现入口 `npm run test:android-backend -w @genoffice/viewer`，需明确 ANDROID_SERIAL 并先构建 APK。


- 本轮 Android 空间检查：APK/测试 APK 构建通过，只读 Android 36.1 模拟器完整 15 项 instrumentation 测试通过（37.444 秒）。新增已知资源大小预检、未知长度实际部分写入后空间耗尽，均确认旧 manifest 不变、旧包哈希有效、staging 清理与会话 DELETE；同时复验 1 GiB、取消和真实 Activity 按钮。未对真实磁盘填满或真机作容量承诺。

- 本轮 Android 取消：APK/测试 APK 构建通过，只读模拟器全套 11 项通过（含 1 GiB、队列取消、活动媒体连接取消），新增发布前取消和真实 Activity 按钮交互两项定向验证通过，共 13 项覆盖；媒体取消在 5 秒窗口内退出，旧包仍通过哈希校验。UI 测试等待实际排队状态后点击取消，确认会话 DELETE、取消文案和 staging 清理。

- 本轮 Android：APK 与测试 APK 构建通过；只读 Android 36.1 ARM64 模拟器 9 项 instrumentation 测试通过，包含 1 GiB 流式媒体下载、失败保留旧包、异步等待、429 不回退、同大小损坏、缺失模型、清单版本/路径、未完成包拒绝回放和 .previous 恢复。1 GiB 用例 Java 堆约 16.7→18.4 MiB，maxHeap 192 MiB；不是整机 RSS 或真机容量结论。

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
- Android 主应用与 instrumentation APK 构建通过；异步就绪、兼容回退、429 与失败保留旧包，以及新增完整性用例已在 Android 36.1 只读模拟器执行。本轮不包含真机。

## 下一步（保持完整方案范围）

P0/P1 与大部分 P2 已落地：并发预占、配置校验、DOCX 游标/心跳/签名、产物落盘与重启复用、
有界队列、独立子进程与 RSS 看门狗、v2 异步会话、历史库、generation 目录/SQL 目录表/租约/退休回收、
共享 staging 对账、HTTP catalog 入口、单条记录损坏自动恢复、旧扁平产物迁移均已接入并各有回归。
本节替代早期「下一步」清单，剩余按可实施性分组：

**仍可在代码层继续（本地可验证）**

1. 跨进程软水位回收的一致性已落地（见末尾检查点）：共享预留账本覆盖「尚未落盘字节」的准入、启动过期行
   对账与优雅关闭释放；压力下主动撤下 ready 并回收可重建产物、以及**压力目标本身的跨进程共享**均已接入。
   共享压力账本用单行 SQL 轮次 + 原子逐笔预扣，把整个实例群的回收总量约束为 `MAX(pressureTarget)`，
   撤下候选仍来自共享 SQL 目录行，compare-and-clear 与不可逆退役授权保证并发只撤一次、只删一次。
   仍待：软压力 30 秒退避仍是各实例进程内抖动（MAX 合并后不影响总量，但多实例登记时点不同步）、
   flat 冗余字节仍只由 GC 报告并催促后台扫描，不在准入锁内做 SQL 授权。正常容量下 ready 产物保留，
   显式保存的原文件永不被压力回收。
2. 解析中的增量首屏已落地（见末尾检查点）：构建中已提交单元可预览、未生成单元返回明确
   `pending` 与重试建议、只有完整 manifest 才能判定离线完成，完整产物仍全部校验后整体发布。
   仍待复杂 PPTX/DOCX round-trip、真实 GB 正文压测记录，以及预览快照的跨节点共享
   （当前是构建进程内内存状态）、Web 首屏字体度量/在线回源的进一步完善。
3. 最后一个等待者取消后的共享任务调度策略、SQL/IO 关闭宽限期硬超时、跨节点任务状态映射；
   以及方案 5.1 的可选 Redis 热缓存（仅预览帧与构建进度投影，单机默认 memory、未配置即关闭；
   响应缓存/会话投影/分布式限流列为待评估）。Redis 只做可丢缓存与「否定」判断，
   不承载 ready 指针/租约/配额等真值，命中缓存也不得跳过 ready 校验。
4. 部分离线的在线回源（未缓存资源在线取、断网显示尚未离线就绪）、Android 本地读租约，
   以及真机容量/弱网/长时稳定性压测。按 artifactKey 的版本目录、整包缓存配额与清理入口、
   部分离线的显式标记已落地并在真机验收，见末尾检查点；断点续传（ETag/Content-Range
   严格校验）与其 512 MiB 部分文件上界也已落地。当前部分离线只标记并提示，不含在线回源，
   不能宣称完整离线闭环。
5. 备份清单与恢复演练已落地并在隔离真实 MySQL 验收（见末尾检查点）：一致快照、依赖对账、
   generation 文件存在性/哈希/逐帧校验、不合格 ready 按确切代次撤下，以及启动门禁。仍需
   损坏 generation 的更广泛故障注入与并发修复压测、真实备份介质上的异地恢复（当前演练在
   同一目录上做「还原后校验」而非跨机器恢复）、以及备份调度与保留策略。

**依赖部署 / 目标环境，不能由本机代码改动代替**

6. Linux 委派 cgroup v2 上验证内核 OOM 与进程组清理；8 核 16 GiB 上 2 冷解析 + 20 排队 + 50/500 会话的
   p50/p95、RSS 峰值、CPU、磁盘吞吐和目标延迟基线。
7. 真实 MySQL 多写入者共享目录、nginx 路由 `nginx -t`、生产容量/配额/备份位置、灰度开关与回滚演练。
8. Windows 内存采样、PDF/DOCX 移动预览闭环；Android 真机 instrument 与真实服务端的 PPTX
   离线链路已验收（见末尾检查点），真机容量、弱网与长时压测仍未完成。

## 当前限制

`artifactBackend` 默认仍是 `local`；catalog（MySQL + generation + 租约）是可程序化选择的入口，尚未设为默认，
也没有多实例共享目录的生产验收。文件索引适配器仍是单服务进程去重；catalog 后端已把 `StorageBudget` 的
并发预留改为 SQL 共享账本（带租约的预留行 + `GET_LOCK` 跨进程互斥 + 启动过期行清理 + 优雅关闭释放），
local 后端以及高水位触发的回收仍是进程内状态。历史库按实例共享，尚无多用户归属。已支持打开清单时的条件失效、单条记录损坏的
按代次撤销/重建、已打开视图的 single-flight 修复，以及旧扁平产物两遍校验后的导入；普通 IO 错误不误判为损坏，
旧 generation 目录不会被修复路径删除。离线包在 catalog 后端已发布为独立 generation 并持有独立读租约，
帧/清单损坏按确切代次撤下并由视图单次重建；旧 flat 离线包在冷构建前经完整身份/权威清单比对与
两遍逐帧校验后导入为 generation，不重建。导入/发布遗留的旧 flat 文件在目录表不可逆授权、确认新
generation 落盘后，由后台扫描只删除顶层两个文件，并在 health 与配额字节上对账。local 后端仍用旧 flat
布局。原文件与产物字节已纳入
上传准入配额，产物写入增量预留，上传临时文件逐块保护，DOCX scratch 接入预算，压力下闲置派生产物回收、高低水位、
共享 staging 对账与后台 generation 回收均已接入；共享准入与启动/关闭对账已落地。generation 保留窗口
（默认每 key 4 代）与容量高水位只加速旧代候选，删除仍须 SQL 退役授权；目录行最终归档只针对已无 ready
且磁盘已清空的 key，压缩退休/flat 明细后登记高水位墓碑并删除目录行，从而解除原文件外键引用。墓碑永久
保留，重新 claim 从高水位继续编号，不会复用 g-1。压力路径不同步删除 flat（避免 SQL 授权与准入锁嵌套），
只报告待清理字节并催促后台扫描，故 flat 释放仍受默认 1 小时宽限。正常容量下 ready 产物保留；
共享预算越过高水位时，后台扫描才按最久未访问顺序撤下可重建的 ready 指针并删除其 generation 字节
（`withdrawReady` 按确切代次 compare-and-clear，事务内再次围栏活跃读租约/构建任务，
再由不可逆退役授权删盘），准入锁内只登记压力目标并调度，绝不在 GET_LOCK 内跑 SQL；
撤下还需原文件字节仍在（可重建）。显式保存的原文件、历史记录与 generation 高水位永不被压力回收，
撤下后下次访问从原文件重建。各实例的待回收字节不再独立计算：后台扫描在锁外把压力信号登记到
单行共享轮次账本 `parse_storage_pressure`，逐候选原子预扣，只有删盘成功才计入已回收字节，
失败归还额度，因此整个实例群每轮回收量 `<= MAX(pressureTarget)`；账本不可用时不回退到进程内
无界回收（fail-closed），硬上限仍同轮 507。轮次满足后走短冷却过期，可重新评估持续压力。
一致备份清单与恢复演练已作为独立运维入口落地：`backup-manifest.ts` 在 MySQL
一致性快照事务内读取持久目录行（含墓碑与 identity 派生校验）、逐文件流式哈希，并用独立连接
复核关键行；`verifyRestore` 做依赖对账、原文件/索引硬校验、generation 存在性与逐帧校验，
不合格 ready 由 `invalidateReady` 撤下后才允许启动。当前演练校验的是同一 dataDir 上的还原结果，
不是跨机器/跨介质恢复，也不自动执行备份拷贝；清单不含会话、读租约、staging 与共享预留等临时态。客户端仍保留小 DOCX 全量本地渲染。DOCX 已移除全量 document.xml、
slices、blocks 与 parsedChunks 的持有，使用正文双遍流读取、最多 200 块一批落盘；辅助 parts、元数据索引和单个
XML 块仍在内存，单块上限 64 Mi UTF-16 字符。完整产物仍在全部校验后整体发布；解析中只暴露已逐帧提交单元的
进程内只读预览，不写 SQL、不改 generation、不等于 ready，也不允许离线完成判定。独立进程隔离及采样式
RSS 限制已验证；Linux cgroup 内核硬限制、真实 GB 正文压测、500 阅读会话压测未完成。
Android 真机（AGS5-W00 / Android 12 / API 31）已通过 33 项 instrumentation 与真实解析服务端
联调，覆盖 PPTX 离线包完整性、取消、空间检查、断点续传、按 artifactKey 的版本目录、
缓存配额/清理入口与部分离线标记；旧 flat 包仍按原布局兼容。部分离线的在线回源、
Android 本地读租约（回收旧版本时正在回放的旧包需重新打开）、真机容量/弱网/长时稳定性
压测仍未完成，也不代表 PDF/DOCX 移动端闭环。nginx 配置已补路由，但本机没有 nginx
可执行文件，尚未执行 `nginx -t`。


### Web 有界缓存后续实现约束

当前 DocsRemote 使用 `setBlocks(old => [...old, ...result.blocks])`，DOM 虚拟分页没有释放正文模型。
不能直接删掉离屏 blocks：全局分页、表格跨页及 docxIndex 测量仍依赖这些模型。
下一步需拆分轻量分页索引与可淘汰的原始 chunk，允许按 unit ID 回访重取；保留稳定高度与
页锚点，避免重载引起滚动跳动，并在会话重开后重新生成有时效的资源 URL。
验收需覆盖前后滚动、跨页表格、会话失效重取和缓存字节上限；仅减少 DOM 数量不能算完成。


### Web chunk 缓存基础（2026-11-07）

新增按 UTF-16 JSON 权重及条目数双重约束的 LRU，默认 8 MiB/128 条。
超大 unit 交给当前调用者使用但不缓存；这是序列化权重预算，不是 JS 堆硬限制。
DocxRemoteSession 增加按 unit ID 随机读取、同 ID 请求合并、404/410 单次恢复、
关闭后迟到响应隔离；会话重开清空模型缓存，防止复用旧签名 URL。
顺序读取也填充缓存，失败批次保留原游标和提交规则。

viewer 完整测试 46 项通过，类型检查通过；新增 LRU 字节/条目淘汰、Unicode、
超大替换、禁用/非法预算，以及随机读取去重、恢复后 URL 更新、格式失败重试、
重复失效和关闭时迟到响应测试。日志 `/tmp/genoffice-viewer-current-test.log`。

此步尚未解除 DocsRemote 的全量 blocks 持有，也未宣称 Web 内存目标完成。
下一步将全局分页记录改为轻量 chunk/block 引用，在可见窗口内解析引用，并用 unit()
重取淘汰内容。表格分页描述不得继续引用完整表格模型；测量与滚动锚点须保持稳定。


### Web 分页引用与正文淘汰已接入（2026-11-07）

DocsRemote 已取消全局 blocks 累积、全量表格模型和正文切片的持有。
全局索引只保存 unit ID、块序号、测量高度和表格行/段范围；只为当前可见及 overscan
页面持有原始 unit，切换窗口释放其余引用，使用会话 LRU 或 unit 随机读取恢复。
普通正文和表格使用实际样式、宽度测量，准备失败不提交 unit 去重标记或推进游标。
表格重复页眉限定为开头连续行，源 pageBreakBefore 仅用于首个表格片段。

会话重开时清除可见模型与旧 URL 并重取窗口，分页索引保持稳定；追加新 chunk 不再重复
读取未变化的窗口。正文回访错误和追加错误分开显示/重试，避免互相清除错误或错误推进。

验证：viewer 49 项测试通过；新测准备失败重试、分页描述不引用正文/表格内容、移除模型
后页高不变及估算高度。真实 Chrome 的 1201 段正文分 7 块加载、首块超过缓存预算、
滚到文末再回首页时注入会话删除/410 和一次 500：显示错误后重试恢复原文，页总高不变，
源产物仍只构建一次。截图 `/tmp/genoffice-library-ui/async-docx-flow.png` 已目视检查，
日志 `/tmp/genoffice-library-index.log`。这不是 GB 正文或浏览器 RSS 压测结论。

剩余：图片/字体迟到引起的测量更新与滚动锚点、超快滚动的在途请求预算、复杂表格/编号
保真、构建中的增量首屏与实际堆/RSS 曲线。LRU 的 8 MiB 是 UTF-16 JSON 权重，
可见 unit、Tiptap 树、布局描述和在途响应另占内存；不能解释为整个页面堆只有 8 MiB。


### Web 在途正文读取预算（2026-11-07）

DocxRemoteSession 的 unit/list 读取共用 2 个并发名额、最多 16 个等待名额，
名额覆盖 fetch 到 JSON 解码完成；等待超限明确返回可重试错误。
窗口更新调用 retainUnits，取消不再可见的随机读取并移除等待请求，顺序追加与共享源解析
不受窗口取消影响。同 ID 在取消后可立即发起新请求，迟到旧响应不能覆盖新缓存。
HTTP 错误响应主动取消未使用的响应体；会话关闭取消全部读取。
如果底层读取忽略 AbortSignal，名额仍保留到它真正结束，避免逻辑取消绕过并发预算。

viewer 最新 52 项通过，类型检查、ESLint 和 diff 检查通过。新增等待取消、队列溢出、
解码/错误释放、非法配置、取消后旧响应隔离测试；真实 Chrome 长正文、淘汰回访、
会话失效和 500 重试回归通过。日志 `/tmp/genoffice-viewer-queue-test.log`、
`/tmp/genoffice-library-queue.log`。仍需真实弱网快速滚动、完整页面堆/RSS 和 GB 正文验收；
字体/样式初始化不属于这两个正文读取名额。


### Chrome 延迟响应取消与正文堆保留验证（2026-11-07）

`test:library` 增加真实 Chrome 请求取消观测：拦截首块响应并延迟返回，在窗口实际切换到
文末后释放响应，确认 requestfailed/ERR_ABORTED，文末没有被旧正文覆盖，也没有错误提示；
再回首页能重新获取正文，总页高保持一致。这里是受控响应延迟，不是完整网络限速压测。
首次试验过早释放响应，未等待 React 窗口切换，取消观测失败；改为等待文末正文可见，
从而验证真实取消条件，生产实现未因此改变。

同一 1201 段、7 块文档继续往返首页/文末 12 次；每次返回首页在 Chromium 隔离堆执行
强制 GC 后采样，另记录 DOM 节点数。Chrome 157.0.8103.39 本轮基线 37,614,948 字节，
最终 38,290,592 字节（增加 675,644 字节，约 0.64 MiB）；13 个样本的 DOM 节点均为 454。
源解析产物仍只构建一次。测试设定 GC 后增长不超过 16 MiB、节点增长不超过 5000 的
回归阈值，并输出 `/tmp/genoffice-library-ui/docx-memory-samples.json`；日志
`/tmp/genoffice-library-memory.log`。这个小样本只支持没有随本轮往返持续保留大响应的结论，
不是浏览器峰值、进程 RSS、GB 正文、真机或 8 核 16 GiB 容量验收。


### DOCX 嵌入字体生命周期（2026-11-07）

修复已确认的泄漏：原 loadFonts 每次会话恢复都注册新 FontFace，文档关闭不删除。
新增文档级 DocxFontScope；按字体 ID/族/变体复用已加载字体，读取与 FontFace 解码共享
两个并发名额。关闭取消读取、清空引用并只删除本实例注册的 face，保留其他文档与 CSS
字体；迟到响应和字体解码完成后再次检查生命周期。缺失/损坏字体仍可回退，恢复时可重试。

viewer 56 项测试通过，类型检查和 ESLint 通过；新测跨恢复去重、非自有字体保护、
解码期间关闭、忽略取消的读取、并发上限及失败重试。真实 Chrome 回归使用真实嵌入
Carlito 字节和唯一字体族：经历两次会话恢复后，嵌入 face 始终为一个、服务端字体仅下载
一次；额外独立 scope 实际注册后 close，浏览器 FontFaceSet 中该 probe 归零且原查看器
face 保留。长正文淘汰/取消/重试/12 次往返堆采样同时通过。
日志 `/tmp/genoffice-viewer-font-test.log`、`/tmp/genoffice-library-font.log`。
浏览器探针直接验证 scope 的真实字体 API，组件销毁调用 close 的接线由源码及单测覆盖；
未据此宣称所有字体原生内存立即归还或完成整机 RSS 验收。


### DOCX 初次测量等待图片（2026-11-07）

正文和表格测量原先仅等待零延时定时器，未等待 img 加载完成，可能采到占位高度。
新增 waitForDocxImages：已完成图片不等待，其他图片等待 load/error，默认最多 1.5 秒，
文档关闭立即拒绝并移除所有事件监听器。正文批次和表格测量均接入文档 AbortSignal；
表格测量改为 async/try/finally，成功、错误、关闭时均销毁临时 editor 和隐藏 DOM。

viewer 59 项测试通过，类型检查与 ESLint 通过。新增多图片/错误、超时清理、关闭中断测试。
真实 Chrome 在受控延迟 150ms 的 SVG 响应上调用该等待器，测量前高度小于加载后，
加载后高度为 120px；并通过原有长正文、缓存淘汰、取消、字体和堆保留回归。
日志 `/tmp/genoffice-viewer-image-test.log`、`/tmp/genoffice-library-image.log`。
该浏览器探针验证等待器与真实图片布局，不等于复杂 DOCX 表格图片保真验收。

超过 1.5 秒才出现的图片、后到字体引发的二次分页，仍需可见内容重测与稳定滚动锚点。
本轮只改进初次测量并释放等待，不宣称整个图片迟到/滚动跳动问题已完成。


### DOCX 重分页锚点基础（2026-11-07）

新增 capture/restoreDocxAnchor，以 unit ID、块序号、块内像素偏移定位，不使用易变页号。
跨页表格记录正文行与拆分段范围，跳过重复表头；源引用不存在时不猜测另一个文档位置。
分页索引保存连续表头数但不保存正文模型。DocsRemote 在布局提交前后的 useLayoutEffect
恢复锚点，并关闭原生 overflow-anchor，避免两种补偿叠加；文档切换隔离锚点。

viewer 62 项测试通过，类型检查、ESLint 与 diff 检查通过。新测前文变高导致换页时保持
原块偏移、表格拆分范围变化和空/替换文档。真实 Chrome 原有长正文加载、会话失效、
淘汰回访、延迟请求取消、字体释放、图片等待和堆采样回归通过；日志
`/tmp/genoffice-viewer-anchor-test.log`、`/tmp/genoffice-library-anchor.log`。

本轮是模型块/表格片段级锚点，尚未接入可见图片/字体事件后的自动重测，也没有证明
表格内部任意文本行的像素级稳定。下一步需合并资源事件的重测、避免相同高度反复更新，
并用真实迟到图片引起页数变化验证浏览器滚动位置。


### DOCX 可见资源变化自动重测（2026-11-07）

PageEditor 监听图片 load/error、字体 loadingdone 与可见编辑器 ResizeObserver。
按 unit 合并重复通知，最多并行两个重测；只在运行时读取可见模型，排队不额外保留正文。
离开窗口或关闭文档取消重测，过时结果不提交；重测使用真实样式、宽度及表格行模型。
replaceDocxUnitIndex 只替换对应 unit，忽略不足 0.5px 的高度差，分页结构未变时保留
原索引对象，避免观察器/内容重建形成反馈循环。更换页数时使用已接入的源块锚点。

viewer 63 项测试通过，类型检查和 ESLint 通过。新增重测结果相同保留索引身份、
只替换对应 unit、未知 unit 不插入测试。真实 Chrome 通过受控 CSS 把阅读位置上方的
首段增高到 600px，确认总页高增加、当前可见正文段落偏移变化不超过 32px；撤销后
总页高恢复。完整字体、图片等待、淘汰、过期恢复、延迟取消与 12 次往返回归同时通过。
日志 `/tmp/genoffice-viewer-reflow-test.log`、`/tmp/genoffice-library-reflow.log`。

该探针验证真实可见尺寸变化的重测与块级锚点；仍需超时图片/后到字体的复杂 DOCX、
跨页表格内部文本像素锚点及 GB 正文/峰值 RSS 规模验收，不将 32px 容差解释为像素精确。


### DOCX 切换文档与迟到测量隔离（2026-11-07）

异步重测除提交前检查外，还在 React 执行 state updater 时重新验证文档实例、取消信号
及可见模型对象身份；顺序追加的 updater 同样复核文档，避免延迟队列将旧 unit 0 写入
新文档同名 unit。恢复后替换了模型对象的旧测量结果也被拒绝。

Chrome 回归新增不刷新浏览器、不卸载父测试页面的实际 DocsRemote 文件切换：另挂载 A，
通过受控 document.fonts.ready Promise 暂停已启动的隐藏测量，再把同一 React 组件改为 B，
确认 B 会话启动后释放旧等待。B 显示自身正文，无 A 正文；A 自有字体移除，原查看器字体
仍在，B 卸载也不影响原查看器。原 63 项单元测试、类型检查及 ESLint 通过。
日志 `/tmp/genoffice-library-switch.log`、`/tmp/genoffice-viewer-switch-test.log`。
测试中 CSS 字体与嵌入字体请求分开统计；Vite CJS 默认导出由探针显式处理，不修改生产加载。

本次暂停试验也确认 measureBlockHeights 对 document.fonts.ready 的等待尚未独立设置
期限/取消，关闭后会拒绝写回，但该 await 可延长临时模型持有。下一步需给字体布局等待
增加有界期限与取消，并在内容建立后等待字体，进一步缩短旧测量资源存活期。


### DOCX 字体布局等待有界与可取消（2026-11-07）

新增 waitForDocxLayout，为字体布局依赖提供默认 1.5 秒期限与 AbortSignal；字体失败或
超时使用回退布局，迟到失败仍被消费，取消后移除监听器和定时器。正文每个测量批次在
插入内容并触发布局之后获取 fonts.ready，表格也接入相同等待；关闭/离屏可立即释放
等待中的隐藏 editor，不再依赖底层字体 Promise 最终结束。后到资源由已接入的可见重测处理。

viewer 66 项测试通过，类型检查、ESLint 和 diff 检查通过。新增已就绪、失败回退、
永久等待超时、关闭中断和取消后迟到失败用例。Chrome 强化组件切换测试：同时阻塞主
查看器和探针的字体等待，切换探针到 B 后，在释放底层 gate 之前用 500ms 观测窗口确认
隐藏测量 DOM 数减少，然后释放旧等待，B 正文正确、旧字体移除，主查看器不受影响。
完整长正文/缓存/重排/资源/堆回归同时通过。日志
`/tmp/genoffice-viewer-layout-ready-test.log`、`/tmp/genoffice-library-layout-ready.log`。

本项关闭了上一检查点发现的直接 await fonts.ready 问题；期限内回退并不等于复杂文档
像素保真已完成。完整方案仍包含 MySQL 产物/任务目录与租约、Android 续传及版本管理、
解析中的增量首屏、备份恢复、Linux cgroup 和目标硬件压力/灰度验收。


### MySQL 产物目录与租约基础（2026-11-07）

新增 parse_artifacts、parse_jobs 表和 MysqlArtifactCatalog。artifactKey 唯一目录行、
每产物唯一任务行，事务按产物→任务顺序加锁；使用数据库时钟计算租期，抢占时递增
单调 generation 和 attempt，过期续租不能复活。续租/完成/失败均检查 owner、jobId、
generation、当前产物 generation 与未过期租期；旧 token 即使 owner 名称复用也无效。
ready 指针采用受校验的 `artifacts/<prefix>/<key>/g-<generation>`，记录 manifest SHA、
字节和 unitCount；产物与任务状态同一 SQL 事务提交。原文件外键保护已建目录引用。
重建期间及失败后保留上一 ready 指针，普通读取不会被重建租约阻塞。

隔离 MySQL 9.7.1 实例上的完整服务端 124 项通过（25 个测试文件，无跳过），包含原
3 项 MySQL 集成测试和新增 4 项：双独立连接池 12 个并发争抢仅一个 acquired、过期
接管/同名 owner 旧写入全部拒绝、重建保留旧 ready、在任务更新处注入 SQL 错误验证
ready 指针回滚。另测 generation 路径非法输入。类型检查与 ESLint 通过。
日志 `/tmp/genoffice-server-catalog-test.log`。使用独立 socket 和随机测试数据库，验证
数据库已清空后关闭本次 mysqld；未访问用户数据库。

该层尚未接入 ArtifactStore，生产 MySQL 模式当前仍是单进程产物去重，不能宣称多实例
发布安全。下一阶段必须：不可变 generation 目录写盘/校验/rename 后才登记 ready，
等待者读取共享任务状态、续租及丢租停止，跨进程阅读保护与 generation 回收，以及
启动对账/迁移。SQL 完成返回异常或 false 不能直接删除 generation：需核实事务结果、
当前 ready 指针及租约状态，防止提交成功但响应丢失时删除已登记数据。


### 不可变 generation 磁盘发布层（2026-11-07）

新增 ArtifactGenerations。每个 key/generation 先独占创建目标目录，阻止并发写入，
包括 POSIX rename 原本允许覆盖的空目录。数据与 manifest flush 后，将 staging 原子
rename 到独立 g-N 目录，并同步新目录、祖先目录和 staging 目录；不支持目录 fsync 的
文件系统会拒绝此次发布，不假装已持久化。新旧 reader 各自绑定不可变路径。

新增按目录打开 reader 的校验入口，对照 manifest SHA、identity/key、数据长度和资源帧
预算；generation 入口额外核对总字节和 unitCount。返回的摘要可交给 SQL complete。
发布出错只删除 staging 和本次仍为空的预留目录，不递归删除最终路径；若 rename 已
成功、后续同步失败，完整但未登记的 generation 保留给启动对账，上一版不受影响。

隔离 MySQL 上完整服务端 131 项通过（26 个文件，无跳过）。新增 6 项磁盘测试覆盖新旧
并存、双写入器争抢、空/完整目标禁止覆盖、失败清理、摘要/校验和损坏、rename 后 fsync
故障保留完整孤儿。另增 MySQL+磁盘联合用例：阻塞旧 g-1，过期接管并发布/登记 g-2，
再放行旧任务写盘；旧 complete 被拒绝，SQL 仍指向 g-2，两个目录内容互不覆盖。
日志 `/tmp/genoffice-server-generations-test.log`、`/tmp/genoffice-generations-test.log`。
隔离 mysqld 在恢复工具会话时已退出（原句柄不存在、PID 不存在、socket 拒绝连接），
按此状态清理本次临时目录；没有触碰其他数据库进程。

该发布层和目录尚未挂入服务端 ArtifactStore 的实际会话路径。跨进程读保护、代际回收、
持久任务等待/续租、迁移与启动对账须继续接入；目前不支持多实例共享目录写入。


### 共享构建协调器（2026-11-07）

新增 ArtifactCoordinator，组合 SQL catalog 与不可变 generation 磁盘层。同进程按 key
single-flight，独立实例轮询目录状态共享构建；阅读者取消只解除等待，服务关闭才中止
共享任务。构建回调接收取消信号，丢租、续租错误或超过本地最后确认租期时中止。
本地保护使用单调时钟并保守扣除 SQL 往返时间，不信任服务器间墙钟一致；目录表仍是
最终 generation 权威。发布完成前停止周期续租，再最后续租及带 fence 的 complete，
成功后停止租期保护；SQL 提交异常不删除 generation，避免误删已提交数据。

协调器 6 项定向测试覆盖双实例共享、取消等待、续租失败、卡住的续租、本地期限、
关闭、等待超时及提交回复丢失保留文件。隔离真实 MySQL 再增联合用例：两个连接池/
协调器共享目录，1.5 秒租期下构建持续 2 秒，周期续租后仍为 generation 1，另一个实例
不调用 builder，第一阅读者取消也不中止任务。完整服务端 138 项通过（27 文件，无跳过）；
类型检查与 ESLint 通过。日志 `/tmp/genoffice-coordinator-test.log`、
`/tmp/genoffice-server-coordinator-test.log`。测试数据库清空后，关闭本次 mysqld 并删除
自有临时目录，未访问用户数据库。

此组件尚未接入生产 ArtifactStore/会话接口，构建回调须协作取消；独立解析子进程的
实际中止接线仍待完成。SQL 失败登记仍依赖驱动最终返回，不能据本地续租保护宣称所有
数据库故障下关闭都有硬时限。待完成：跨进程读租约、generation GC 和空间账本、
共享任务状态映射、损坏 generation 修复、旧目录迁移及启动对账，然后再切换实际链路。


### generation 配额计费与旧回收隔离（2026-11-07）

修复实际漏计：原 ArtifactStore.diskEntries 只看 key 目录第一层，g-N 中的数据不进
StorageBudget。现按目录迭代扫描实际普通文件字节，包含全部 generation、损坏 manifest
和未知孤儿子目录，不依赖 SQL ready 指针或 JSON 索引；不跟随符号链接。
消失的文件/目录按并发快照跳过，权限等错误继续上报，不静默低报。

旧回收候选及直接 evict 跳过带子目录的 key。旧版淘汰和损坏修复不再递归删除 key 根，
只 unlink 顶层 manifest.json、units.bin，之后仅尝试原子删除空根目录；即使检查后新
出现 generation 也不会被清除，回收字节只报告真正删除的旧文件。损坏/缺失旧索引遇到
代际目录时拒绝走旧后端重建，不调用 source builder，不删除 generation。

新增 4 项磁盘测试：多代/未知孤儿/损坏索引计费与链接隔离、旧新混合目录保护、回收
检查后出现 generation 的竞态、已有 generation 使后续写入触发配额且预留归零。
本轮定向 23 项通过；完整服务端 133 项通过、9 项可选 MySQL 测试未启用（共 142 项），
类型检查、ESLint 和 diff 检查通过。日志 `/tmp/genoffice-generation-budget-test.log`、
`/tmp/genoffice-server-generation-budget-test.log`。上一阶段真实 MySQL 138 项的证据不
替代本轮未执行的 MySQL 用例。

空间预留依然是单实例账本，尚无跨进程统一准入；扫描也不是文件系统原子快照。
跨进程 generation 读租约及 GC、共享 staging 保护/对账和业务链路接入仍待实现。


### generation 读租约目录基础（2026-11-07）

新增 parse_artifact_read_leases，以独立 UUID 记录 owner、artifactKey、generation 和
数据库时间的期限。pin 在产物行锁下选择 ready 指针并登记租约，和发布使用同一锁序，
不会出现“租约绑定一代，返回另一代”的检查/使用竞争；未 ready 或缺失产物不创建读者。
续租/释放复核 key、UUID、owner、generation，旧代续租不依赖当前 ready 指针，因此
新代发布不会打断现有读者。确认过期的 token 在事务中删除，不能因随后时钟校正复活；
同 owner 新开会话使用新 UUID。活动/残留读行通过 RESTRICT 外键阻止直接删目录记录。
pin/续租更新 last_access_at，后续回收不必依赖本地目录时间。

新增 4 项真实 MySQL 用例：真实磁盘旧/新两代读取与续租、错误 owner/generation 和外键
保护、过期不可复活及同 owner 新 token、发布与 pin 并发、双池 12 个读者唯一 UUID、
未 ready 不登记及非法期限。完整服务端 146 项通过（27 文件，无跳过），类型检查、
ESLint 与 diff 检查通过。日志 `/tmp/genoffice-server-read-leases-test.log`。
确认随机测试数据库已删除后关闭隔离 mysqld 并清理本次目录，未访问用户数据库。

这是数据库层的读者登记，还没有挂入 ArtifactReader/HTTP 会话的续期与关闭，不代表
文件系统已经获得跨进程读保护。下一阶段必须接入读取句柄及丢租中止，并让 generation
回收在同一目录事务内确认无读者、无 ready 指针、无有效构建者后登记不可逆回收状态；
不能暴露一个“可删除”布尔值后在事务外直接删除，留下新的检查/使用竞争。


### 有租约的读取句柄（2026-11-07）

新增 ArtifactReadHandle：先 pin 当前 ready，再打开对应 generation；对外仅提供受控的
read/manifest/describe/has/contentDigest，不暴露底层未受控 reader。周期续租和单调时钟
保护最后确认的租期，保守扣除 pin/renew SQL 往返；续租失败、异常或卡住均使句柄失效，
通过 signal 通知消费者。关闭立即拒绝新操作、取消等待，等底层已开始的 read Promise
实际结束后再 releaseRead。迟到数据在返回前再次核验租期；打开失败也释放 pin。
正常关闭幂等，释放 SQL 失败时同样清除本地 reader 引用，不无限保留索引。
公共取消观察辅助抽到 artifact-signals，与构建协调器复用并消费迟到错误。

新增 6 项句柄测试（与协调器共 12 项定向通过）：关闭/元数据保护、未完成底层读取时
延迟释放、丢租、卡住的续租、打开失败/未 ready、超长 pin 往返保守拒绝。真实 MySQL
再增联合测试：1.5 秒读租期下等待 2 秒仍可读；新 generation 发布后新旧句柄各读自己
版本；只让旧句柄续租失败，旧句柄读被拒绝，新句柄仍正常，关闭后读租约行归零。
完整服务端 153 项通过（28 文件，无跳过），类型检查、ESLint 和 diff 检查通过。
日志 `/tmp/genoffice-read-handles-test.log`、`/tmp/genoffice-server-read-handles-test.log`。
本次随机测试库已确认清空，隔离 mysqld 退出后删除自有目录，未访问用户数据库。

句柄尚未替换生产 HTTP/ArtifactSession 的 reader，generation GC 也尚未接入，不能据此
认定实际会话获得跨进程读保护。关闭仍等待底层文件 IO 和 SQL 释放最终返回；本地信号
能立即阻止数据返回，不意味着操作系统/数据库 IO 都有硬超时。后续需接入退休/回收事务、
会话句柄与进程中止，以及共享 reader 索引缓存和规模压测。


### generation 退休事务与按代回收（2026-11-07）

新增 parse_artifact_retirements 和 retireGeneration。按产物→任务→读者锁序，在同一
事务确认目标不为当前 ready、不超过已分配 generation、没有有效构建者/读者，清除
过期读 token，并永久登记退休。过期构建者同时被置为 failed；withLease 还检查退休
标记，即使旧租约字段意外恢复，也不能续租、登记 ready 或失败写回。退休历史用外键
保护目录计数器，不能直接删除根记录造成 generation 从 1 重用。

ArtifactGenerations.collect 只在退休提交成功后删除指定 g-N，目录表拒绝或报错时不删
文件，重复回收/文件已不存在可重试。晚到旧写入仍可能留下不可登记的孤儿，因此同一
退休代可再次清扫，当前 ready 目录始终保留。generation staging 改为含 key/代号/UUID
的 gen-* 名称，旧 UUID 年龄清扫不会误删跨进程构建的临时目录；新的租约感知 staging
清扫尚需接入。

新增 3 项真实 MySQL 联合用例：ready/活跃构建/活跃读者阻止回收，释放后回收；SQL
退休插入故障使过期读者删除一起回滚且文件仍可读；旧构建被退休后迟到落盘，再次清扫
不影响新 ready。另增 3 项磁盘测试：目录表错误/拒绝保护文件、缺失目录幂等、已老化
的 generation staging 不被旧清扫删除。完整服务端 159 项通过（28 文件，无跳过），
类型检查、ESLint 和 diff 检查通过。日志 `/tmp/genoffice-retirement-disk-test.log`、
`/tmp/genoffice-server-retirement-test.log`。确认随机测试库清空后关闭隔离 mysqld 并清理
自有目录，未操作用户数据库。

目前是显式指定 generation 的安全回收组件，尚无自动候选扫描/宽限期调度或业务接入；
不会主动退休当前 ready。目录/原文件最终清除还需保留 generation 高水位的归档方案，
不能为了清理旧文件直接删退休历史。HTTP 会话接线、共享 staging 对账、ready 缓存压力
淘汰、迁移/恢复及目标规模压测仍未完成，不能启用多实例共享写入。


### generation 回收候选扫描器（2026-11-07）

新增 ArtifactGenerationSweeper：仅识别合法 key/prefix 下的规范 g-N 普通目录，跳过链接、
非规范/超安全整数的代号和未知名称。默认 1 小时宽限，每批最多检查 64 代，可配置
1..4096；按 key/代号推进游标，保护、年轻或失败候选都会推进，下一完整轮再重试，
不会永远卡在前面的 ready/活跃读者上。只调用退休事务+磁盘 collect，不凭文件年龄
自行决定删除；失败保留可观察的有限错误码，不输出 SQL 细节。同实例重叠调用共享一次
扫描。hasMore 为保守续扫提示，完整轮结束重置游标，以发现迟到孤儿。

新增 4 项文件系统测试：分批推进与迟到重扫、宽限/未知目录/链接、失败可观察且不阻塞
其他候选、并发 single-flight 与参数校验。真实 MySQL 联合用例覆盖：先越过活跃旧读者
和当前 ready，回收已过期构建的未登记代；释放旧读者后下一轮回收旧代，当前数据可读，
实际配额字节只剩当前代。完整服务端 164 项通过（29 文件，无跳过），类型检查、ESLint、
diff 检查通过。日志 `/tmp/genoffice-generation-sweeper-test.log`、
`/tmp/genoffice-server-generation-sweeper-test.log`。随机测试库确认清空后关闭隔离 mysqld
并清理本次临时目录，未访问用户数据库。

目前扫描器供显式调用，未接入周期 GC/压力调度或 HTTP 会话；调度器还需处理 hasMore
续扫、关闭与数据库超时，租约感知 staging 对账仍待完成。候选数量有批次上限，但目录
列表/数据库 IO 不是硬耗时上限，不能据此宣称大目录规模或所有故障下关闭已验收。


### 回收调度与关闭控制组件（2026-11-07）

ArtifactGenerationSweeper 增加幂等 close：停止新轮次，当前 collect 完成后即停止后续
候选；关闭早于排队轮次执行时不访问回收目录。关闭报告 stopped，不把停机当作完整
扫描。关闭仍等待当前 OS/SQL 工作最终返回，不宣称底层 IO 有硬超时。

新增 ArtifactCollectionService：默认 10 分钟常规周期，hasMore 批次按 25ms 续扫，
默认错误退避 1 秒。手动请求合并、不重叠；手动触发也不能绕过失败退避。记录最近结果
及经过过滤的失败码，异常不会形成未处理 rejection。close 先取消定时器、关闭扫描器，
再排空当前工作，不再安排后续轮次。构造不自动启动，start/request 由服务所有者负责。

同时修复接线前发现的旧路径：removeForFile 不再递归删除整个 key，改为删除顶层旧格式
载荷；list 跳过 generation/未知子目录及错误 prefix 的非规范 key，并容忍并发消失。
避免文件级 TTL 清理绕过此前 evict/损坏修复的代际保护。

新增 2 项扫描器关闭测试、5 项调度测试（续扫/周期、手动合并、失败重试、排空关闭、
退避不可绕过），以及文件级清理保护/非规范 key 两项。完整服务端本轮 155 项通过，
18 项可选 MySQL 未启用（共 173 项），类型检查、ESLint 和 diff 检查通过。
日志 `/tmp/genoffice-server-collection-service-test.log`。上一阶段 164 项真实 MySQL 的
结果不替代本轮跳过的数据库验证。

调度组件尚未注册到 createParseServer；实际启用前需把目录引用纳入原文件 fileInUse，
防止旧 source TTL GC 碰到 catalog 外键或破坏迁移中的旧缓存。还需完成 DB 超时/关闭
宽限、会话与构建接线、共享 staging 对账及 generation 高水位归档/最终清理；当前仍
不支持多实例共享写入。


### 目录表原文件引用接入实际生命周期（2026-11-07）

MysqlArtifactCatalog 新增 hasFileReference；createParseServer 在 MySQL 模式实例化目录
适配器，fileInUse 纳入其引用。实际 TTL/容量 GC、HTTP DELETE 和上传失败回滚的原件
清理会先遵守该保护，不再先破坏旧缓存、随后才撞上 parse_files 外键。HTTP DELETE
返回既有 file_in_use/409，文案使用“解析文档/任务/读者”而不是数据库实现名词。
查询目录表失败时停止清理，不把无法确认视为无引用。

新增真实接口集成测试：上传并解析 PPTX、关闭会话、创建目录引用并将原件标为过期；
执行 GC 仍保留原件及旧模型，DELETE 返回 409；构建标为失败并重启后保护仍在。
删除测试中无退休历史的目录引用后，原件及旧缓存按正常 TTL 回收。完整服务端 174 项
通过（30 文件，无跳过），类型检查、ESLint、diff 检查通过。
日志 `/tmp/genoffice-server-source-catalog-test.log`。测试读取响应体后再做回收断言，避免
把尚未结束的 HTTP 读取误算为目录引用保护；测试库清空、隔离 mysqld 关闭及目录清理
均完成，未操作用户数据库。

这是实际服务入口的原件保护，尚未切换实际解析/读取到 generation 后端。任何目录引用
都保守保留原件，失败/退休历史也一样；引用最终清理与高水位归档需要继续实现，不能
把此项解释为新后端完整 TTL 清理已完成。下一阶段要跟踪并排空实际 GC 工作，再注册
后台调度，并完成共享 staging 对账、实际任务/会话读句柄接线及迁移/压测。


### 实际 GC 排空与 MySQL 后台 generation 回收接线（2026-11-07）

runGc 登记所有启动/排队任务，停机后不再接收新轮次，阶段和文件间检查 closing；已经
开始的单文件删除完成后不再删除下一文件。回收淘汰也遵守停止标记。server.close 停止
定时器、关闭 HTTP 后等待 GC 任务，再 flush 元数据及关闭数据库。health.maintenance
增加 gcTasks，反映队列和正在运行的任务。

MySQL createParseServer 现实际创建并启动 ArtifactCollectionService/GenerationSweeper，
启动即扫描一次，常规周期沿用 gcIntervalMs（默认 10 分钟），宽限 1 小时、批次 64、
续扫 25ms 和失败退避保持已测默认。手动 ParseServer.gc 也触发一轮异步 generation
扫描，仍先返回旧 GC 的完成；generation 结果由 health.maintenance.generationCollection
观测，不能把 await gc 等同所有 generation 已删除。关闭时先停止新调度，并在关 DB
之前排空当前 generation 收集。文件模式不启动 SQL 退休回收。

新增 3 项文件模式关闭测试：排空在途 GC、关闭前排队但未运行者不再列文件、当前删除
结束后保留下一个文件。新增 MySQL 关闭顺序测试：GC 被 gate 阻塞时 pool.end 未调用，
释放 gate 后 GC 仍能 ping 数据库，最后 pool.end 一次。另增真实周期回收测试：服务
本身在 30ms 测试周期保留活跃旧读者和当前 ready，释放读者后自动删除旧代；即使原件
时间改为过期，被引用的原件仍在，HTTP DELETE 409。
完整服务端 179 项通过（31 文件，无跳过），类型检查、ESLint、diff 检查通过。
日志 `/tmp/genoffice-server-gc-lifecycle-test.log`、`/tmp/genoffice-server-gc-shutdown-test.log`、
`/tmp/genoffice-server-live-generation-gc-test.log`。确认测试库清空后关闭隔离 mysqld 并清理
自有目录，未访问用户数据库。

此节替代前文“调度组件尚未注册”的检查点：回收维护链路现已注册。实际解析/HTTP
读取仍未切到 generation 协调器/读句柄；共享 staging 对账、迁移、压力触发准入联动、
ready 缓存主动淘汰、目录最终归档与备份恢复仍待完成。GC 排空不等于所有 HTTP/会话
后台任务都已统一跟踪，也没有建立 OS/SQL IO 的硬超时或目标硬件规模验收。

### 共享 generation staging 对账（2026-11-07）

- ArtifactGenerationSweeper 在完成 generation 目录扫描后，继续分批扫描严格命名的 `staging/gen-<key>-g-<generation>-<uuid-v4>` 目录；沿用同一后台调度、批量上限、游标、失败退避与关闭排空。
- 年龄只决定是否进入检查。删除前必须完成目录表 `retireGeneration` 事务，永久封禁过期代次的续租与发布。有效构建、当前 ready、有效读租约、未知资源或未来代次均保留；SQL 错误不删除。当前 ready 代次的重复 staging 保守保留，后续需构建意图登记才能进一步清理。
- 不删除对应的最终 generation 路径；该路径由既有 generation 扫描独立裁决。未知名称、不安全整数和符号链接不进入回收。
- 新增两项测试，覆盖共享 staging 的分批续扫、拒绝退役保留、下轮重访、年轻目录、SQL 失败与符号链接边界。针对 sweeper/service 的 13 项测试通过；服务端完整默认测试 160 通过、21 项 MySQL 集成测试跳过（本轮未启动隔离 MySQL）；类型检查、定向 ESLint、git diff --check 通过。日志 `/tmp/genoffice-staging-sweep-test.log`。
- 尚未证明本次 staging 扩展的真实 MySQL 多进程行为；此前 179 项含真实 MySQL 的结果属于上一版本。实际解析与 HTTP 读取仍待接入 coordinator/read handle，整体目标未完成。

### 共享 staging 真实 MySQL 与后台定时验证（2026-11-07）

- 新增双独立连接池的真实 MySQL 用例：老目录在有效构建租约下保留；数据库强制过期后清理成功；旧 token 的 renew/complete 均失败；重新 claim 使用更高代次；当前 ready 对应的 staging 仍保守保留。
- 扩展实际 MySQL 服务器后台回收测试：无直接调用 sweeper，使用服务内 30ms 周期观察有效 staging 被保护；使数据库租约过期后，定时回收自动删除 staging，旧发布被封禁，当前 ready 可读、原文件受引用保护。
- 隔离 MySQL 下全量服务端 182 项通过、31 个测试文件通过、无跳过（日志 `/tmp/genoffice-staging-mysql-test.log`）；其后扩展的实际服务用例所在文件单独复验 6 项通过（`/tmp/genoffice-live-staging-test.log`）。类型检查、定向 ESLint 与 diff 空白检查通过。测试库全部删除，专用 MySQL 进程正常停止，临时数据目录已清理。
- 本项验证的是共享 staging 回收与租约封禁，不能代替实际解析/HTTP 读取接线或多进程容量验收；整体目标保持未完成。

### 构建租约取消接入隔离进程（2026-11-07）

- IsolatedWorker 的 ProcessLimits 增加可选 AbortSignal：已取消时在 fork 前拒绝；运行中取消通过父进程终止子进程，保留 Error 取消原因；主动终止和自然退出均移除监听。
- PPTX 源解析、PPTX 持久化渲染与 DOCX 会话输入接收 signal，并只交给父进程的 IsolatedWorker；源解析显式移除 signal 后再序列化 IPC，缓存渲染显式置空。
- 新增真实子进程测试：预取消不产生进程；子进程进入 CPU 忙循环后取消可终止，等待 terminate 后 PID 消失、内存统计清零、监听移除。隔离进程文件 9 项通过。服务端默认全量测试 162 项通过、22 项 MySQL 测试跳过；本轮未启动数据库。类型检查、定向 ESLint 与 diff 空白检查通过。日志 `/tmp/genoffice-worker-abort-suite.log`。
- 这完成了调度器接入的 worker 取消前提，尚未把 coordinator 的构建信号传入实际 ArtifactSession 调度；队列等待期间的取消、读租约接线仍待完成。

### 解析队列的构建取消（2026-11-07）

- ParseQueue.run/submit 新增可选第三参数 AbortSignal。预取消拒绝准入；排队取消立即移除并拒绝任务，随后重新检查 FIFO 队首能否启动，避免已失效的大任务阻挡后续任务。
- 准入后、执行微任务前再次检查信号，避免这一窗口启动已取消 worker。运行中的任务不因信号提前释放名额或内存，必须等 work（含 worker 退出与清理）settle；取消后的成功结果也拒绝返回。运行中实际终止由 work 使用同一信号合作完成，队列不强行结束任意 Promise。
- 取消、出队启动和 close 拒绝均移除排队监听。close 保持等待真实运行任务的原语义。
- 新增三项行为测试，覆盖取消队首后启动可容纳任务、运行任务清理前保持内存名额、预取消和准入微任务窗口不执行 work。队列测试 7 项通过，服务端默认全量 165 项通过、22 项 MySQL 测试跳过。类型检查、定向 ESLint、git diff --check 通过；日志 `/tmp/genoffice-queue-cancellation-test.log`。
- 下一步仍需把 coordinator 构建信号同时传给实际 ArtifactSession 的队列与 worker，并接入持久化 generation 读取；本项不代表主流程已经迁移。

### 共享源解析入口与真实 worker 联测（2026-11-07）

- 从 ArtifactSession.open 提取实际源解析为 ArtifactSession.build，原文件存储路径也调用此入口，保持 document/styles/unit/font/external-media 记录格式一致。入口接收独立的构建 signal，传给 ParseQueue 与实际 PPTX/DOCX worker，在准入、源打开、单元循环和回调返回等处检查取消。查看者的 signal 不会自动成为共享构建的所有权信号。
- 新增 artifact-source-build.test.ts：使用真实 PPTX、DOCX 源文件、ArtifactGenerations、ParseQueue 与真实子进程，catalog 使用替身验证 coordinator 回调接线。两种格式均产出可读模型；排队关闭不启动 worker；两种格式打开中关闭均等待 worker 退出、内存名额清零、staging 清空且不提交 ready。5 项通过。
- 默认全量服务端 170 项通过、22 项 MySQL 测试跳过；类型检查、定向 ESLint、git diff --check 通过。日志 `/tmp/genoffice-source-build-suite.log`。首次全量暴露既有 staging 测试的亚毫秒 mtime 边界，改为显式设置过去时间后重跑通过。
- 这是源构建代码与 coordinator 的组件集成验证，尚未把 HTTP 会话切换到 SQL generation 后端；真实 MySQL 源解析联测、读租约、离线包依赖、旧布局迁移、损坏重建及跨进程容量仍须完成。不能据此宣称主流程已切换或整体目标完成。

### Generation 缓存渲染与读取租约工作区间（2026-11-07）

- PptxSession.openCached 增加可选 ReadyArtifact 指针；缓存 worker 检查指针 key 与请求 key 一致，通过 ArtifactGenerations.open 校验规范路径、清单摘要与大小，再读取持久化模型。未传指针时保留旧布局读取。
- ArtifactReadHandle.use 提供不暴露原始 reader 的外部工作区间：传入该句柄 signal，跟踪真实底层 Promise；取消立即拒绝等待者，但 close 必须等待外部工作（含 renderer.dispose）settle 才释放数据库读租约。read 复用相同跟踪机制。
- 新增取消时外部 renderer 清理尚未完成则不释放读租约的测试。源构建联测扩展为：真实 PPTX 构建 generation 后删除源文件，通过 read handle.use、指定 generation 指针和真实缓存 worker 渲染成功，worker 退出后释放租约一次。
- 服务端默认全量 172 项通过、22 项 MySQL 测试跳过；类型检查、定向 ESLint、diff 检查通过。日志 `/tmp/genoffice-generation-render-suite.log`。
- 本轮是读取/缓存渲染组件接线，数据库使用替身；HTTP ArtifactSession 仍使用旧 ArtifactStore reader，尚未切换到读租约句柄。需继续处理 session 所有权、辅助离线包构建依赖及 SQL 主流程接线，整体目标未完成。

### 会话采用读取租约句柄（2026-11-07）

- ArtifactSession.openPinned 接管独立 view 的 ArtifactReadHandle，验证 artifact identity、document 基本结构和 PPTX external-media 索引；打开失败释放句柄。会话 reader 支持旧 ArtifactReader 与租约句柄两种实现。
- check 同时检查句柄失效，模型读取沿用受保护 read；PPTX unit 的完整排队/worker/清理过程放在 handle.use 内，信号传给队列和缓存 worker，指定该句柄的 generation 指针。close 同步禁止后续访问并开始取消、释放；新增 dispose 可等待读取与外部工作清理后释放租约。
- 扩展真实持久化 PPTX 测试：删除原始源后通过实际 ArtifactSession.openPinned/unit 渲染；阻塞队列再提交 unit，dispose 会移除排队渲染、不启动新 worker，并释放读租约一次；后续 layoutInfo 被拒绝。
- 服务端默认全量 172 项通过、22 项 MySQL 测试跳过；类型检查、定向 ESLint、diff 检查通过。日志 `/tmp/genoffice-pinned-session-suite.log`。
- HTTP 入口尚未调用 openPinned；切换前仍需辅助 bundle 构建的独立依赖 pin（不能把共享 bundle 的生命期绑定到某个 view）、服务关闭时 await dispose、旧布局迁移/损坏重建和实际 SQL 端到端验证。当前组件具备视图生命周期，不代表共享存储主流程已上线。

### 服务关闭等待会话异步释放（2026-11-07）

- server.ts 所有会话关闭入口（DELETE、过期、恢复竞争、关闭中完成的解析、整体关闭）统一经过 closeSession。同步 close 先阻止后续使用，再追踪 dispose Promise；WeakMap 确保同一会话只提交一次释放，即使已从活动 map 删除也继续由服务持有清理任务。
- 整体 close 在关闭解析队列前开始取消现有会话，完成异步构建后补扫会话；HTTP/GC 排空后等待所有 sessionDisposals，再 flush 元数据和关闭 MySQL。close 本身复用同一 Promise。
- ArtifactSession 跟踪实际渲染任务；dispose 等待这些任务完成，租约会话还等待 read handle 释放。旧存储渲染也纳入等待。
- 新增真实 HTTP 测试：创建 PPTX 会话，DELETE 移出活动 map，人工延迟 dispose；服务关闭仍等待释放，重复 close 共用 Promise，dispose 仅调用一次。定向 10 项通过；默认全量 173 项通过、22 项 MySQL 测试跳过。类型检查、定向 ESLint、diff 检查通过。日志 `/tmp/genoffice-session-disposal-suite.log`。
- 此次未启用 SQL generation HTTP 入口，也未补齐共享 bundle 独立依赖 pin；SQL 关闭顺序的本次变化仍需真实数据库回归。整体目标未完成。

### 离线包构建的独立 generation 依赖（2026-11-07）

- MysqlArtifactCatalog.forkRead 在 artifact→source-reader 锁顺序下，从仍有效的源读租约创建新 token，保持相同 generation；不读取当前 ready 指针，因此替换版本后仍保护旧模型。源 token 失效或已释放则拒绝；观察到过期会删除 token，防止复活。
- ArtifactReadHandle.fork 创建独立心跳/截止时间/关闭生命周期，共享不可变 reader 索引，不暴露原 reader。原 view 关闭不取消 fork；独立租约由依赖任务释放。
- ArtifactSession 的共享 bundle 构建在排队前派生独立 pin，以依赖 signal 进入队列/use，读取 external-media 和摘要使用依赖句柄；完成、失败或缓存命中均关闭依赖 pin。
- 新增句柄分离测试与实际 PPTX bundle 测试：构建仍排队时关闭发起 view，原 pin 释放，随后继续完成并缓存 bundle，再释放依赖 pin。定向 15 项通过；默认全量 175 项通过、22 项 SQL 测试跳过（日志 `/tmp/genoffice-bundle-dependency-suite.log`）。其后新增真实 SQL old-generation fork/过期封禁用例，已类型检查和 lint，尚未执行该 SQL 用例。
- SQL 主流程仍未启用。切换前还需追踪 fork SQL 往返尚未进入 ArtifactStore 构建表时的异步任务，确保整体关闭排空该窗口；真实 SQL fork 验证、辅助包 generation 接线仍待完成。整体目标保持未完成。

### 离线包依赖申请窗口的任务所有权（2026-11-07）

- ArtifactStore.runOwned 在执行异步依赖申请前登记任务，随后同步开始申请，避免额外微任务窗口使 view 先关闭。activeFileIds 覆盖这些任务的原文件；drain 持续等待 ownedTasks 与 building，包含依赖返回后才登记的构建。
- ArtifactSession.ensureBundle 将从 forkRead 到构建完成/失败、独立 pin 释放的完整过程交给 runOwned；服务关闭原有 artifacts.drain 因而覆盖尚未完成 fork SQL 的阶段。
- 新增存储测试：依赖未返回时 drain 保持等待、source 引用有效；依赖返回并开始构建后仍等待真实清理完成；失败依赖也被观察并移除引用。定向 23 项通过；默认全量 177 项通过、23 项 MySQL 测试跳过。类型检查、定向 ESLint、diff 检查通过。日志 `/tmp/genoffice-owned-bundle-suite.log`。
- 仍需执行新增真实 MySQL forkRead 用例，并继续 SQL generation HTTP/辅助包接线。此处补上关闭窗口，不代表已经完成主流程切换或硬件容量验收。

### 独立依赖与源解析真实 MySQL 联测（2026-11-07）

- 执行 forkRead 真实 MySQL 测试：新 ready 发布后从旧 view 派生依赖，关闭原 view 后旧 generation 仍拒绝退役；依赖可独立续租，释放后才允许退役；已释放/过期 token 不能派生或续租。
- 新增实际服务器测试：DELETE 后人工延迟 view.dispose，整体 close 保持 MySQL pool 存活；解除延迟后清理期间 ping 成功，随后 pool.end 仅调用一次。
- 新增真实源解析联测：两个独立数据库连接池的 ArtifactCoordinator 并发请求同一真实 PPTX，只发生一次源解析；通过实际 SQL read handle 派生依赖并创建 ArtifactSession.openPinned，删除源文件后仍可用真实缓存 worker 渲染；关闭 view 后独立依赖继续读取，最后单独释放。
- 最终隔离 MySQL 全量服务端 202 项通过、32 文件通过、无跳过；类型检查、定向 ESLint、diff 检查通过。日志 `/tmp/genoffice-sql-source-suite.log`。确认测试数据库全部删除后，专用 MySQL 正常退出并清理数据目录。
- 该结果证明 SQL/coordinator/真实源解析/租约会话的组件集成，不代表 HTTP 解析入口已经切换，也不能证明独立 OS 进程的全局内存/磁盘准入或 8 核 16GB 容量。HTTP 接线、辅助包 generation、旧布局迁移/损坏恢复和硬件验收仍未完成。

### HTTP 主模型入口的可选 catalog 接线（2026-11-07）

- createParseServer 增加 artifactBackend: 'local' | 'catalog'，默认 local；catalog 必须配置 MySQL。该程序化选项用于分阶段接线验证，尚未增加 CLI 环境开关或默认启用。
- 三处会话打开（v1 创建、历史懒恢复、v2 后台任务）统一 openDocument。catalog 分支经 ArtifactSession.openShared，完整任务由 runOwned 追踪，通过 coordinator 构建 generation，再 pin/openPinned。冷构建通过队列准入通知返回，已有共享任务/SQL busy 也通知异步等待者。
- v2 缓存探测改为原子 SQL pin→校验 document→释放，命中维持 201，冷解析维持 202。服务关闭先取消 coordinator，再关闭队列、等待 coordinator 与存储任务，最后释放会话/数据库。catalog 完成后清理内存 phase/admission 状态，记录真正开始的构建次数。
- 新增真实 MySQL HTTP 测试：冷 v2 返回 202，轮询 ready、v1 unit 真实渲染；再次打开返回 201；重启后原 session unit 正常且 ArtifactSession.build 总共只调用一次；目录表 ready_generation=1。
- 最终真实 MySQL 全量 203 项通过、32 文件通过、无跳过；类型检查、定向 ESLint 与 diff 检查通过。日志 `/tmp/genoffice-http-catalog-suite.log`。测试库清空，隔离 MySQL 已停止并清理。
- 这已是可选 HTTP 主模型接线，旧的“所有 HTTP 都未接入”描述被本节取代。但默认后端仍 local，辅助 bundle 仍旧存储布局，SQL ready 损坏恢复/旧缓存迁移、跨节点任务状态与全局配额尚未完成；不能把此选项视为共享目录多实例生产支持。DOCX HTTP catalog 专项、并发/故障/恢复及硬件验收继续推进。

### DOCX catalog HTTP 与启动约束验证（2026-11-07）

- catalog HTTP 会话测试扩展为 PPTX/DOCX 两种真实文件。DOCX 冷 v2 返回 202，正文与 styles 可读；缓存打开返回 201；重启恢复后正文 JSON、样式 JSON 与此前一致，源构建总计只执行一次，SQL ready_generation 保持 1。
- 新增启动校验测试：未知 artifactBackend、catalog 缺少 MySQL 均在创建服务资源前拒绝。
- 隔离真实 MySQL 全量服务端 205 项通过、32 文件通过、无跳过；类型检查、定向 ESLint、diff 检查通过。日志 `/tmp/genoffice-docx-http-suite.log`。测试数据库全部删除，专用 MySQL 已正常停止并清理。
- 该测试覆盖小型 DOCX 的持久化/历史复用，不代表 GB 文件或 8 核 16GB 容量验收。catalog 尚为可选程序化入口，损坏 ready 修复、旧缓存迁移、辅助包 generation 和多实例资源/任务协调仍需完成。

### SQL ready 清单损坏的条件失效与重建（2026-11-07）

- MysqlArtifactCatalog.invalidateReady 按 expected key/generation/storagePath/manifest SHA 比较后才清除 ready 指针。使用 artifact→job 锁顺序，不改变构建代次计数，保留正在构建的替换 job；活跃读 token 继续存在。迟到旧报告不影响新 ready，不直接删除文件。
- ArtifactCoordinator 遇到 disk.open 的 ArtifactCorruptionError 可撤下确切 ready 后重新 claim，一次调用最多尝试一次清单修复；普通 EACCES 等 IO 错误原样失败，不重建。旧代次由原有租约/退役/清扫裁决回收。
- 新增 coordinator 损坏清单重建与权限错误不失效测试；真实 SQL 测试验证撤下期间新 pin 不可用、旧 reader 仍续租、替换 job 可续租并完成、新 ready 不被旧报告撤下。
- 新增真实 catalog HTTP 恢复测试：源解析完成后关闭服务器，破坏 generation 1 manifest，重启访问原 session unit 正常，源构建累计两次，ready_generation=2，旧目录仍在。
- 最终隔离真实 MySQL 全量 209 项通过、32 文件通过、无跳过；类型检查、定向 ESLint、diff 检查通过。日志 `/tmp/genoffice-corrupt-mysql-suite.log`。测试数据库全部删除，专用 MySQL 正常退出并清理。
- 当前自动恢复覆盖打开清单时发现的损坏/缺失。单条 document/unit/font 内容损坏、已打开 view 的错误恢复、并发修复更广泛故障注入仍未完成；旧布局迁移、辅助包 generation、多实例配额及硬件验收继续保留在整体目标中。本节由后续「单条记录损坏」检查点取代。


### 单条记录损坏上报与已打开视图自动恢复（2026-11-07）

- `ArtifactCorruptionError` 增加稳定 `code = 'artifact_corrupt'`，可跨子进程 IPC 识别而非被当作 worker 崩溃。
  `pptx-artifact-worker` 回传该 code，`PptxSession.handleMessage` 在父进程还原为损坏错误。
- `ArtifactReader.openDirectory` 支持 `onCorruption`：惰性 gzip 帧/sha256 校验失败时只上报一次（并发读取同一坏帧不会打爆目录表）。
  `ArtifactGenerations.open` 透传回调；`ArtifactReadHandle.open` 把回调绑定到**本次句柄的确切 generation 指针**，
  `reportCorruption` 按句柄去重调用 `catalog.invalidateReady`，普通 EACCES 等 IO 错误不撤下 ready；fork 句柄各自上报。
  关闭时先等在途失效上报结束再释放读租约。
- `ArtifactSession` 在 catalog 后端持有修复闭包：document/styles/unit/font 以及 PPTX 缓存渲染遇到损坏错误时，
  经 single-flight 撤销旧 ready → coordinator 重建 → pin 新代次 → 换用新句柄后重试一次；每个视图只允许一次修复，
  避免损坏循环。旧句柄保留到视图关闭再释放，在途读取不会被中途 abort；model/fonts/document 与离线包缓存同步失效。
- HTTP 层统一把损坏映射为可重试 `503 artifact_corrupt` 并带 `Retry-After: 1`，styles/fonts/bundle 等没有局部
  parseFailure 映射的路由也适用；unit/layout 的既有 catch 不再把损坏误报成 404。
- 新增 `artifact-corruption-recovery.test.ts` 6 项、`artifact-read-handle.test.ts` 3 项：单帧损坏只上报一次、
  已打开视图重建后重试成功且旧代次目录仍在、第二次损坏不循环重建、两个视图并发修复只重建一次、
  document 损坏在准入阶段先修复、EACCES 不失效、fork 独立上报、关闭等待在途上报。定向 25 项通过。
- 完整服务端**串行**回归 189 项通过、30 项可选 MySQL 测试跳过、0 失败（日志 `/tmp/genoffice-corruption-serial.log`）。
  类型检查、改动文件 ESLint、`git diff --check` 通过。沙箱内高并发跑法出现 2 项 20 秒超时
  （`artifact-preview`、`pptx-session`），单独复跑分别 7/7、12/12 通过，属并行负载而非断言回归。

此步补上了「单条记录损坏 / 已打开 view / 并发修复」这一检查点，但只在目录表后端与直接读取路径生效：
已打开 view 中另一个独立渲染子进程自己打开的损坏帧现在能回传 code，仍依赖 worker 协作；
离线包衍生产物损坏只清除视图内缓存、由下次请求走旧存储重建，尚未走 generation 修复；
辅助包 generation、旧布局迁移、多实例配额、备份恢复与目标硬件验收仍未完成，整体目标保持未完成。本节由后续「旧布局迁移」检查点取代。


### 旧扁平产物安全迁移到 generation（2026-11-07）

- `ArtifactSession.importLegacy` 在 catalog 后端冷构建前检查旧 `artifacts/<prefix>/<key>/manifest.json + units.bin`：
  完整比对 identity（fileId/format/解析指纹/schema/options）、document 格式与字体表、必需 unit 与 font 记录，
  再**两遍读取**——先逐帧验证 gzip/sha256，确认无损坏后才写入新 generation，避免半成品发布。
- 校验通过时直接把旧记录复制为 generation 1，不重新解析源文件，不删除旧扁平文件（由既有 TTL/回收裁决）；
  目录表损坏、缺记录、schema 不符、单帧损坏或 generation-only 目录一律回退真实源解析。
  `ArtifactStore.stats.legacyImports` 与 health 暴露迁移次数，`sourceParsesStarted` 不增长。
- 与 coordinator 的 single-flight 一致：多个并发视图只发生一次导入/构建；导入路径同样通知 v2 等待者。
- 新增 `artifact-legacy-import.test.ts` 6 项：无源解析导入且内容一致、并发只导入一次、单帧损坏回退、
  损坏 manifest 与错误 schema 回退、generation-only 目录不误判、身份不匹配不导入。
- 完整服务端**串行**回归 195 项通过、30 项可选 MySQL 跳过、0 失败（日志 `/tmp/genoffice-legacy-serial.log`）。
  类型检查、改动文件 ESLint、`git diff --check` 通过。

迁移是单次一次性成本（逐帧读两遍），不改变旧缓存的删除策略；尚未接入跨进程统一配额与
generation 高水位归档。辅助包 generation、多实例配额、备份恢复、Linux cgroup 内核验证、
Android 续传/版本目录与目标硬件压测仍未完成，整体目标保持未完成。本节由后续「辅助包 generation」检查点取代。


### 辅助离线包接入 generation 与独立读租约（2026-11-07）

- `ArtifactSession` 在 catalog 后端把离线包发布为独立 `artifactKey`（`options.purpose=offline-bundle`，
  绑定模型 generation key 与模型内容摘要）的 generation：经 `ArtifactCoordinator.getOrBuild` 领取 SQL 构建租约、
  `ArtifactGenerations.publish` 原子发布，再用 `ArtifactReadHandle.open` 给视图一个独立读租约。
  构建期间 fork 模型 generation 句柄，保证被哈希的源文件 part 与模型记录在引用期间不被回收；
  local 后端仍保留原 `ArtifactStore.getOrBuild` flat 布局，行为不变。
- `bundleManifest` / `bundleResource` 的派生记录使用视图内 single-flight 修复：帧或清单损坏时按确切
  generation 指针 compare-and-clear 撤下 ready → coordinator 重建 → pin 新代次 → 重试一次，每视图限一次。
  只撤派生产物，模型 generation、其读租约与已打开视图不受影响；普通 IO 错误不撤 ready；
  manifest 损坏在新视图 attach 时由 coordinator 的条件失效路径重建。
  模型资源（`layout/N.json`、`fonts/*`）仍走原有模型修复路径，视图关闭统一释放模型与派生 pin。
- 发布与 pin 之间 ready 被并发撤下时重试一次 claim；`store.stats.buildsStarted` 与 health 同时覆盖派生构建。
- 新增 `artifact-shared-bundle.test.ts` 8 项：generation 落盘/独立 pin、跨视图复用、帧损坏重建重试、
  并发只重建一次、清单损坏新视图恢复、pin 竞争、EACCES 不失效、模型资源隔离。
  `offline-bundle-catalog-mysql.test.ts` 3 项真实 SQL HTTP 集成：SQL 代次与读租约核对、HTTP 损坏只重建派生产物、
  服务器重启后复用已修复的派生 generation。
- 带隔离真实 MySQL 的**串行全量** 236 项 / 36 文件通过、无跳过（日志 `/tmp/genoffice-bundle-mysql-full.log`）；
  不带 MySQL 的串行全量 203 通过 / 30 可选跳过 / 0 失败。类型检查、改动文件 ESLint、`git diff --check` 通过。

辅助包不再依赖进程内 flat 缓存，但仍未解决旧 flat 离线包导入、跨进程统一空间准入、generation 高水位归档、
备份恢复演练与目标环境压测；整体目标保持未完成。本节由后续「跨进程统一空间准入」检查点取代。


### 跨进程统一空间准入与启动对账（2026-11-07）

- 新增 `storage-reservations.ts`：`parse_storage_reservations` 表按 `id/owner/bytes/expires_at_ms` 记录
  **尚未落盘的在途写入**，`GET_LOCK`（库名哈希，规避 MySQL 64 字符上限）+ 过期行清理把
  「读取全局预留 → 检查配额/物理空闲 → 发布预留」串行化到跨进程；锁内重入由 AsyncLocalStorage 短路，
  避免同进程另一连接自等死锁。心跳按租约 1/3 续期，行被回收后一律 fail-closed，不静默重新放行。
- `StorageBudget` 新增可选 `shared` 账本：原有进程内 `held` 改为 `SUM(未过期行)`，小写入按 1 MiB 块
  向上取整批量预占（只可能多占、不会超卖），块内消耗不产生 SQL 往返；`reservation.bytes` 返回实际预占量，
  保证 GC 的 `committedReservationBytes` 与账本一致。非 shared 路径行为不变。租约丢失抛
  `storage_admission_lease_lost`，HTTP 统一为可重试 503 + `Retry-After: 1`（上传与解析两条路径都覆盖）。
- catalog 后端默认启用共享准入，也可用 `storageAdmission: 'instance' | 'shared'` 显式切换；
  `storageReservationLeaseMs` 纳入统一数值校验。启动时 `reconcile()` 清掉崩溃进程遗留的过期行并记日志，
  优雅关闭删除本 `owner` 的全部行（其他实例无需等租约到期）。`/v1/health` 的 `storageBudget` 增加
  `sharedReservedBytes` 与 `coordination`。
- 新增 `storage-budget-shared.test.ts` 6 项：双实例不可超卖、块批量与余量消耗、过期行 fail-closed、
  renew 失效不重新放行、释放幂等、物理空闲计入所有实例预留；
  `storage-reservations-mysql.test.ts` 5 项真实 MySQL：双实例围栏、并发准入只有一个成功、崩溃行回收、
  按 owner 释放、catalog 默认 shared 与显式 opt-out 的 HTTP health。
- 带隔离真实 MySQL 的**串行全量** 247 项 / 38 文件通过、无跳过（`exit=0`，日志
  `/tmp/genoffice-shared-admission-mysql-full.log`）；不带 MySQL 的串行全量见
  `/tmp/genoffice-shared-admission-local-full.log`。类型检查、改动文件 ESLint、`git diff --check` 通过。

共享账本只解决「在途写入」的可见性；水位回收仍由本地扫描触发，跨进程重复回收、generation 高水位归档、
目录最终清理、旧 flat 离线包导入后的最终清理对账、备份恢复与目标硬件压测仍未完成，整体目标保持未完成。
本节由后续「旧 flat 离线包导入」检查点取代。


### 旧 flat 离线包两遍校验导入（2026-11-07）

- `ArtifactSession.importLegacyBundle` 与主产物 `importLegacy` 对称：catalog 后端冷构建前先查旧
  `artifacts/<prefix>/<bundleKey>/manifest.json + units.bin`。除完整 identity 比对（含绑定模型的
  generation key 与内容摘要）外，还把 `bundle` 记录当作客户端权威清单校验：schema/artifactKey/
  modelArtifactKey/fileId/format/inventory、资源哈希与 totalBytes、页面/字体资源计数，并要求
  `bundle:layout` 与每个 `bundle:part:*` 帧和清单项双向完备、内容与哈希一致。
- 两遍逐帧 gzip/sha256 校验后才写入 generation：第一遍同时完成清单交叉核对，第二遍才复制；
  任一帧损坏、清单不符、结构缺失、generation-only 目录或身份不匹配均回退真实 `runBundleBuild`。
  导入不重新哈希原 ZIP、不 fork 模型读租约、不重新解析源文件，也不删除旧 flat 文件（仍由 TTL/回收裁决）。
- 关键前提：`ArtifactReader.contentDigest` 只依赖记录 `(id, rawLength, sha256)`，模型 flat 导入为
  generation 后摘要不变，因此 catalog 后端 `bundleIdentity()` 计算出的 key 与历史 flat 离线包一致；
  模型换代后 key 改变，旧包不会被误导入。`ArtifactStore.stats.legacyBundleImports` 随 health 暴露。
- 新增 `artifact-legacy-bundle.test.ts` 10 项：导入且不重建/不重解析、真实 `writeOfflineBundle`
  产物（含 STORE/DEFLATE 与非 ASCII 媒体路径）逐帧一致、并发只导入一次、单帧损坏、清单与派生记录
  不一致、多余/缺失派生记录、损坏 manifest/过期 schema/错误 key、generation-only 目录、identity 不匹配。
  `offline-bundle-catalog-mysql.test.ts` 新增 1 项真实 SQL HTTP 集成：生成模型后注入历史 flat 包，
  经 `/v2/.../bundle` 导入为 SQL generation 1，health 计数为 1，layout.json 的 ETag 与清单哈希一致。
- 不带隔离 MySQL 的**串行全量** 219 项通过 / 38 项可选跳过 / 0 失败
  （`/tmp/genoffice-legacy-bundle-local-full.log`）；带隔离真实 MySQL 的串行全量
  **258 项 / 39 文件全部通过、无跳过**（`exit=0`，`/tmp/genoffice-legacy-bundle-mysql-full.log`）。
  类型检查、改动文件 ESLint、`git diff --check` 通过。测试库全部删除，专用 MySQL 正常退出并清理目录。

导入只解决「不重复构建」；旧 flat 文件的最终清理与回收对账见下一检查点，generation 高水位归档、
目录最终清理、软水位回收跨进程一致性、解析中增量首屏、备份恢复与目标硬件压测仍未完成。
本节由后续「旧 flat 最终清理与回收对账」检查点取代。


### 旧 flat 最终清理与回收对账（2026-11-07）

- 新增 `parse_artifact_flat_archives` 与 `MysqlArtifactCatalog.authorizeFlatArchive`：在
  artifact → job → retirement 锁序的同一事务中确认 ready 指针合法、目录行 state=ready、
  没有 `building` 任务（导入/重建可能仍在读旧文件）、ready 代次未被退役，再登记不可逆归档标记
  并返回确切的 `ReadyArtifact`。重复授权幂等；条件失效、代次退役或活跃构建一律拒绝。
- `ArtifactGenerations.collectLegacyFlat` 在删除前先用返回的摘要打开并校验新 generation 目录
  （规范路径、manifest SHA、数据长度），再校验顶层两个 flat 路径都是普通文件；只 unlink
  `manifest.json` / `units.bin`，同步 key 目录并返回实际释放字节。不递归、不触碰 g-N 子目录、
  不跟随符号链接，generation 缺失/摘要不符/非普通文件一律失败且不留半删除状态。
- `ArtifactGenerationSweeper` 在 generation 与 staging 阶段之后增加第三类 flat 候选：沿用同一
  批次上限、游标、宽限、失败退避与关闭排空；只有 SQL 授权成功才计入 `flatCollected/flatBytes`，
  无 catalog 后端时一律保护。`ArtifactCollectionService` 无需改动即沿用既有调度。
- `ArtifactStore` 的 `diskEntries` 单独统计顶层 flat 字节，`legacyFlatEntries` 报告已发布
  generation 的冗余字节，`forgetFlat` 清除本地 reader 缓存；stats 新增
  `legacyFlatCollected/CollectedBytes/PendingBytes` 并随 health 暴露。`performGc` 刷新待清理字节
  并催促后台扫描；压力回收路径**不做同步 SQL 删除**，避免目录表事务与共享准入 `GET_LOCK` 嵌套，
  因此释放仍受默认 1 小时宽限，这是明确的保守取舍。
- 新增 `artifact-legacy-flat-collection.test.ts` 11 项：只删顶层且 generation 可读、SQL 拒绝、
  新代缺失/摘要不符失败闭合、非普通文件与符号链接、幂等不重复计数、扫描器三阶段顺序/宽限/
  无 catalog 保护/SQL 失败不泄露细节/多 key 分批续扫。新增 `artifact-legacy-flat-mysql.test.ts`
  2 项真实 MySQL：授权语义（活跃构建、退役、条件失效、幂等）与 HTTP 端到端（GC 触发清理、
  health 字节对账、`totalBytes()` 下降等于释放字节、归档行、unit 仍可读、重复 GC 不重复计数）。
- 带隔离真实 MySQL 的**串行全量** 271 项 / 41 文件通过、无跳过（`exit=0`，
  `/tmp/genoffice-legacy-flat-mysql-full.log`）；不带 MySQL 的串行全量 230 项通过 /
  41 项可选 MySQL 跳过 / 0 失败（`exit=0`，`/tmp/genoffice-legacy-flat-local-full.log`）。
  类型检查、改动文件 ESLint、`git diff --check` 通过。测试库全部删除，专用 MySQL 正常退出并清理目录。

清理解决的是「同一份内容被重复计费」；generation 高水位归档、目录与退休历史最终清理、
软水位回收的跨进程一致性、解析中增量首屏、备份恢复演练与目标硬件压测仍未完成。
本节由后续「generation 高水位归档与目录最终清理」检查点取代。


### generation 高水位归档与目录最终清理（2026-11-07）

- **SQL 墓碑归档**：新增无外键的 `parse_artifact_archives`，`MysqlArtifactCatalog.archiveArtifact`
  在 artifact → job → readers → retirements 锁序的同一事务内确认 `ready_generation IS NULL`、
  非 building、无有效期内构建租约与读租约（过期读 token 一并删除），把退休明细与 flat 归档行
  压缩成一行墓碑（高水位 generation、退休数、flat 标志、fileId、时间），删除 job/明细/目录行后提交。
  删除目录行是解除 `parse_artifacts → parse_files` 外键、让临时原文件最终可按 TTL 回收的关键；
  墓碑不带外键，`claim` 用 `INSERT ... COALESCE((SELECT generation FROM parse_artifact_archives ...), 0)`
  在单条语句里恢复高水位，重新构建绝不会从 g-1 复用。归档重复调用幂等。
- **磁盘最终清理**：`ArtifactGenerations.collectEmptyKey` 只接受规范 key、非符号链接、`readdir` 为空的
  根目录；SQL 授权成功后用 `rmdir`（非递归）删 key 与空 prefix 桶。并发发布者在授权后新建 g-N 时
  `ENOTEMPTY` 被忽略，目录留给新 claim 管理，不会半删除。空目录不占字节，结果只做计数。
- **高水位**：`ArtifactGenerationSweeper` 增加每 key `retainGenerations`（默认 4，可配置 1..64），
  超出保留窗口的最老代次不再受 1 小时宽限保护；`ArtifactCollectionService.request(urgent)` 让容量
  高水位路径跳过 generation 宽限。两者都只影响 generation 候选，staging/flat/空目录仍按宽限裁决，
  且一律仍须 `retireGeneration` SQL 授权——ready、活跃构建与活跃读者不会被压力误删。
  新增第四阶段空目录候选，沿用同一批次上限、游标、失败退避与关闭排空；结果新增
  `archivedKeys/retiredRows/highWaterArchived`，`health.artifacts` 增加 `archivedKeys/archivedRetiredRows`，
  `health.maintenance.generationCollection` 增加 `urgentPasses`。`generationRetainCount` 纳入统一数值校验。
- **明确边界**：归档只覆盖已无 ready 且磁盘清空的目录行（如撤下 ready 后重建失败、失败构建残留）。
  正常 ready 产物仍保守保护原文件；压力下主动撤下 ready 回收可重建产物尚未实现。
  `parse_artifact_archives` 是每个已归档 key 一行、永久保留的清单，不是完整备份方案。
- 新增 `artifact-archive-collection.test.ts` 10 项：SQL 授权后才删空根、非空/非规范/链接保护、
  veto、并发发布者赢下 rmdir 竞态、保留窗口只加速最老代次、压力不加速 staging/flat/空目录、
  归档计数与幂等、SQL 失败不泄露细节且下轮重试、多 key 分批续扫、关闭排空。
  `artifact-archive-mysql.test.ts` 4 项真实 MySQL：ready/构建/读者围栏与明细压缩、墓碑恢复高水位、
  `collectEmptyKey` 真实 SQL、以及后台归档后原文件按 TTL 被 GC 回收的 HTTP 端到端。
  另为 `request(urgent)` 补充一项调度用例。定向合计 35 项通过。
- 带隔离真实 MySQL 的**串行全量** 286 项 / 43 文件通过、无跳过（`exit=0`，
  `/tmp/genoffice-archive-mysql-full.log`）；不带 MySQL 的串行全量 241 项通过 /
  45 项可选 MySQL 跳过 / 0 失败（`exit=0`，`/tmp/genoffice-archive-local-full.log`）。
  类型检查、改动文件 ESLint、`git diff --check` 通过。测试库全部删除，专用 MySQL 正常退出并清理目录。

高水位归档与目录最终清理解决的是「旧代次无限堆积」和「目录行永久钉住原文件」；
软水位回收的跨进程一致性、压力下主动回收可重建产物、备份清单与恢复演练、解析中增量首屏、
最后一个等待者取消、Android 版本目录/整包配额以及目标硬件压测仍未完成，整体目标保持未完成。
本节由后续「Android 断点续传与真机验收」检查点部分取代。


### Android 断点续传与真机验收（2026-11-09）

- 新增 `BundleResume`：应用私有 `bundles/<fileId>.resume/` 保存跨下载运行的部分文件与
  身份记录（path/size/sha256/artifactKey）；四者与当前权威清单完全一致才复用，按最老优先
  裁剪、上限 512 MiB，发布成功后清空。staging「失败即整体清理」的既有语义不变。
- `BundleDownloader` 在权威清单路径改用 `If-Range: "<sha256>"` + `Range: bytes=<offset>-`：
  `206` 要求 ETag 与清单一致、`Content-Range` 精确为 `bytes <offset>-<size-1>/<size>` 且
  Content-Length 等于剩余字节；`200` 丢弃部分文件从头下；`416` 仅在 `bytes */<size>` 且已收满
  时视为完成；其余失败闭合。摘要覆盖已有前缀加新字节，最终仍校验完整文件 SHA-256。
  兼容旧服务端（无清单）与模型/字体旧流程保持 staging `.tmp`，不续传；整包空间预检仍按
  清单总量执行，续传节省传输量与时间，不降低首次空间要求。
- 服务端既有约束由真机联调确认：`openFilePart` 只对 STORE ZIP part 返回 `206`，DEFLATE 媒体
  经 inflate 流式返回、Range 回退整包 `200`；客户端按 `200` 规则重下，不拼接错误字节。
  首次探针只统计「是否发出 Range」，会漏判这一退化；收紧为统计通过严格校验的 `206` 响应后
  才暴露该约束，探针现已同时覆盖两条路径。
- 华为 AGS5-W00 真机（Android 12 / API 31 / arm64-v8a，77 GiB 可用）验证：改前基线
  `BundleDownloaderTest` 19 项 / 32.5 秒通过；改后新增 5 项共 **24 项 / 26.7 秒通过**；
  `test:android-backend` 真实解析服务端联调返回 `ok / sourceHashesVerified /
  cachedSecondDownload / realBackendRangeResume`，`sourceParses=1`，instrumentation 报告
  `resumeVerified=true / rangeResponses=1 / resumedPrefixBytes=163840`，服务端日志对 STORE
  媒体记录 `206`、对 DEFLATE 媒体记录 `200`。viewer typecheck 通过、66 项单测通过，
  脚本 ESLint 与 `git diff --check` 通过。Gradle 需用 JDK 17（默认 GraalVM 21 的 jlink
  会令 AGP 8.10.1 的 `androidJdkImage` 变换失败）。
- 日志：`/tmp/genoffice-android-realdevice-baseline.log`、
  `/tmp/genoffice-android-resume-realdevice-final.log`、
  `/tmp/genoffice-android-realdevice-backend-final.log`。真机验证的是 PPTX 离线链路，
  不代表真机容量、弱网、长时稳定性或 Android 其它格式闭环；版本目录、整包缓存配额与
  清理入口、部分离线提示由下一检查点取代，整体方案保持未完成。


### Android 版本目录、缓存配额、清理入口与部分离线标记（2026-11-09）

- **版本目录与当前包引用**：新增 `BundleCache`。现代清单的包发布到
  `files/bundle-cache/<fileId>/versions/<artifactKey>/`，`current.json` 以临时文件 +
  rename 原子写入，记录 fileId/artifactKey/offlineScope/externalCount/sizeBytes/publishedAt。
  `commit` 只在目录路径与清单 identity、scope、resources 完全一致且封印存在时登记指针，
  不重复哈希大媒体；`resolve` 严格校验指针，损坏时返回明确不可用的目录而不静默降级旧代。
  旧 `files/bundles/<fileId>/` flat 包继续按原布局读取，无权威清单的旧服务端仍写 flat
  且不更新指针。更新失败保留旧指针与旧版本目录。
- **整包配额**：默认 2 GiB，可构造注入。单包超过配额在下载资源前拒绝；发布成功后按最老优先
  回收非当前版本、staging、resume 与中断备份，当前版本和旧 flat 包永不自动删除；符号链接
  不递归、不计字节。设置页显示缓存大小/历史版本数，新增「清理离线缓存（保留当前包）」按钮，
  下载中不可触发。`BundleResume.at` 让续传部分文件也归入配额统计。
- **部分离线**：含外部媒体不再直接拒绝，本地声明资源仍逐文件校验并发布；manifest 写入
  `offlineScope=partial` 与 `externalResources`，`BundleStore.validate` 要求 scope 与外链数量
  一致，不能伪装完整离线。设置页、下载完成提示与打开离线包时都明确说明外链需联网；
  在线回源取未缓存资源仍未实现。
- **下载流程接线**：`BundleDownloader` 拆为「先取并完整校验权威清单 → 按 artifactKey 选
  版本目标与独立 staging/resume → 下载 → seal → publish → commit → trim」，失败时只清理
  staging，不触碰已发布包；修复 intent 传入 fileId 后状态仍按旧偏好显示的 UI 缺陷。
- 新增 9 项 instrumentation 用例：两代共存与指针切换、更新失败保留旧指针、配额回收只删
  非当前版本、清理入口删除 staging/resume/备份但保留当前、超配额下载前拒绝、部分离线
  指针与完成文案、损坏指针与不匹配 commit 不激活、旧 flat 包兼容、真实 Activity 清理按钮。
  Fixture 支持可变 artifactKey 与 fileId。
- 验证：华为 AGS5-W00 真机全套 **33 项 / 27.3 秒通过**（日志
  `/tmp/genoffice-android-versioned-cache-tests.log`）；首次运行暴露版本父目录未创建导致
  `renameTo` 失败（6 项错误），补齐 `mkdirs` 后复跑通过；UI 用例暴露 intent 状态未刷新，
  修正后复跑通过。`test:android-backend` 真实解析服务端联调通过，
  `versionedCache=true / cleanupBytes=4096 / cacheBytes=962057 / resumeVerified=true /
  rangeResponses=1 / sourceParses=1`（`/tmp/genoffice-android-versioned-backend-final.log`）。
  viewer typecheck、脚本 ESLint、`git diff --check` 通过。
- 边界：Android 本地没有读租约，回收旧版本时正在回放的旧包需重新打开；配额是应用私有
  字节预算，不是跨应用磁盘预留；在线回源、真机容量/弱网/长时稳定性、PDF/DOCX 移动闭环
  仍未完成。服务端软水位跨进程一致性、压力下主动撤下 ready、解析中增量首屏及目标环境
  压测继续保留；备份恢复演练由下一检查点取代，整体方案保持未完成。


### 一致备份清单与恢复演练（2026-11-09）

- **清单**：新增 `src/backup-manifest.ts`。在 `START TRANSACTION WITH CONSISTENT SNAPSHOT`
  内读取持久目录行（`parse_files` / `library_entries` / `parse_artifacts` 含 ready 指针与
  identity 派生 key / jobs / retirements / flat archives / 高水位墓碑 / pending sessions 的
  源文件引用），事务保持打开时逐文件流式哈希 `files/`、源索引、历史索引与所有规范
  `g-N` 的 `manifest.json`/`units.bin`；随后用**独立连接**复核关键行（同一快照事务内重读
  看不到并发提交），变化即拒绝产出清单并要求重试。清单以 `canonicalJson` + SHA-256 封印，
  不含会话、读租约、共享预留、staging 与 scratch 等临时态。file 模式用 `meta/*.json` +
  `library.json` 作为等价索引。
- **恢复演练**：`verifyRestore` 校验清单自身结构与摘要，重读活动目录行做依赖对账
  （源索引、保存历史、引用、目录行/高水位不倒退、墓碑不丢失、派生明细父行、identity）；
  交叉核对「目录行 ↔ 文件清单」，catalogued source 必须确有源字节与索引且哈希一致，
  避免一个本就不一致的系统被备份成「通过」的清单；逐文件校验 size/SHA-256，原文件与索引
  失败为硬错误，generation 文件失败只记为可重建告警。每个活动 ready 指针都经
  `ArtifactGenerations.open` 校验路径、manifest SHA、字节与 unitCount，`--deep` 再逐帧
  gunzip/sha256（可发现「清单是在帧损坏后生成」的全文件哈希盲点）。不合格指针由
  `invalidateReady` 按确切代次撤下，撤下后再读目录确认同代次未被并发重新广告；
  只读演练或撤下失败即 `ok=false / readyAllowed=false`，未通过检查的结果不得宣称 ready。
  恢复后新增的文件与新产物记为告警，后者现场哈希并比对注册摘要。
- **接线**：`createParseServer` 增加 `restoreCheck`，在监听端口前用短连接池执行演练，
  硬失败拒绝启动，已撤下的可重建产物按正常链路重建；`/v1/health` 暴露 `restore`
  （ok/readyAllowed/digest/counts/blockedReady/errors/warnings）。新增
  `scripts/backup-check.mts` 与 `npm run backup:check`，提供 `snapshot` / `verify`
  运维子命令（`--deep`、`--no-invalidate`），`verify` 未通过返回非零退出码。
- 验证：组件测试 `backup-manifest.test.ts` **17 项通过**（含并发拒绝、清单篡改、源/索引
  缺失与同长度篡改、目录行↔文件清单交叉校验、可重建产物告警、注入 catalog 快照下的
  撤下/只读失败闭合/并发清空/撤下后被重新广告、深校验帧损坏、依赖与墓碑丢失）；
  真实 MySQL `backup-manifest-mysql.test.ts` **6 项通过**（一致清单 + 启动门禁 health、
  撤下坏 ready 后 v2 重建到 g-2 并读 unit、源丢失拒绝启动、并发写入者使快照失败、
  墓碑丢失与摘要篡改、深校验撤下真实 SQL ready）。CLI 在临时 file 模式目录实测
  `snapshot`→`verify` 均返回 ok/readyAllowed=true。带隔离真实 MySQL 的**串行全量
  309 项 / 45 文件通过、无跳过**（`/tmp/genoffice-backup-mysql-full-final.log`）；
  不带 MySQL 的串行全量 **258 项通过 / 51 项可选 MySQL 跳过 / 0 失败**
  （`/tmp/genoffice-backup-local-full-final.log`）。类型检查、改动文件 ESLint 与
  `git diff --check` 通过。
- 边界：演练校验的是同一 dataDir 上的还原结果，不自动复制/上传备份，也不覆盖跨机器恢复、
  备份介质、调度与保留策略；清单生成需要短暂的目录行静默窗口，构建/上传并发变化会要求重试。
  损坏 generation 的更广泛故障注入与并发修复压测仍未完成。整体方案保持未完成。

### 压力下主动撤下 ready 并回收可重建产物（2026-11-09）

- **两阶段压力路径**：`reclaimArtifacts` 位于 `StorageBudget` 的 `reclaim` 回调中，运行在共享
  `GET_LOCK` 内。它只做两件事：`readyEviction.request(bytes)`（纯内存，取最大值合并并发压力
  信号，绝不触 SQL）与 `generationCollection.request(true)`（只调度后台）。所有撤下/退役/删盘
  SQL 都由后台 `ArtifactGenerationSweeper.sweep` 在锁外执行，沿用「flat 授权不在准入锁内」
  的既有取舍；`sweep` 结果新增 `readyWithdrawn / readyCollected / readyBytes`。
- **候选与围栏**：`MysqlArtifactCatalog.listReadyEvictionCandidates` 用 DB 时钟按
  `last_access_at` 升序枚举 `ready_generation IS NOT NULL` 的行，SQL 内排除活跃读租约、有效
  building 租约并确认 `parse_files` 行存在；`readyEvictionIdleMs` 默认 60 秒保护刚访问的产物，
  `readyEvictionBatchSize` 默认 16 限定单轮。`ArtifactReadyEviction.run` 再用
  `ContentStore.pathOf` 证明源字节仍在（可重建），才调用新增的 `withdrawReady`：事务内
  `SELECT ... FOR UPDATE`、逐字段 compare-and-clear（generation/storagePath/manifestSha/
  bytes/unitCount），锁序 artifact→job→readers，重复围栏活跃构建与任意活跃读租约；成功则置
  `state='reclaimed' / error_code='artifact_reclaimed'`，清空 ready 指针但**保留 generation
  高水位**，不污染 job、不删原文件、不触碰历史库。随后复用
  `ArtifactGenerations.collect` 的不可逆 `retireGeneration` 授权删除 `g-N` 目录，只有删盘成功
  才把字节计入已回收并递减待回收目标；退役被拒时只留孤儿目录给后续扫描。
- **接线与观测**：`createParseServer` 装配 `ArtifactReadyEviction` 并注入 sweeper；
  `/v1/health` 新增 `readyEviction`（pendingBytes/rounds/累计撤下与字节/lastResult）；
  新增 `readyEvictionIdleMs`、`readyEvictionBatchSize` 两个 options 与
  `PARSE_SERVER_READY_EVICTION_*` 环境变量，纳入 `validateRuntimeOptions`；关闭时先 `close()`
  停止接收新压力目标。撤下后 `claim` 因 `ready_generation IS NULL` 必然返回 `acquired`，
  generation 从高水位 +1 重建，历史记录继续显示原文件仍在。
- 验证：组件测试 `artifact-ready-eviction.test.ts` **14 项通过**（`request` 不触任何 SQL、
  无压力不扫描、LRU 与达标即停、源缺失/并发撤下失败/退役失败保护与待回收目标保留、
  逐候选异常隔离、并发 run 合并、hasMore 只在满批有进展时、close、非法参数、
  撤下结果并入 sweep 报告与异常不中断扫描）；真实 MySQL
  `artifact-ready-eviction-mysql.test.ts` **6 项通过**（撤下+删盘+退休行+原文件/目录行保留+
  g-2 重建、读租约与 idle 窗口与陈旧指针拒绝、building 围栏、两个独立连接池并发只撤一次、
  源字节消失不撤、真实高水位 GC → 后台撤下 → 再次打开 v1 会话重建并读 unit）。
  端到端用例插入 600 MiB 稀疏源字节并把水位设为 2%/1%，通过 `server.gc()` 触发真实压力回调。
  串行全量：带隔离真实 MySQL **47 文件 / 329 项通过、无跳过**
  （`/tmp/genoffice-ready-eviction-mysql-full.log`）；不带 MySQL
  **272 通过 / 57 项可选跳过 / 0 失败**（`/tmp/genoffice-ready-eviction-local-full.log`）。
  typecheck、改动文件 ESLint、`git diff --check` 通过。
- 边界：本检查点的压力目标仍是**进程内**状态（该限制已由后续「跨实例共享压力目标」检查点解决），
  当时多实例可能重复扫描或超额回收，但共享 SQL 目录行 +
  compare-and-clear + 不可逆退役保证并发正确性；软压力回收是异步的，硬上限/物理空间不足
  仍在同一轮 fail-closed 返回 507，不因「将来可回收」放行写入；正常容量不撤任何 ready；
  部分离线在线回源、解析中增量首屏的跨节点共享、真实跨机器恢复与目标环境压测仍未完成。
  整体方案保持未完成。

### 解析中的增量首屏（2026-11-09）

- **预览快照**：新增 `src/artifact-preview.ts`。`PreviewRegistry` 只在**构建进程内存**里保存
  有界快照（默认每 key 8 个单元 / 2 MiB、最多 16 个 key、60 秒 TTL），按 artifactKey 索引。
  每条记录必须来自 `ArtifactWriter.append` 已提交的 canonical（无部署 origin、无签名）帧，
  且严格按 `index === unitsProduced` 顺序推进；`get()` 返回深拷贝，消费方无法修改已发布单元。
  `done` 只表示所有帧写完（manifest 尚未发布），`failed` 立即丢弃快照。观察者挂在父进程
  `ArtifactStore.previewObserver` 上，**不进入 `ArtifactSessionInput`**：输入会被结构化克隆到
  独立解析子进程，函数无法跨 IPC（本轮实测发现并修正了 `could not be cloned`）。
- **HTTP 契约**：`GET /v2/sessions/:id` 在 building 时新增 `previewable / complete:false /
  progress(unitsProduced,unitCount,percent) / availableUnits`，**state 仍是 building 而非 ready**。
  `GET .../document` 返回 model/fonts/layout 或 styles；`GET .../units?cursor` 只列已提交范围并
  附 `pending{from,to,code:'unit_pending',retryAfterMs,pollAfterMs}`；`GET .../units/:unitId`
  已提交单元返回 200（按响应时重写部署 URL/签名），未提交单元返回 **202 `unit_pending` +
  Retry-After**，非法 id 400。无预览快照时保持既有 409 `session_not_ready`；bundle 在 building
  期间仍 409，`complete:false` 明确不能用于离线完成判定。capabilities 增
  `features.incrementalPreview`，`/v1/health.maintenance.incrementalPreview` 暴露快照统计。
  配置 `previewMaxUnits`（默认 8）/`previewTtlMs`（默认 60 s）与
  `PARSE_SERVER_PREVIEW_MAX_UNITS` / `PARSE_SERVER_PREVIEW_TTL_MS` 纳入启动校验。
- **Web**：`openServerSession` 识别 `previewable`（仍轮询到 ready，只通知一次 `onPreview`），
  等待状态新增「解析中，首屏已可预览…」；`createRemotePptxSession` 在 building 期间预取
  `document` + `units/0` 并经 `onPreviewFrame` 交出只含首屏的 `preview` deck（其余页为
  **非 placeholder 空白页**，避免懒加载请求未产出单元）；`slides.tsx` 提前显示该 deck 并提示
  「仅首屏已可预览」，用 `openedDeck` 防止迟到的预览覆盖完整 deck。预览单元**不写入** v1
  `fetchUnit` 缓存，ready 路径保持原有渲染契约。
- 验证：组件/HTTP 测试 `tests/artifact-incremental-preview.test.ts` **11 项通过**（真实 3 页 PPTX、
  gate 在第二个单元帧之前，覆盖 previewable 状态、document/列表/pending 范围、已提交单元与
  ready 后字节一致、构建失败立即撤预览且绝不宣称 ready、缓存命中无预览、配置校验）；
  真实隔离 MySQL catalog `artifact-preview-mysql.test.ts` **2 项通过**（building 期间
  `parse_artifacts.ready_generation IS NULL`、`parse_jobs.state='building'/progress=0`，
  释放后 g-1 ready 且 `units/2` 可读；失败构建不留 ready 指针/预览/残缺单元）。
  viewer `node:test` **69 项通过**（新增 previewable 轮询、首屏预取与失败降级；测试中抓到并
  修正了预取 URL 重复拼接 base 的真实缺陷）。串行全量回归：带隔离真实 MySQL
  **49 文件 / 342 项全通过、无跳过**（`/tmp/genoffice-preview-mysql-full-final.log`）；
  不带 MySQL **41 文件通过 / 8 文件跳过、283 项通过 / 59 项可选跳过 / 0 失败**
  （`/tmp/genoffice-preview-local-full-final.log`）。parse-server 与 viewer typecheck、
  改动文件 ESLint、`git diff --check` 均通过。
- 边界：预览是**构建进程内**内存状态，多实例部署下只有持有构建租约的节点能提供预览，
  跨节点任务状态映射仍未实施；快照不持久化，进程重启即消失（完整产物仍从 generation 读）。
  Web 首屏预览未经 `measureWidths`，字体度量在 ready 后才完全校正；DOCX 首屏与 `layout`
  服务端排版路径仍沿用既有 ready 后加载，在线回源、部分离线闭环与目标环境压测仍未完成。
  整体方案保持未完成。

### 跨实例共享压力目标（2026-11-09）

- **新增 `src/storage-pressure.ts`**：`SqlPressureLedger` 用单行 SQL 表
  `parse_storage_pressure(scope, round, target_bytes, reclaimed_bytes, expires_at_ms,
  updated_at_ms)` 表示整个实例群的一轮压力回收预算（scope 取数据库名摘要，互不串账）。
  `register()` 在短事务内先做 no-op upsert 保证行存在，再 `SELECT ... FOR UPDATE`：
  多实例并发登记用 `MAX` 合并（各实例算的是同一全局水位差，累加会放大 N 倍），过期则递增
  `round` 并重置计数，旧 round 的迟到 charge 一律作废。`reserve()` 是一条条件
  `UPDATE ... WHERE round=? AND expires_at_ms>now AND reclaimed_bytes+? <= target_bytes`，
  按候选逐笔原子预扣；`refund()` 在删盘失败时归还；`state()` 供 health 只读查看。
  轮次满足后 `reserve` 把过期时间缩短到 cooldown，持续压力无需等满 TTL 即可重新评估。
- **两阶段约束保持**：`request()` 仍在共享准入 `GET_LOCK` 内且零 SQL；登记、预扣、归还
  与所有 catalog 撤下/退役/删盘 SQL 都只在后台 sweeper 锁外执行。逐笔预扣使
  `SUM(已回收) <= MAX(目标)` 全局成立，不需要 claim 行、租约、心跳或启动对账：
  进程崩溃只会留下「多算、少回收」，绝不会少算导致超发。候选大于剩余共享额度时跳过而非
  中断整轮扫描；账本读取失败时 **fail-closed**（不回退到进程内无界回收），硬上限仍同轮 507。
- **接线与观测**：`createParseServer` 在有 MySQL 时装配并 `init()` 账本；`ArtifactReadyEviction`
  新增可选 `ledger`，结果增 `shared{round,targetBytes,reclaimedBytes}` 与 `sharedExhausted`，
  共享额度耗尽时清空本地 hint 且 `hasMore=false`。`/v1/health` 新增 `sharedPressure`。
  配置 `pressureRoundMs`（默认 5 分钟）/`pressureCooldownMs`（默认 30 秒）与
  `PARSE_SERVER_PRESSURE_ROUND_MS` / `PARSE_SERVER_PRESSURE_COOLDOWN_MS` 纳入启动校验
  （cooldown 不得大于 round）。
- 验证：组件测试 `tests/storage-pressure.test.ts` **12 项通过**（MAX 合并、并发原子预扣
  不超额、refund 与旧/过期 round 拒绝、满足后短冷却过期、双实例竞态只按全局目标撤一次、
  大目标分工不超额、账本失败闭合、逐笔归还、满足后停止扫描、无账本保留原行为、配置校验）；
  隔离真实 MySQL `tests/storage-pressure-mysql.test.ts` **4 项通过**（两个独立连接池
  MAX 合并/并发领取/归还/冷却轮转，以及**3 个真实 generation + 两个实例端到端**：
  目标只够一个代次时全局只撤一次，`/v1/health.sharedPressure` 与账本一致）。
  压力相关定向回归 6 文件 / **47 项通过**（含既有 600 MiB 稀疏源高水位 GC → 撤下 →
  重新打开重建并读 unit）。串行全量回归：带隔离真实 MySQL **51 文件 / 358 项全通过、
  无跳过**（`/tmp/genoffice-pressure-mysql-final2.log`）；不带 MySQL **42 文件通过 /
  9 文件跳过、295 项通过 / 63 项可选跳过 / 0 失败**
  （`/tmp/genoffice-pressure-local-final2.log`）。typecheck、改动文件 ESLint、
  `git diff --check` 通过。期间把既有 `artifact-preview.test.ts` 损坏修复用例的
  2 秒轮询上限放宽到 10 秒（有界），避免高负载机器上把「仍在 building」误判为失败；
  单独与全量复跑均通过，非本检查点语义改动。
- 边界：软压力 30 秒退避仍是各实例进程内抖动（MAX 合并后不影响全局总量）；
  flat 冗余字节仍只由 GC 报告并催促后台扫描，不在准入锁内做 SQL 授权；预扣按目录行
  `bytes` 记账，与磁盘实际释放字节可能有小幅差异；账本是单实例群共享预算，不是跨机房
  配额协同。跨节点任务状态映射与预览快照共享、最后一个等待者取消、解析产物跨机器恢复、
  复杂 PPTX/DOCX round-trip 与目标环境压测仍未完成。整体方案保持未完成。


### 可选 Redis 热缓存 P3.5 最小实现（2026-11-10）

- **范围**：只做方案 5.1 允许的两条通道——跨实例**预览帧**与**构建进度投影**；默认 `cacheMode: 'memory'`，未配置 Redis 时不创建客户端、不发起任何命令。`redis` 模式要求 MySQL + `artifactBackend: 'catalog'`（共享 `parse_jobs` 行是另一个实例定位 jobId 的前提）。ready 指针、generation、构建/读取/下载租约、配额与压力账本、原文件/产物索引仍只在 MySQL 与磁盘，缓存只提供"否定"证据。
- **契约与实现**：新增 `cache-contract.ts`（键命名 `genoffice:{dbScope}:pv:{artifactKey}:{jobId}` / `job:{jobId}`、TTL、256 KiB 单字段上限、统计结构）、`redis-cache-client.ts`（最小 RESP2 客户端：socket/TCP/TLS、可选 ACL 用户名/密码与 SELECT、命令预算默认 80 ms 且整条请求路径只尝试一次不重试、连续 3 次失败熔断 5 s 后单次半开探测、懒连接、超时销毁连接）、`hot-cache.ts`（本地 `PreviewRegistry` 始终优先；document/unit 仅在帧已提交且本地实际保留时 best-effort 镜像；document 超 256 KiB 则整次构建不提供跨节点首屏，单 unit 超限或超出 `previewMaxUnits` 窗口即停止后续镜像、读取端返回 pending；进度按进程全局 200 ms 节流合并写入，`done` 强制末次，`failed` 立即删除 pv 与 job 两个 key；读路径严格校验 format/document/unitCount/unitsProduced/count/unit:i，坏值、超时、熔断、连接失败一律视为 miss 并只计数）。
- **接线**：构建 `jobId` 由 catalog lease 经 `ArtifactCoordinator.buildOwned` → `ArtifactSession.build` → `previewObserver(key, event, jobId)` 传入；v2 pending 响应本地预览优先，miss 时用新增的 `MysqlArtifactCatalog.activeJob(artifactKey)`（SQL 时钟校验 building 租约）定位共享 job 再读投影，`progress` 在无本地预览时给出投影值；`/v1/health.cache`（mode/enabled/hits/misses/hitRate/errors/timeouts/breaker/lastErrorAt/latency）与 `genoffice_cache_*`（hit/miss/error/timeout/hit_rate/latency histogram/breaker）已暴露；`PARSE_SERVER_CACHE_MODE`、`REDIS_*`、超时/熔断/TTL/节流/字段上限均已纳入启动校验，README 增加配置与边界说明。
- **验证**：新增 `cache-contract.test.ts` 5 项、`hot-cache.test.ts` 20 项、`redis-cache-client.test.ts` 23 项（含真实 Redis socket 用例）、`cache-mode.test.ts` 3 项、`cache-redis-mysql.test.ts` 3 项。真实 MySQL 9.7.1 + Redis 8.8 联合用例覆盖：①A 实例真实构建暂停在 `unit:1` 之前，B 实例读到首屏 `previewable`、`progress 1/2`、`units/0` 200、`units/1` 202，释放后由 catalog 正常 ready；②外部持有构建租约时跨实例读帧与进度；③删除/清空缓存后会话仍 200 且不伪装 ready；④Redis socket 不可达时仅降级（正常 pending→ready、errors>0、无 5xx）。默认全量 46 文件通过 / 10 跳过、**345 项通过 / 67 跳过**（共 412）；带真实 MySQL+Redis 的**串行全量 56 文件 / 412 项全部通过、无跳过**（69.6 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：单 Redis 实例、无 Sentinel/Cluster，主从切换未演练；SLO（命中率 ≥80%、附加 p95 ≤5 ms、错误率 ≤0.1%）只暴露指标，尚未在目标负载下实测；`maxmemory`/TLS/ACL 为部署配置，未做容量演练；跨节点**会话日志**仍是单实例（读者需已知 session 才能附着）；响应缓存、会话状态投影与分布式限流按方案仍"待评估"，未实现。整体方案保持未完成。


### v2 契约补齐与部署开关（2026-11-10）

- **部署开关可编程化**：新增 `deployment-options.ts`，`bin.ts` 按启动前严格解析 `PARSE_SERVER_ARTIFACT_BACKEND=local|catalog`、`PARSE_SERVER_STORAGE_ADMISSION=instance|shared` 与恢复门禁 `PARSE_SERVER_RESTORE_MANIFEST`/`_DEEP`/`_READ_ONLY`/`_INVALIDATE`。未知枚举、恢复开关缺 manifest 路径、manifest 缺失/损坏都在创建任何服务资源前失败；read-only 优先于 invalidate；不设置 backend 时仍保持 local 代码默认。catalog 主链路因此可只靠环境变量启用。
- **v2 端点补齐**：`POST /v2/sessions/:id/heartbeat` 只续期轻量阅读会话（200 `state`/`pollAfterMs`，未知 id 404），不触碰构建租约/ready 指针；`GET /v2/sessions/:id` 的 ready 响应新增 `artifactKey`、终态 `progress`、`pollAfterMs: 0`、`complete: true`（v1 body 保持不变）；`GET /v2/sessions/:id/bundle-manifest` 成为 `/bundle` 的正式别名（别名不提供子资源）。同一 artifact 已有 catalog 构建时，新 waiter 通过 `catalog.activeJob` 复用该 jobId，使 v2 `jobId` 与 Redis 进度投影一致。
- **Idempotency-Key**：`POST /v2/sessions` 支持 8–128 字符键；`idempotency.ts` 提供有界进程内缓存（TTL 默认 10 min、256 条、最老淘汰、只缓存 2xx JSON ≤64 KiB、拒绝 CRLF/重复 header/非法字符）。重放返回同一 `sessionId` 的当前状态（201 ready 或 202 building），不会新建 durable waiter；非法键 400；/v1/health 暴露 `idempotency` 统计。文件上传按内容寻址、`/v2/library` 按唯一文件引用天然去重。边界：单进程内存，重启/其他实例会重新执行，并发同键不合并。
- **验证**：新增 `deployment-options.test.ts` 13 项、`idempotency.test.ts` 16 项、`v2-contract.test.ts` 4 项（ready 字段/v1 不变、heartbeat、bundle 别名、Idempotency-Key 重放与非法键）。默认全量 **49 文件通过 / 10 跳过、378 项通过 / 67 跳过（共 445）**；带真实 MySQL+Redis 串行全量 **59 文件 / 445 项全部通过、无跳过**（79.7 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：catalog 仍未在真实 MySQL 上做「仅环境变量启动」的部署验收；幂等不由共享存储承载；跨节点会话日志、最后等待者取消、SLO/主从切换/容量演练与目标环境压测仍未完成。整体方案保持未完成。


### 跨实例等待会话只读附着与 parse_sessions 列迁移（2026-11-10）

- **跨实例等待会话**：`PendingSessionStore` 新增 `load(id)`，在 MySQL 模式下按 sessionId 从 `parse_pending_sessions` 惰性解析其他实例创建的 waiter，并标记为 remote。v2 会话路由对 remote waiter 只读：返回当前 queued/building 状态、共享预览帧与进度，**不启动本实例的竞争构建、不写失败状态**；heartbeat 只续期共享行；DELETE 只清理本实例缓存、不删除构建方的行。新增真实 MySQL 用例：A 构建暂停、B 实例从未创建该 session 也能按 id 读取 200 状态、health `buildsStarted/sourceParsesStarted` 均为 0、heartbeat 200、DELETE 204 后 A 仍可继续并最终 ready。边界：ready generation 附着仍要求实例持有同一 dataDir（多实例共享本地目录未支持），因此这是状态/首屏视图而非完整会话迁移；所有权接管与最后等待者取消仍未做。
- **parse_sessions 列迁移（方案 §5/§10 先加列）**：MySQL init 幂等新增 `artifact_key`、`expires_at` 两列（information_schema 检查后 ALTER，兼容旧版本建的表）；`SessionRecord` 与文件索引同步这两个字段，v1/v2 ready 会话写入共享 artifactKey 与空闲截止时间，GET/heartbeat 触碰刷新 `expires_at`，v2 ready 响应新增 `expiresAt`。旧的 `base_url`/`model`/`fonts` 列保留，供 v1 完整模型兼容路径，未在本轮移除。真实 MySQL 用例覆盖：旧表结构启动后自动加列、写入值正确、touch 推进截止时间、重启后从 MySQL 恢复且列值一致。
- **部署端到端**：新增 `deployment-e2e.test.ts`（真实子进程 `node --import tsx src/bin.ts`，只给环境变量）：设置 `PARSE_SERVER_ARTIFACT_BACKEND=catalog`+MySQL 后冷启动、上传/解析/读单元、SIGTERM 正常退出；同 dataDir/MySQL 二次启动后原 sessionId ready 且 `buildsStarted/sourceParsesStarted=0`、unit 仍可读；另验证 restore 缺 manifest 与 catalog 缺 MySQL 均在监听前非 0 退出。
- **验证**：新增 `cross-instance-journal-mysql.test.ts` 1 项、`session-record-mysql.test.ts` 1 项、`deployment-e2e.test.ts` 2 项。默认全量 **49 文件通过 / 13 跳过、378 项通过 / 71 跳过（共 449）**；带真实 MySQL+Redis 串行全量 **62 文件 / 449 项全部通过、无跳过**（78.9 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：remote 附着没有租约/所有权，构建实例崩溃后的接管仍靠 TTL 与下一次访问；ready 产物跨节点读取依赖共享目录（当前不支持）；会话仍携带完整 model/fonts；SLO/主从切换/容量演练与目标环境压测仍未完成。整体方案保持未完成。


### 会话轻量化：只引用产物、不再持久化 model/fonts（2026-11-10）

- **记录结构**：`SessionRecord` 新增 `format`，`base_url`/`model`/`fonts` 改为可选 legacy 字段；新记录的持久化内容只有 `id/fileId/width/parserVersion/format/artifactKey/expiresAt/createdAt/lastUsed`。MySQL `parse_sessions` 的旧列在 init 中幂等放宽为 NULL（`ensureNullableColumn`），新记录写 NULL；旧版本写入的行仍可读取作为回退。文件索引模式同样只写轻量字段。
- **读取路径**：新增 `sessionDocument(entry, req, ctx)`，从已发布产物读取 `document` 记录（本地 `ArtifactStore.find` 或 catalog `ArtifactReadHandle` pin，**不启动解析 worker**），惰性缓存到内存 entry；v1 `GET /sessions/:id`、v1 units 列表、v2 `GET /sessions/:id`、幂等重放的 201 响应均改用它。仅在产物缺失/损坏时回退到 `ensureSession`（重开并从源重建）。`openRestoredSession` 不再把 model/fonts/baseUrl 写回记录，只补 `format`/`artifactKey` 与内存 document 缓存。
- **验证**：默认全量 **49 文件通过 / 13 跳过、378 项通过 / 71 跳过（共 449）**；带真实 MySQL+Redis 串行全量 **62 文件 / 449 项全部通过、无跳过**；其中 `tests/session-record-mysql.test.ts` 断言旧表自动加列、新行 `model/fonts/base_url` 为 NULL、v1/v2 仍返回 model/fonts、touch 推进 expiresAt、重启后从 MySQL 恢复；`pptx-session.test.ts` 的重启用例仍验证 `PptxSession.open` 未被调用（读取来自产物）。类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：布局/阅读位置偏好尚未持久化（仍由客户端持有）；旧列保留一个回滚窗口，回滚到旧版本无法恢复新行会话（产物与源仍在，可重建）；ready 产物跨节点读取仍要求共享 dataDir。整体方案保持未完成。


### Web 消费 capabilities 与签名刷新（2026-11-10）

- **能力探测**：新增 `apps/viewer/src/web/capabilities.ts`，请求 `/v2/capabilities`（1.5 s 超时、按 baseUrl 缓存 5 分钟、失败/畸形/404 不缓存并返回 undefined、只保留 boolean feature）。`server-session.ts` 在打开会话前探测：只有服务端显式声明 `features.asyncSessions === false` 时才强制走 v1；`incrementalPreview === false` 时不再上报 previewable 状态与 onPreview 通知；探测缺失/失败保持原有 v2 优先行为（短超时、不阻塞打开）。
- **签名刷新（验收 6 部分）**：新增 `apps/viewer/src/web/signed-url.ts`，解析 part URL 的 `exp`/`sig`，提前 60 s 判定过期、识别部署 origin 变化，并递归扫描 unit/描述中的嵌套引用。DOCX `docx-remote-session` 的随机访问与顺序加载命中带过期签名/旧 origin 的缓存 chunk 时，自动重取该 chunk 描述（服务端每次响应重签）；PPTX `pptx-model-session` 的音视频 mediaRef 同样按需重取 unit。缓存本身不失效，只刷新资源描述。
- **验证**：viewer 全套 **80/80 通过**（新增 `capabilities.test.ts` 8 项、`signed-url.test.ts` 2 项、`server-capabilities.test.ts` 3 项、`docx-signed-refresh.test.ts` 2 项；既有 server-session 用例显式 `skipCapabilities` 保持聚焦）。viewer 类型检查、改动文件 ESLint、`git diff --check` 通过。parse-server 本轮无改动，沿用上一轮默认 449 / 真实 MySQL+Redis 449 全通过结果。
- **边界**：格式阈值仍未由 capabilities 驱动（仍硬编码 32/64 MiB），URL 导入仍未流式计数；PPTX 图片/字体引用与 token 轮换的刷新、真实浏览器 403/换域名端到端验收仍未完成。整体方案保持未完成。


### 观测指标补齐（方案 §11，2026-11-10）

- **新增指标**：`genoffice_parse_unit_read_latency_seconds`（unit/model 读取直方图，含缓存与产物帧，不含排版）、`genoffice_parse_job_queue_age_seconds`（最老等待构建时长，ParseQueue 记录入队时间）、`genoffice_parse_gc_deleted_bytes_total`（源文件 TTL/淘汰字节 + legacy flat + 后台 sweeper 实删字节，含 generation/staging/pressure）、`genoffice_parse_bundle_failure_total`（离线包构建/资源失败）、`genoffice_parse_signature_refresh_total`（DOCX 资源描述在响应时重签次数）、`genoffice_parse_artifact_miss_total` / `_corrupt_total`（产物查找未命中 / 损坏上报），以及 `storage_source_bytes` / `storage_artifact_bytes` / `storage_staging_bytes` 三项拆分（保留既有总览 `storage_bytes`）。
- **实现点**：`telemetry.ts` 增加对应计数/直方图与渲染；`ParseQueue` 增加 `oldestWaitMs`；`ArtifactStore` 增加 `misses`/`corruptions` 统计与 `stagingBytes()`；`ArtifactGenerationSweeper` 在删除前统计候选目录字节并通过 `collectedBytes` 汇报，`ArtifactCollectionService` 增加只读 `onResult` 钩子，server 累计到指标；server 在 unit/layout 读取、bundle 失败、DOCX 重签、源文件 GC 删除处埋点；异步会话失败日志新增 `jobId`。
- **验证**：新增 `observability.test.ts` 3 项（指标存在与计数、GC 实删字节、队列等待时长）。默认全量 **50 文件通过 / 13 跳过、381 通过 / 71 跳过（共 452）**；带真实 MySQL+Redis 串行全量 **63 文件 / 452 项全部通过、无跳过**；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：request 级日志仍只知道 requestId/artifactKey/sessionId，jobId 仅在任务建立后的异步失败日志中；告警规则、仪表盘与灰度仍未实现（P4）。整体方案保持未完成。


### Web 格式策略集中与 URL 流式计数（2026-11-10）

- **格式策略集中**：新增 `apps/viewer/src/web/format-policy.ts`，把原先散落在 `host.tsx` 与 `docs-server.tsx` 的 1 GiB / 32 MiB / 64 MiB 阈值集中为 `FORMAT_POLICY`，并提供 `decideRoute()`：手动 local/server 与 auto 三态、大 DOCX 无服务端时明确报错、PPTX/PDF 保持 64 MiB 阈值；结合 `fetchCapabilities()` 的结果，服务端未声明某格式时不再静默走服务端路径（auto 回退本地、手动 server 明确报错），服务端缺少 capabilities 时保持旧行为。`docs-server.tsx` 的全量渲染上限也改引用同一策略。
- **URL 导入流式计数**：新增 `apps/viewer/src/web/fetch-limited.ts`，`readResponseLimited()` 先检查 `Content-Length` 预检，再用 `ReadableStream` 逐块累计，超过上限立即取消并发 `DownloadLimitError`；host 的 URL 导入改为使用它，不再 `arrayBuffer()` 一次性读全量，未知扩展名文件仍先按 size 校验、再读取用于格式识别。
- **验证**：viewer 全套 **87/87 通过**（新增 `format-policy.test.ts` 3 项、`fetch-limited.test.ts` 4 项）；viewer 类型检查通过，改动文件 ESLint 仅保留既有 `host.tsx` exhaustive-deps warning，`git diff --check` 通过。parse-server 本轮无改动，沿用默认 452 / 真实 MySQL+Redis 452 全通过结果。
- **边界**：手动 server 模式的小 DOCX 本地回退尚未改为显式配置；阈值仍是客户端常量而非服务端下发的配置；URL 导入仍未做文件选择前的提前提示（只在打开时校验）。整体方案保持未完成。


### 缓存故障矩阵与本地 SLO 演练（方案 §5.1，2026-11-10）

- **慢而不死（p99 500 ms）**：新增 `cache-slow-redis.test.ts`，用带 300 ms 回复延迟的 fake RESP 服务驱动真实客户端（60 ms 超时、150 ms 熔断）。三次读超时均以 miss 返回且单次远低于 1 s；统计 `timeouts ≥ 3`、熔断打开后下一次查询在 50 ms 内 fail-fast 且不再产生命令。
- **同刻大量过期与单 key 热读**：新增 `cache-fault-matrix.test.ts`（真实 Redis，`PARSE_TEST_REDIS_SOCKET` 门禁）：24 个共享 1 s TTL 的 key 同时过期后全部按 miss 处理；64 个并发同 key 查询全部返回 miss、无错误且延迟样本完整（热 key 不打爆进程）。
- **本地 SLO 演练**：新增 `scripts/cache-slo-drill.mts` + `npm run cache:slo`。通过正常 observer 路径写入一份 committed 预览、等待镜像落 Redis，再以可配置并发读取，输出 hitRate / p95 桶 / 平均延迟 / 错误率，`--strict` 在未达方案 §5.1 SLO 时非 0 退出并写 `/tmp/genoffice-cache-slo.json`。本机 loopback 800 次采样：**hitRate 1.0、p95 桶 1 ms、平均约 0.002 ms、错误/超时 0、SLO 三项通过**（明确不是目标硬件结论）。
- **验证**：新增测试 2 项全部通过；默认全量沿用上一轮 452，带真实 MySQL+Redis 全量沿用 452；本轮改动仅新增测试/脚本/文档，类型检查通过。
- **边界**：主从切换、Sentinel/Cluster、`maxmemory` 容量演练、连接池耗尽（客户端为单连接串行队列）与目标硬件压测仍未完成；SLO 数字只代表 loopback 单实例。整体方案保持未完成。


### 告警规则、仪表盘与回滚演练（P4，2026-11-10）

- **告警与仪表盘资产**：新增 `apps/parse-server/deploy/observability/`：
  - `alerts.yml`：10 条 Prometheus 告警（错误率、队列等待年龄、解析内存预算、storage_full 507、artifact 损坏、bundle 失败、unit 读 p95、缓存错误率/命中率/熔断），每条带 severity 与 runbook_url，表达式只引用 `/metrics` 实际暴露的 series；
  - `dashboard.json`：14 个面板（请求/错误、队列深度与年龄、内存与 RSS、unit 读 p95、storage 总览与拆分、GC 删除字节、artifact miss、缓存命中率/错误/延迟）；
  - `README.md`：scrape 接入、各告警处置步骤、缓存回滚（切回 `mode=memory`，key 靠 TTL 过期）、catalog→local 回滚顺序（保留 MySQL 引用、先排空、不要用忽略库引用的旧 GC 删除）、恢复门禁，以及与目标环境压测/主从切换的边界。
- **资产校验**：新增 `observability-assets.test.ts` 3 项——告警引用的 metric 必须在 `telemetry.ts` 中存在、每个告警块必须有 severity/runbook_url、dashboard 是合法 JSON 且面板引用的 metric 均已知、runbook 包含缓存/后端回滚与恢复门禁关键词。
- **回滚安全演练**：新增 `rollback-mysql.test.ts`（真实 MySQL）：catalog 版本先保存一个历史库文件并解析一个仅会话文件；同一 dataDir 切换到 local 后端且 `contentTtlMs=0` 后执行 GC，**两个原文件都仍可下载**（catalog 引用 + 库标记保护），历史库条目仍在，catalog 产生的 generation 目录未被 local GC 触碰。
- **验证**：默认全量 **52 文件通过 / 15 跳过、385 通过 / 73 跳过（共 458）**；带真实 MySQL+Redis 串行全量 **67 文件 / 458 项全部通过、无跳过**（76.4 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：真实告警路由/on-call 轮值、灰度开关、回滚版本对新 generation 的读取（当前由受保护源重建）、目标实例容量与跨机器恢复仍需部署环境；本地演练不代表生产验收。整体方案保持未完成。


### 分阶段回滚开关：asyncSessionsV2（方案 §10，2026-11-10）

- **开关**：新增 `PARSE_SERVER_ASYNC_SESSIONS_V2=1|0`（`asyncSessionsV2` option，默认 true）。关闭时 `/v2/sessions` 及其子路径返回 404、capabilities 的 `features.asyncSessions=false`，v1 同步接口完全保持可用；现有客户端在 404/405 时回退 v1，因此这是无需数据迁移的第一步回滚。删除会话/产物/文件均不受影响。
- **解析与校验**：`deployment-options.ts` 复用布尔解析（1/0/true/false/yes/no/on/off），未知值启动前失败；`runtime-options` 拒绝非布尔值；`bin.ts` 通过 deployment 选项接线；README 与 P4 runbook 把该开关列为回滚顺序第 0 步（v2→v1 → catalog→local → redis→memory）。
- **验证**：新增 `async-sessions-switch.test.ts` 2 项（关闭后 capabilities/404/v1 全流程；默认开启 + 非布尔拒绝），`deployment-options.test.ts` 扩到 14 项（含 env 解析）；默认全量 **53 文件通过 / 15 跳过、388 通过 / 73 跳过（共 461）**，带真实 MySQL+Redis 串行全量 **68 文件 / 461 项全部通过、无跳过**（76.0 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：`processWorkers` 开关未保留（迁移后始终使用独立子进程，旧 worker_threads 入口已移除并在文档说明）；灰度开关只提供进程级启停，不是按租户/流量比例灰度。整体方案保持未完成。


### §5 表结构收尾：历史库软删除与原件状态列（2026-11-10）

- **library_entries**：新增幂等迁移列 `library_scope`（instance）、`retention`（saved）、`deleted_at`；保存写入三者。移除历史改为软删除：保留墓碑行（审计/备份对账）但清空 `file_id`，因此不再占用外键、源文件恢复临时 TTL 回收策略，列表与 `hasFile` 均过滤墓碑；启动时清理超过 30 天的墓碑；重复保存同一文件生成新的活跃行。文件模式 `library.json` 采用相同 deletedAt 语义（保留 fileId 仅用于 JSON 审计，查询过滤）。
- **parse_files**：新增幂等迁移列 `storage_state`（默认 stored）与 `verified_at`；上传提交写入 stored 与校验时间，重复上传只推进 `verified_at`（GREATEST）。
- **单调迁移**：以上列由 `MysqlDatabase.init` 的 information_schema 检查 + ALTER 添加，旧库启动即升级；历史行删除时 `file_id` 置 NULL，避免旧外键阻止源 GC。
- **验证**：新增 `schema-columns-mysql.test.ts`（真实 MySQL）：列值写入、软删除隐藏且清空引用、重复保存复活、墓碑 30 天后启动清理；同时修正 `artifact-catalog-mysql.test.ts` 的隐式 `INSERT INTO parse_files VALUES` 为显式列。默认全量 **53 文件 / 388 通过 + 74 跳过（462）**；真实 MySQL+Redis 串行全量 **69 文件 / 462 项全部通过、无跳过**；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：`artifact_dependencies` 表仍缺（依赖以读租约/fork 表达，GC 不是依赖图）；`parse_sessions` 布局/阅读偏好未持久化；软删除墓碑不进入备份清单的活跃行。整体方案保持未完成。


### 产物依赖图：artifact_dependencies（方案 §5，2026-11-10）

- **表**：新增 `parse_artifact_dependencies(artifact_key, dependency_type, dependency_id, created_at)`（主键去重、`(dependency_type, dependency_id)` 索引、对 `parse_artifacts` 外键级联删除），由 `MysqlArtifactDatabase.init` 幂等创建。
- **写入**：`MysqlArtifactCatalog.complete()` 在设置 ready 的同一事务内写入 `file` 依赖（从目录行的 `file_id` 派生），因此不会出现「ready 已发布但没有来源依赖」；离线包在 `ArtifactSession.openSharedBundle` 发布并 pin 成功后额外写 `artifact` 依赖指向被哈希的模型代次。`recordDependency` 幂等（INSERT IGNORE），重复记录返回 false。
- **读取/GC**：新增 `dependenciesOf()` 与 `hasDependencyOnFile()`；服务端 `fileInUse` 在原有 `hasFileReference` 之外再查依赖图，作为源文件 GC 的额外保守保护。依赖行随目录行归档删除级联清理，不会永久钉住原文件。
- **验证**：新增 `artifact-dependencies-mysql.test.ts`（真实 MySQL）：complete 写入 file 依赖、bundle→model artifact 依赖、重复记录幂等、删除目录行级联清理、非法 key 拒绝；离线包 HTTP 用例新增断言：两件产物各有 file 依赖且 bundle→model 边存在。默认全量 **53 文件 / 388 通过 + 75 跳过（463）**；真实 MySQL+Redis 串行全量 **70 文件 / 463 项全部通过、无跳过**；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：依赖图当前只用于来源保护与审计查询，尚未作为「代次级依赖图 GC」的唯一依据（读取租约/fork 仍负责防止活跃读取被回收）；`artifact_dependencies` 不进入备份清单的活动行集合；`parse_sessions` 布局偏好与其它部署环境验收仍未完成。整体方案保持未完成。


### 会话布局偏好持久化（方案 §4.1/§5，2026-11-10）

- **显式 DTO**：新增 `layout-prefs.ts`：只接受 `zoom`（0.25–4）、`page`（非负整数）、`anchor { unitId(1–64，无换行/NUL), blockIndex?, offsetPx? }`，未知键拒绝，序列化上限 2 KiB；空对象视为未提供。
- **接线**：`POST /v2/sessions` 可选 `layoutPrefs`，非法值 400；偏好随 durable waiter 持久化（`parse_pending_sessions.record`），提升为 ready 时写入 `parse_sessions.layout_prefs`（幂等新增 JSON 列），pending 与 ready 的 `GET /v2/sessions/:id` 均回显；重启后从 MySQL 恢复。v1 body 保持不变，偏好不进入共享模型或产物缓存。
- **验证**：新增 `layout-prefs.test.ts` 2 项（DTO 规范化/拒绝任意 JSON、v2 全流程回显与 v1 不暴露）、`layout-prefs-mysql.test.ts` 1 项（真实 MySQL：`layout_prefs` 列写入、重启后 v2 恢复一致）。默认全量 **54 文件 / 390 通过 + 76 跳过（466）**；真实 MySQL+Redis 串行全量 **72 文件 / 466 项全部通过、无跳过**；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：客户端尚未上报/恢复阅读位置（服务端契约与持久化已就绪）；布局偏好不参与共享产物身份，也不跨会话共享；V2 会话响应只回显本会话的偏好。整体方案保持未完成。


### 启动对账：清理未登记 generation（方案 §5/§10，2026-11-10）

- **模块**：新增 `generation-reconcile.ts`。监听端口前扫描 `artifacts/<prefix>/<key>/g-N` 规范目录：目录年龄超过 1 h（宽限可配置）且该 artifactKey 没有任何 `parse_artifacts` 行（building 或 ready）时，删除该代次目录（force 递归）并在随后清空 key 桶；非规范前缀/key/代次名、符号链接与未知文件一律跳过。
- **保护与失败语义**：任何 catalog 行都会保护其 generation（并发 claim 在建、ready 指针需要字节）；catalog 读取失败 fail-closed（记录打码错误码、保留目录），不把「无法确认」当「无行」。工作有 500 key 上限，超出置 `truncated`；结果写入 `ctx.startupReconcile` 并暴露到 `/v1/health.maintenance.startupReconcile`，有删除时记录 `orphan_generations_reconciled` 日志。
- **接线**：`createParseServer` 在临时/staging/chunk 清扫之后、开始监听之前运行；`MysqlArtifactCatalog.hasArtifactRow()` 提供行存在判断。
- **验证**：新增 `generation-reconcile.test.ts` 3 项（老化无行删除、年轻/有行/未知/符号链接保留、catalog 失败 fail-closed、空 key/prefix 清理、上限与参数校验）与 `generation-reconcile-mysql.test.ts` 1 项（真实 MySQL：building 行保护、孤儿删除、health 字段）。默认全量 **55 文件 / 393 通过 + 77 跳过（470）**；真实 MySQL+Redis 串行全量 **74 文件 / 470 项全部通过、无跳过**；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：失效 ready 指针的自动修复仍由首次访问的 compare-and-clear/后台 repair 负责，`restoreCheck` 是可选的严格启动门禁；1 h 宽限与 500 key 上限是保守默认值，超大目录/跨实例延迟发布需要在部署侧观察 `truncated` 与日志。整体方案保持未完成。


### Web 手动 server 回退显式化（方案 §8.1，2026-11-10）

- **策略**：`format-policy.ts` 新增 `chooseDocxServerRoute({size, allowLocalFallback})`：手动 server 模式默认走远程流式模型；只有显式 `docxLocalFallback=1` 且文件 ≤ `docxServerFullRenderBytes`（64 MiB）时才启用整文件本地保真排版。阈值仍集中在该模块，client 不再在 docs-server 内重复判断。
- **接线**：`DocsServer` 增加 `localFallback` prop（默认 false，不再先下载 metadata/整文件）；`preview.tsx` 读取 `docxLocalFallback`，`host.tsx` 仅在打开 DOCX 时把该参数透传到 preview iframe。v1/本地模式与其它格式行为不变。
- **验证**：`format-policy.test.ts` 扩到 4 项（显式回退才 local-full、大文件仍 remote、非法 size 保守 remote）；viewer 全套 **88/88 通过**；viewer 类型检查通过，ESLint 仅保留既有 `host.tsx` exhaustive-deps warning，`git diff --check` 通过。parse-server 本轮无改动，沿用默认 470 / 真实 MySQL+Redis 470 全通过结果。
- **边界**：阈值仍是客户端的集中常量，尚未由 capabilities/部署配置下发；文件选择前不会提前提示限制（打开时校验）；真实 Chrome 端到端未在本轮复跑（无界面环境）；Android 侧未接入该开关。整体方案保持未完成。


### 阈值由 capabilities 下发与读取前预检（方案 §8.1，2026-11-10）

- **契约**：`@genoffice/parse-contract` 的 `Capabilities` 新增可选 `thresholds { docxAutoRemoteBytes, pptxAutoRemoteBytes, docxFullRenderBytes }`；旧服务端/旧客户端缺省时各自回退到 32/64/64 MiB。
- **服务端**：新增 options/env `docxAutoRemoteBytes`/`pptxAutoRemoteBytes`/`docxFullRenderBytes`（`PARSE_SERVER_DOCX_AUTO_REMOTE_BYTES` 等），启动前校验正整数；`/v2/capabilities.thresholds` 原样下发部署值，默认 32/64/64 MiB。
- **Web**：`capabilities.ts` 解析并按安全规则过滤 thresholds；`format-policy.ts` 的 `thresholdsOf()` 合并 capabilities 与默认值，`decideRoute`/`chooseDocxServerRoute` 全部改用下发值；新增 `precheckLocalFile()`，host 在读取文件前先探测 capabilities 并对「无服务端的大 DOCX / 超大文件」提前提示；DocsServer 的显式本地回退也使用下发阈值。
- **验证**：新增服务端 `capabilities-thresholds.test.ts` 1 项（自定义阈值下发、默认值、非法值拒绝）；viewer `format-policy` 扩到 6 项、`capabilities` 扩到 9 项；viewer 全套 **91/91 通过**，类型检查通过（仅既有 host exhaustive-deps warning）。服务端默认全量 **56 文件 / 394 通过 + 77 跳过（471）**；真实 MySQL+Redis 串行全量 **75 文件 / 471 项全部通过、无跳过**；`git diff --check` 通过。
- **边界**：Android 端尚未消费 thresholds；URL 导入的预检发生在下载后（已知扩展名的本地 File 才在读取前提示）；阈值只能由部署方通过服务端配置改变，客户端仍保留同一份缺省常量用于旧服务端。整体方案保持未完成。


### PPTX 页描述签名刷新（验收 6，2026-11-10）

- **Worker**：`pptx-model-worker.ts` 新增 `refresh` op（丢弃指定页的 source/unit/dependency 缓存），并在 `fetchSource` 命中缓存时用 `needsResourceRefresh(cached,{baseOrigin})` 检测过期签名/旧部署 origin，自动重取该页 layout 描述。
- **会话层**：`pptx-model-session.ts` 在 `loadUnit` 返回前扫描 slide 树与 `mediaRefs`，发现过期 URL 时先 `refresh` 再从服务器重取 unit；`media()` 的过期 mediaRef 路径同样先 refresh。这样已加载页的图片/音视频引用在签名过期后也能继续访问，缓存模型本身不失效。
- **测试**：新增 `pptx-signed-refresh.test.ts`（Worker stub + fetch mock）：初始页含 `exp=1` 图片 URL，`loadUnit` 触发 `refresh` 并返回 `exp=9999999999` 的新描述；viewer 全套 **92/92 通过**，类型检查通过。
- **边界**：嵌入字体走 Authorization 而非媒体签名，token 轮换未处理；真实浏览器 403/换域名端到端验收尚未执行；`resilience-validation.md` 的 12 小时缓存上限仍需发布级验证。整体方案保持未完成。


### 备份清单纳入产物依赖图（P4 备份恢复，2026-11-10）

- **清单**：`BackupCatalogSnapshot` 新增可选 `dependencies`，MySQL 快照读取 `parse_artifact_dependencies` 全表（按 key/type/id 排序）；文件模式为空数组；`critical()` 把依赖纳入并发一致性复核，旧清单缺该字段时按空处理。
- **生成校验**：`assertConsistentCatalog` 在产出清单前拒绝悬空依赖（parent artifact 不存在、file 依赖目标不在源索引、artifact 依赖目标不在产物行）。
- **恢复演练**：`verifyRestore` 同时校验清单内边（parent/目标必须存在于清单）与活动目录（live 依赖 parent/目标必须仍存在；备份后新增的边记 warning），悬空或被删除的边使演练 `ok=false`。
- **验证**：`backup-manifest.test.ts` 扩到 21 项（依赖写入与恢复通过、篡改清单指向缺失字节时拒绝、live 新增边 warning、悬空边在生成清单前拒绝）；新增 `backup-manifest-dependencies-mysql.test.ts`（真实 MySQL：完成模型与离线包后清单包含 `file` 与 `artifact` 边，`verifyRestore` ok）。默认全量 **56 文件 / 398 通过 + 78 跳过（476）**；真实 MySQL+Redis 串行全量 **76 文件 / 476 项全部通过、无跳过**（79.8 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：依赖图仍不参与代次级 GC 的唯一裁决（读租约/fork 负责活跃读取）；备份仍是同一 dataDir 的验证演练，跨机器/介质、调度与保留策略未做。整体方案保持未完成。


### ready 产物跨节点附着（方案 §5，2026-11-10）

- **行为**：两个实例共享同一 `dataDir` + 同一 catalog 时，实例 B 通过 `GET /v2/sessions/:id`、`/units/:id`、heartbeat 懒加载实例 A 创建的 durable ready 会话记录：`SessionStore.load()` 按 id 读取 `parse_sessions`，`attachReadySession()` 只读缓存记录，`ensureSession()` 经 catalog 打开 ready generation 并 pin 源文件。B 不重建模型、不接管 A 的 build lease；`DELETE` 仍由创建实例持有。
- **验证**：新增 `cross-node-ready-mysql.test.ts`（真实 MySQL + 双实例共享 dataDir）：A 构建后 `buildsStarted=1`，B 读到 ready、unit 内容与 A 完全一致且 `buildsStarted=0`；B 请求离线包只新增派生 bundle 构建（`buildsStarted=1`），read lease 正常写入；B 对未知会话仍 404；无共享 dataDir 时读到 404（不返回半可用 503）。默认 **56 文件 / 398 通过 + 79 跳过（477）**；真实 MySQL+Redis 串行 **77 文件 / 477 项全部通过、无跳过**（84.3 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：仍要求共享 `dataDir`/文件系统（对象存储或跨机无共享盘未实现）；ready 所有权转移、跨实例 DELETE/GC 协调、失联实例的 lease 接管未做；懒加载在未知 id 上多一次 DB 查询，未做负缓存。整体方案保持未完成。


### v2 契约按文件灰度开关（P4 灰度，2026-11-10）

- **开关**：新增 `PARSE_SERVER_V2_ROLLOUT_PERCENT=0..100`（`v2RolloutPercent`，默认 100）。`POST /v2/sessions` 用 `parseInt(fileId[0..4],16) % 100` 得到稳定桶：桶值 < 百分比才进入 v2，否则 404 `not_found`，客户端按既有 404/405 回退 v1。
- **性质**：按文件确定性灰度（同一文件永远同一结果，不会中途翻转），0 等价于 v2 路由关闭、100 全量；与 `asyncSessionsV2` 进程级 kill switch 互补，不需要数据迁移，也不影响已存在的会话读取。
- **校验**：`runtime-options` 只接受 0–100 整数，越界/非整数启动前拒绝；`bin.ts` 通过 `PARSE_SERVER_V2_ROLLOUT_PERCENT` 接线；README 与 P4 runbook 把 canary 回滚列为第 0 步的前半段。
- **验证**：新增 `v2-rollout.test.ts` 2 项：0% 全部 404；50% 下 40 个文件按桶值稳定分流（接受者到“缺内容”检查、拒绝者为 canary 文案），两类都出现；100% 正常创建；越界值启动前拒绝。默认 **57 文件 / 400 通过 + 79 跳过（479）**；真实 MySQL+Redis 串行 **78 文件 / 479 项全部通过、无跳过**（85.0 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：按文件而非用户/租户/流量比例，不能对同一文件做部分节点灰度；没有自动放量与观测驱动的暂停，仍是人工改 env + 重启。整体方案保持未完成。


### Web 幻灯片阅读位置恢复（§4.1 客户端，2026-11-10）

- **模块**：新增 `reading-position.ts`：按 `fileId` 在 localStorage 记录 `{page, savedAt}`，30 天有效；校验 fileId 形状、页码非负整数、时间戳合理性，损坏 JSON/过期/越界/存储被禁用或配额不足时静默忽略，绝不阻塞预览。
- **接线**：`Slides` 初始化页码时读取上次位置；deck 加载后对越界页码夹回 0；页码变化即保存。PPTX 在 host/preview 中按打开的文件重新挂载，因此同一 `fileId` 重开即续读；本地/远程模型/流式三种路径共用。
- **验证**：新增 `reading-position.test.ts` 3 项（按文件记忆与清除、损坏/过期/非法值忽略、存储抛错静默）；viewer 全套 **95/95 通过**，类型检查通过；服务端未改动，沿用上一轮默认 479 / 真实 MySQL+Redis 479 结果。
- **边界**：服务端 `layoutPrefs` 尚未由 Web 回传（契约与持久化已就绪）；DOCX 锚点/滚动位置恢复未做；多标签页并发写最后写入者覆盖；localStorage 按 origin 隔离，换域名不会恢复。整体方案保持未完成。


### Web 回传 layoutPrefs（§4.1 客户端→契约，2026-11-10）

- **接线**：`reading-position.ts` 新增 `readingLayoutPrefs(fileId)`（只有存在有效保存位置时返回 `{page}`）；`openServerSession` 的 target 增加可选 `layoutPrefs`，仅在其存在时写入 POST body；PPTX 远程与模型会话创建时自动带上该偏好，服务端已有校验/持久化/回显逻辑直接复用。
- **验证**：`reading-position.test.ts` 增加 `readingLayoutPrefs` 断言；`server-capabilities.test.ts` 新增 1 项，捕获 POST body 必须为 `{fileId, layoutPrefs:{page:4}}`；viewer 全套 **96/96 通过**，类型检查通过。服务端未改动。
- **边界**：只在创建会话时回传，后续翻页/滚动不会持续同步（需要 heartbeat 更新或独立 PATCH 契约）；DOCX 锚点（unitId/blockIndex/offsetPx）尚未上报；服务端只校验不消费该偏好做首屏定位，客户端仍本地恢复。整体方案保持未完成。


### 阅读位置增量同步（§4.1，2026-11-10）

- **服务端**：`POST /v2/sessions/:id/heartbeat` 现在可带可选 `layoutPrefs`（复用有界 DTO 校验）：ready 会话写入 `entry.record.layoutPrefs` 后随 touch 持久化到 `parse_sessions`，本地自有 pending waiter 写入 journal，远程 pending waiter 保持只读；非法值 400。
- **客户端**：`updateSessionLayoutPrefs()` 向 heartbeat POST 偏好；PPTX 远程/模型会话暴露 `updateReadingPosition(page)`，750 ms 节流、失败静默；Slides 在页码变化时调用（本地会话为 no-op）。这样不只是创建时快照，翻页也会持续更新服务端记录。
- **验证**：`layout-prefs.test.ts` 扩展现有流程：ready 后 heartbeat 更新 `{page:5}` 再 GET 回显一致，非法 heartbeat 偏好 400；`server-capabilities.test.ts` 新增 heartbeat 路由/body 断言；viewer 全套 **97/97**，类型检查通过。服务端默认 **57 文件 / 400 通过 + 79 跳过（479）**；真实 MySQL+Redis 串行 **78 文件 / 479 项全部通过、无跳过**（95.5 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：DOCX 锚点仍未上报；pending 远程 waiter 的偏好不更新（避免与 builder journal 竞争）；节流窗口内最后一页可能未落库；服务端仍不消费偏好做首屏定位。整体方案保持未完成。


### DOCX 源锚点阅读位置（§4.1，2026-11-10）

- **存储**：`reading-position.ts` 的 `ReadingPosition` 扩展可选 `anchor {unitId, blockIndex, offset, row?, paragraph?}`，新增 `saveDocxReadingAnchor()`；`readingLayoutPrefs()` 优先回传 `page`，否则把锚点映射为服务端 DTO 的 `{anchor:{unitId, blockIndex, offsetPx}}`；校验单位 ID/块号/偏移/行号，损坏值忽略。
- **客户端**：`DocsRemote` 首次布局时读取保存锚点并用 `restoreDocxAnchor()` 恢复滚动位置（锚点 unit 未加载则本次不跳，避免错误回到顶部）；滚动停止 600 ms 后 `captureDocxAnchor()` 保存源锚点（不是页码，重排后仍稳定）。`docx-remote-session` 创建 v2 会话时带上该 `layoutPrefs.anchor`。
- **验证**：`reading-position.test.ts` 新增 DOCX 锚点存取与 layoutPrefs 映射/非法锚点忽略；viewer 全套 **98/98 通过**，类型检查通过；服务端未改动（既有 DTO 已接受 anchor 字段）。
- **边界**：锚点只在首个窗口的 blocks 内可解析时恢复，跨窗口滚动位置不追、服务端不用偏好做首屏定位；DOCX 会话创建后增量更新未接 heartbeat（仅创建时上报）；`row/paragraph` 仅本地保存未上传。整体方案保持未完成。


### DOCX 跨窗口锚点预取与增量同步（§4.1，2026-11-10）

- **跨窗口恢复**：`DocsRemote` 保存的锚点不在首个窗口时，按现有 `cursor` 继续加载（`prefetching` 防重入、最多 20 个 chunk、文档结束或超限即放弃），锚点 unit 出现后由 `restoreDocxAnchor()` 精确跳转；恢复标记只在真正解析成功或明确放弃后置位，避免错误回到顶部。
- **增量同步**：滚动停止 600 ms 后除本地保存锚点外，还调用 `DocxRemoteSession.setLayoutPrefs()` 经 heartbeat 上报 `{anchor:{unitId, blockIndex, offsetPx}}`（750 ms 节流、失败静默）；session 创建时继续携带保存的锚点。
- **验证**：viewer 全套 **98/98 通过**，类型检查通过；改动文件 ESLint、`git diff --check` 通过；服务端未改动，沿用默认 479 / 真实 MySQL+Redis 479 结果。
- **边界**：20 chunk 上限之外的超长文档会放弃恢复；DOCX 的 `row/paragraph` 仍只本地保存；服务端只持久化偏好，不用它定位首屏；预取会额外读取若干 chunk，弱网下可能增加延迟（有界）。整体方案保持未完成。


### 跨实例 pending waiter 崩溃接管（§5，2026-11-10）

- **行为**：实例 B 读到另一实例 A 的远程 pending waiter 时，若 `parse_jobs` 中该 artifactKey 没有未过期的 building lease（A 已退出/租约释放/过期），且 waiter 的 parserVersion/fingerprint 与本实例一致、无错误，则在下一次 `GET /v2/sessions/:id` 时由 B 调 `startAsyncWork` 接管构建；SQL claim 租约仍保证只有一个构建胜出，A 的迟到发布会被 fence。
- **实现**：`maybeTakeoverPending()` 只在远程 pending + GET + 无本地 flight 时触发，先查 `catalog.activeJob()`，有活跃构建则继续只读；接管后 B 写入 ready 记录并删除共享 waiter，成为新的 owner。
- **验证**：新增 `pending-takeover-mysql.test.ts`（真实 MySQL + 共享 dataDir）：A 构建暂停时 B 只读看到 queued/building 且 `buildsStarted=0`；A 关闭（未发布）后 B 的下一次 GET 接管并构建到 ready，`buildsStarted=1`，unit 可读。默认 **57 文件 / 400 通过 + 80 跳过（480）**；真实 MySQL+Redis 串行 **79 文件 / 480 项全部通过、无跳过**（83.7 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：仅共享 dataDir + catalog 部署；要求 parser 版本/指纹一致（滚动升级混合版本不接管）；无 last-waiter 取消（客户端全关后构建仍会跑完或失败）；对象存储/无共享盘未支持。整体方案保持未完成。


### 关闭阶段硬超时（§6.3，2026-11-10）

- **开关**：新增 `shutdownTimeoutMs` / `PARSE_SERVER_SHUTDOWN_TIMEOUT_MS`（默认 30 s，启动前校验 1–600000 整数）。`close()` 的 parse_queue、coordinator、artifact drain、async flights、HTTP close、GC flights、database close 各阶段都通过 `shutdownDeadline()` 与超时竞速：卡住的 SQL/IO 阶段记录 `shutdown_phase_timeout` 日志后继续，不会无限挂住进程退出。
- **验证**：新增 `shutdown-timeout.test.ts` 2 项：把 `ArtifactStore.drain` mock 成永不 resolve，`shutdownTimeoutMs=150` 时 `close()` 仍在 3 s 内返回；非法超时值启动前拒绝。默认 **58 文件 / 402 通过 + 80 跳过（482）**；真实 MySQL+Redis 串行 **80 文件 / 482 项全部通过、无跳过**（89.6 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：超时后未完成的阶段可能留下临时文件/锁，由下次启动的 staging/孤儿清扫与租约过期兜底；不是强制 kill 子进程的硬实时保证；生产 systemd `TimeoutStopSec` 仍需匹配该值。整体方案保持未完成。


### 跨实例 last-waiter 取消（§6.2，2026-11-10）

- **读者登记**：新增 `parse_pending_readers(session_id, reader_id, expires_at)` 表。实例在创建 pending 会话、远程附着 pending 会话时登记 reader；GET/heartbeat 续期（TTL 120 s），DELETE 移除本实例 reader，登记时顺带清理过期行。
- **取消语义**：DELETE 后若仍有其他活跃 reader，仅 forget 本地视图、保留共享 waiter 与构建；最后一个 reader 离开时删除 pending 行，构建若随后完成则发现 reader 数为 0，直接丢弃而不发布 ready。远程实例缓存的 pending 记录在共享行消失后会失效并回退到 ready 附着或 404。
- **验证**：新增 `last-waiter-cancel-mysql.test.ts`（真实 MySQL + 共享 dataDir）2 项：单读者 DELETE 后 pending 行删除、构建完成不落 ready、GET 404；双实例 A 删除后 B 仍 200、构建继续并在 B 侧 ready、B `buildsStarted=0`。默认 **58 文件 / 402 通过 + 82 跳过（484）**；真实 MySQL+Redis 串行 **81 文件 / 484 项全部通过、无跳过**（93.4 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：reader 是实例级而非标签页级；崩溃 reader 最长 120 s 后才过期；运行中的构建不会中途 abort，只在发布前丢弃（已消耗的解析资源无法回收）；对象存储/无共享盘仍未支持。整体方案保持未完成。


### 500 会话本地轻量基线（§2/§9，2026-11-10）

- **脚本**：新增 `scripts/session-load.mts` / `npm run sessions:load`：启动真实 parse server，上传一个 PPTX 并预热共享产物，再打开 N 个 v2 会话（默认 500，并发 16），轮询到全部 ready，采样 create/status 延迟与进程 RSS，输出 `/tmp/genoffice-session-load.json`。
- **结果**（本机、`--strict` 通过）：500/500 ready、failed 0、`buildsStarted=1`（共享产物未重建）、status p95 0.5 ms、create p95 0.9 s、RSS 128.8 → 231.8 MiB（+103 MiB，约 211 KiB/会话）、serverSessions 501。
- **验证**：脚本 strict 跑通；服务端测试仍为默认 **58 文件 / 402 通过 + 82 跳过（484）**、真实 MySQL+Redis **81 文件 / 484 项全部通过**（本轮未改服务端产品代码）。
- **边界**：本机文件模式（sessions.json 每次落盘使 create 偏慢），不是 8C/16G 目标机、GB 正文或 MySQL 多实例压测；500 会话是同一共享产物，不代表 500 个不同文档的解析负载；status 延迟未覆盖弱网。整体方案保持未完成。


### 产物清单元数据补齐（§4，2026-11-10）

- **字段**：`ArtifactManifest` 新增可选 `unitCount`、`fonts`、`warnings`、`dependencies`，由 `ArtifactWriter.setMetadata()` 在发布前写入并做边界校验（unitCount 非负、font id 非空字符串、warning 字符串、dependency 为 64-hex）；读取时 `validateManifest` 同样校验，旧清单缺字段仍兼容。
- **写入**：模型构建在 dispose 前捕获 `model.unitCount`/`parser.fonts`/`model.warnings` 并写入；离线包的 generation 清单写 `dependencies=[modelKey]`，与 catalog 依赖图一致。
- **验证**：`artifact-store.test.ts` 新增元数据 round-trip 与非法值拒绝（18 项）；新增 `artifact-manifest-metadata.test.ts` 端到端验证真实模型清单含 unitCount=1/fonts/warnings、bundle 清单 dependencies 指向模型 key。默认 **59 文件 / 405 通过 + 82 跳过（487）**；真实 MySQL+Redis 串行 **82 文件 / 487 项全部通过、无跳过**（87.3 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：仍是可选扩展字段，不是独立版本化 DTO；没有 `document.json`/`fonts/` 目录布局；字体清单只存 id 不存字体元数据；warnings 被压成字符串数组（丢失结构化 code/span）。整体方案保持未完成。


### 跨实例/重启 Idempotency-Key 账本（§7，2026-11-10）

- **表**：新增 `parse_idempotency(scope, idempotency_key, body, created_at, expires_at)`，主键 `(scope,key)`、过期索引；`SharedIdempotencyStore` 提供 lookup/claim/complete/remember/release。
- **流程**：内存缓存未命中时查共享账本；已有 body 直接 replay；pending 行进入有界等待（120×25 ms）并 replay 赢家结果。抢到 claim 的请求创建 waiter 后写 body；create 失败则 release。另一实例的 replay 会先尝试 attach ready 或 load pending，不再因本地无缓存返回 404。
- **验证**：新增 `shared-idempotency-mysql.test.ts`（真实 MySQL）：两个实例并发同 key 合并为同一 sessionId；第三实例重试 hit；重启后同 key 仍映射同一 session 且账本 body 落库。默认 **59 文件 / 405 通过 + 83 跳过（488）**；真实 MySQL+Redis 串行 **83 文件 / 488 项全部通过、无跳过**（87.4 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：file 模式仍是进程内缓存；并发等待上限约 3 s，超时后可能重复创建（pending 行未过期时）；账本 TTL 默认 10 min、与内存一致；没有清理定时器（查询时顺带删除过期行）。整体方案保持未完成。


### v2 灰度按租户/用户头分桶（P4，2026-11-10）

- **开关**：新增 `PARSE_SERVER_V2_ROLLOUT_HEADER`（如 `x-tenant-id`，启动前校验小写 header 名）。设置后 `POST /v2/sessions` 用该请求头的 sha256 前 4 位 mod 100 分桶；缺失 header 或未配置时回退到 fileId 分桶。
- **语义**：同一租户/用户始终落在同一桶，可做租户级灰度；0 仍等价关闭、100 全量；与按文件灰度共用百分比。
- **验证**：`v2-rollout.test.ts` 扩到 3 项：60 个租户重复请求结果稳定且两类结果都出现；缺失 header 时与 fileId 桶一致；非法 header 名启动前拒绝。默认 **59 文件 / 406 通过 + 83 跳过（489）**；真实 MySQL+Redis 串行 **83 文件 / 489 项全部通过、无跳过**（88.6 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：只是分桶依据，没有自动放量/观测驱动暂停；header 由前置代理注入才可信，服务端不校验身份；同一租户多用户共享桶。整体方案保持未完成。


### v2 灰度时间驱动自动放量（P4，2026-11-10）

- **开关**：新增 `v2RolloutRampPerHour` / `PARSE_SERVER_V2_ROLLOUT_RAMP_PER_HOUR`（0–100，默认 0）。设置后有效百分比 = `min(target, floor(uptimeHours × ramp))`；例如 target=100、ramp=10，启动后 10 小时线性从 0 放到 100。
- **语义**：纯时间驱动，不依赖错误率/队列等观测反馈；重启会把进程 uptime 归零，从而重新从 0 爬升（可预测但需注意重启会短暂收紧灰度）。与按文件/租户 header 分桶正交。
- **验证**：新增 `rollout.test.ts` 2 项（ramp 边界/封顶/非法值；分桶确定性）；`v2-rollout.test.ts` 扩到 4 项（ramp=100 时启动即 404、非法 ramp 拒绝）。默认 **60 文件 / 409 通过 + 83 跳过（492）**；真实 MySQL+Redis 串行 **84 文件 / 492 项全部通过、无跳过**（87.7 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：不是观测驱动的自动暂停/放量控制器，也没有持久化“已放量到多少”的跨重启进度；生产应配合告警人工停量。整体方案保持未完成。


### v2 观测驱动自动暂停（P4，2026-11-10）

- **Guard**：新增 `canary-guard.ts`：统计最近 60 s 的 v2 创建结果，样本 ≥20 且服务端错误率 ≥阈值时，自动暂停 v2 路由 5 min；暂停期间 `POST /v2/sessions` 返回 404 `not_found`，客户端按既定路径回退 v1。4xx 客户端错误不计入失败。
- **开关**：`v2AutoPauseErrorRate` / `PARSE_SERVER_V2_AUTO_PAUSE_ERROR_RATE`（0–100，0 关闭，启动前校验）。`/v1/health.canaryGuard` 暴露 enabled/paused/threshold/最近样本与触发次数。
- **验证**：新增 `canary-guard.test.ts` 4 项：样本不足不暂停、超阈值暂停与冷却到期、窗口过期清理、默认关闭/非法参数；另 1 项真实 server 校验 health 状态与启动前拒绝。默认 **61 文件 / 413 通过 + 83 跳过（496）**；真实 MySQL+Redis 串行 **85 文件 / 496 项全部通过、无跳过**（87.2 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：只看 v2 创建端点的错误率，不是全链路 SLO；窗口固定 60 s、冷却固定 5 min；进程重启清空样本与暂停状态；没有外部告警联动。整体方案保持未完成。


### v2 DTO 独立版本化（§4，2026-11-10）

- **常量**：`@genoffice/parse-contract` 导出 `PARSE_DTO_VERSION = 1`，`Capabilities` 增加可选 `dtoVersion`。
- **响应**：所有 `/v2/` 响应带 `X-Genoffice-Dto-Version` 头；capabilities、v2 创建（201/202）、ready/pending GET、heartbeat、document 响应的 envelope 增加 `dtoVersion` 字段；v1 envelope 完全不变（无字段、无头）。
- **验证**：新增 `dto-version.test.ts` 1 项：capabilities/创建/pending/ready/document 均有版本字段与头；v1 创建无字段且无头。默认 **62 文件 / 414 通过 + 83 跳过（497）**；真实 MySQL+Redis 串行 **86 文件 / 497 项全部通过、无跳过**（88.1 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：只覆盖 v2 envelope，不是每个嵌套 DTO 的独立版本；unit 响应仍是原始模型（靠头标记版本）；复杂特性 round-trip 与构建系统注入指纹仍未做。整体方案保持未完成。


### 构建指纹由构建系统注入（§4.1/§4，2026-11-10）

- **脚本**：新增 `scripts/build-fingerprint.mts` / `npm run fingerprint`：调用 `parserFingerprint(version)` 生成 64-hex 指纹，打印到 stdout；`--out` 写 `{version,fingerprint,generatedAt}`，`--check` 比对 `PARSE_SERVER_BUILD_FINGERPRINT`（不匹配退出 1、未设置退出 2）。
- **部署流程**：构建时 `export PARSE_SERVER_BUILD_FINGERPRINT=$(npm run -s fingerprint -w @genoffice/parse-server -- --version ...)`，运行时 `bin.ts` 只消费该值，不再每个进程现场哈希。
- **验证**：新增 `build-fingerprint.test.ts`：同一版本两次一致、格式 64-hex、换版本变化；脚本实跑输出 `11b212d…ebfcc` 并写出 JSON。默认 **63 文件 / 415 通过 + 83 跳过（498）**；真实 MySQL+Redis 串行 **87 文件 / 498 项全部通过、无跳过**（88.4 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：脚本仍依赖源码树（monorepo 构建上下文）；打包镜像若只含 dist 需要预生成指纹文件；`parserVersion` 默认仍 0.1.0，需由发布流程注入。整体方案保持未完成。


### 布局缓存键（§4.1，2026-11-10）

- **模块**：新增 `layout-key.ts`：`layoutCacheKey({artifactKey,width,fontSetHash,rendererVersion?,measurementProfile?})` = sha256(canonicalJson)；`measurementProfileHash()` 固定算法版本；校验 64-hex artifactKey、正整数 width、非空 fontSetHash。
- **暴露**：v2 ready GET、`/document` 与 POST 创建 201 响应增加可选 `layoutKey`；v1 body 不变。同一 artifact+width+fontSet 稳定，width/rendererVersion/fontSet/measurementProfile 变化即换 key。
- **验证**：`layout-key.test.ts` 2 项：纯函数确定性/变化/非法值；真实 server 640 与 1280 两个会话 layoutKey 不同、document 与 ready 一致、v1 无字段。默认 **64 文件 / 417 通过 + 83 跳过（500）**；真实 MySQL+Redis 串行 **88 文件 / 500 项全部通过、无跳过**（89.2 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：rendererVersion/measurementProfile 目前是代码常量而非构建注入；客户端尚未真正用 layoutKey 缓存布局；options 默认值仍为空对象。整体方案保持未完成。


### 告警路由模板（P4，2026-11-10）

- **资产**：新增 `deploy/observability/alertmanager.yml.example`：critical → oncall-webhook、cache 告警 → cache-webhook、默认 webhook；`ParseStorageFull` 抑制下游 warning/critical；分组/重复间隔与 `send_resolved` 均给出。
- **接线说明**：observability README 增加“复制模板、替换 webhook、reload Alertmanager”的步骤；仍是模板，不包含真实 on-call 地址与路由测试。
- **验证**：`observability-assets.test.ts` 扩到 4 项：检查路由/接收器/inhibit/severity matcher/示例 webhook 与 README 引用。默认 **64 文件 / 418 通过 + 83 跳过（501）**；真实 MySQL+Redis 串行 **88 文件 / 501 项全部通过、无跳过**（87.8 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：真实告警路由、on-call 轮值、静默/升级策略与端到端演练仍未接入；webhook 地址是占位符。整体方案保持未完成。


### artifact options 归一（§4.1，2026-11-10）

- **函数**：`normalizeArtifactOptions(value)`：undefined/null→`{}`，仅接受 plain JSON（拒绝数组、Date、函数、NaN、undefined 字段），返回对象；`artifactKey` 的 `canonicalJson` 再统一键序，非法 options 在构造 identity 时即报错。
- **接线**：模型 identity 的空 options 与离线包 identity（purpose/modelArtifactKey/modelContentDigest）都经该函数；产物键语义不变（canonical JSON 已排序）。
- **验证**：`artifact-store.test.ts` 扩到 19 项：缺省/非法值/键序不影响 key；默认 **64 文件 / 419 通过 + 83 跳过（502）**；真实 MySQL+Redis 串行 **88 文件 / 502 项全部通过、无跳过**（90.4 s）；tsc/ESLint/diff 通过。
- **边界**：模型 options 目前仍为空对象，没有实际的 options 维度；新增 options 时需同时定义默认值与 artifactKey 兼容策略。整体方案保持未完成。


### bearer token 轮换重叠窗口（§11 验收 6，2026-11-10）

- **开关**：新增 `previousToken` / `PARSE_SERVER_PREVIOUS_TOKEN`：与当前 `token` 同时存在时认证接受两者；启动前拒绝 previous 缺失 token 或与 token 相同。签名（content/parts）始终用当前 token，previous 只是认证重叠。
- **流程**：部署 new+previous → 客户端/代理切新 token（旧 token 仍可上传、开 v1/v2 会话、取 unit、刷新签名 URL、取字体）→ 重叠窗口后移除 previous。
- **验证**：新增 `token-rotation.test.ts`：旧 token 全流程可用、错误 token 401、刷新后的签名 URL 无 auth 可取、非法 previous 配置启动前拒绝；默认 **65 文件 / 420 通过 + 83 跳过（503）**，真实 MySQL+Redis **89 文件 / 503 项全部通过**；tsc/ESLint/diff 通过。
- **边界**：客户端收到 401 后自动刷新/重试尚未实现（依赖外部重新注入 token）；没有自动过期 previous；真实浏览器 403/换域名端到端仍未验收。整体方案保持未完成。


### 多页 PPTX 产物 round-trip 验证（§4.3，2026-11-10）

- **用例**：新增 `artifact-roundtrip-pptx.test.ts`：用 JSZip 构造 5 页 PPTX（复用 blank 模板扩展 slides/rels/content-types），上传→打开→逐页读取 unit→删除会话→关闭服务；重启后重开同一文件，逐页 unit 与首次完全一致，且 `PptxSession.open` 未被调用、`sourceParsesStarted=0`。
- **补充既有覆盖**：`artifact-preview.test.ts` 已覆盖 image/font/table DOCX 的 blocks/styles/fonts 跨重启复用；本轮补上多页 PPTX 的逐页模型/索引 round-trip。
- **验证**：新增 1 项测试；默认 **65 文件 / 420 通过 + 83 跳过（503）**；真实 MySQL+Redis **89 文件 / 503 项全部通过**（本轮测试后计数见评估）。
- **边界**：仍无图表/组合形状/主题/动画/链接/嵌入字体的 PPTX fixture；`document.json`/`fonts/` 目录布局未实现。整体方案保持未完成。


### 图片 PPTX 产物 round-trip（§4.3，2026-11-10）

- **用例**：新增 `artifact-roundtrip-pptx-image.test.ts`：JSZip 在 blank 模板中注入 1×1 PNG、slide rel、content-type 与 `<p:pic>`，上传→打开→读取 unit（含签名 image part URL）→删除会话→重启；重开后 unit 与首次一致（仅签名 origin 归一化），`PptxSession.open` 未调用、`sourceParsesStarted=0`。
- **覆盖**：产物编解码 round-trip 现在覆盖 5 页多页 PPTX、内嵌图片 PPTX，以及既有 DOCX image/font/table。
- **验证**：新增 1 项；默认 **67 文件 / 422 通过 + 83 跳过（505）**；真实 MySQL+Redis 串行 **91 文件 / 505 项全部通过、无跳过**（92.4 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：仍无图表/组合形状/主题/动画/链接/嵌入字体的 PPTX fixture round-trip；`document.json`/`fonts/` 目录布局未实现。整体方案保持未完成。


### 产物 canonical 导出（§4.2，2026-11-10）

- **模块**：新增 `artifact-export.ts`：从 packed reader 物化 `document.json`、`units/<index>.json`、`fonts/<font-id>.sfnt`、`external-media.json`、`artifact-manifest.json`；校验 document 存在、unitCount 安全、缺失 unit 报错，font id 文件名消毒。
- **脚本**：`scripts/export-artifact.mts` / `npm run artifact:export -- --data-dir ... --artifact-key ... --out ...`，不改变运行时 `units.bin` 真相，供检查/移植/备份使用。
- **验证**：新增 `artifact-export.test.ts` 2 项：blank PPTX 导出 document/units/manifest；font.docx 导出 fonts/*.sfnt。默认 **68 文件 / 424 通过 + 83 跳过（507）**；真实 MySQL+Redis 串行 **92 文件 / 507 项全部通过、无跳过**（89.4 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：运行时 generation 目录仍是 `manifest.json+units.bin`，不是方案要求的物理 canonical 布局；导出是工具而非存储格式。整体方案保持未完成。


### 超链接 PPTX 产物 round-trip（§4.3，2026-11-10）

- **用例**：新增 `artifact-roundtrip-pptx-link.test.ts`：在 blank slide 注入带 `a:hlinkClick` 的形状与 external hyperlink rel，打开后 unit JSON 含 `https://example.com/genoffice-roundtrip`；删除会话/重启后 unit 完全一致，`PptxSession.open` 未调用、`sourceParsesStarted=0`。
- **覆盖**：round-trip 已覆盖多页、内嵌图片、外链超链接 PPTX 与 DOCX image/font/table；仍缺图表/组合形状/主题/动画/嵌入字体 fixture。
- **验证**：新增 1 项；默认 **69 文件 / 425 通过 + 83 跳过（508）**；真实 MySQL+Redis 串行 **93 文件 / 508 项全部通过、无跳过**（88.6 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：链接只验证 model/playback 的 external URL round-trip，未验证点击行为；动画/图表/嵌入字体仍无 fixture。整体方案保持未完成。


### canonical sidecar 布局（opt-in，§4.2，2026-11-10）

- **开关**：`canonicalArtifactExport` / `PARSE_SERVER_CANONICAL_ARTIFACT_EXPORT=1`（布尔，启动前校验）。开启后会话首次打开产物时，在同一 generation 目录物化 `document.json`、`units/<i>.json`、`fonts/*.sfnt`、`external-media.json`、`artifact-manifest.json`；packed `units.bin` 仍是运行时唯一读取源。
- **实现**：`ArtifactSession.canonicalDirectory()` 兼容 local reader 与 catalog `ArtifactReadHandle` 的 storagePath；`materializeCanonical()` 复用 `artifact-export.ts`；v1 同步创建与 v2 异步构建成功后各调用一次（失败只告警）。
- **验证**：新增 `canonical-layout.test.ts` 2 项：opt-in 时 PPTX 生成 document/units/manifest 且 font.docx 生成 fonts/*.sfnt；默认关闭不生成。默认 **70 文件 / 427 通过 + 83 跳过（510）**；真实 MySQL+Redis 串行 **94 文件 / 510 项全部通过、无跳过**（113.5 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：默认仍是 packed 布局，sidecar 是 opt-in；写入前按文件字节走 `StorageBudget.reservation()`（不足则整体跳过并告警），写后 generation 不再是严格不可变（仅新增只读文件）；backup 会把 sidecar 当作 artifact 字节。整体方案保持未完成。


### 真实 Chrome 端到端 smoke 复跑（§11，2026-11-10）

- **执行**：`npm run test:library -w @genoffice/viewer`（Playwright + 本机 Chrome + Vite dev server + 真实 parse server），最终报告全 true：历史库保存失败重试、重启缓存复用、移除历史、异步 DOCX 预览不下载原件、**过期 DOCX 会话恢复且不重解析**、淘汰 unit 重取、页面高度稳定、返回失败重试、延迟窗口取消、嵌入字体恢复/清理、延迟图片测量、缩放重排与块锚点、组件切换隔离、关闭前释放字体等待。
- **产物**：`/tmp/genoffice-library-ui/library-flow.png` 与 `docx-memory-samples.json`。
- **意义**：把此前只有单元测试的会话过期/缓存淘汰/字体恢复路径在真实浏览器里跑通，补齐验收 6 的浏览器侧大部分路径；403/换域名的专门场景仍未覆盖。
- **边界**：脚本依赖本机 Chrome 与 Vite dev server，不是 CI 默认套件；没有 403/域名变化与 token 轮换的浏览器内断言。整体方案保持未完成。


### 500 会话 MySQL+catalog 基线（§2/§9，2026-11-10）

- **脚本扩展**：`sessions:load` 新增 `--mysql`（必须带 `PARSE_TEST_MYSQL_SOCKET`）与 `--catalog`：自动建隔离库、启动 catalog 后端 server、500 会话预热共享产物、结束 DROP 库。
- **结果（strict 通过）**：500/500 ready、failed 0、`buildsStarted=1`、create p50 35 ms / p95 70 ms、status p95 0.6 ms、RSS 133.4→165 MiB（+31.6 MiB，约 65 KiB/会话）、serverSessions 501。
- **对比**：文件模式（每会话 JSON 落盘）create p95 0.9 s、+103 MiB；MySQL+catalog 明显更轻。
- **边界**：仍是本机同一共享产物、非 8C/16G/GB 正文/弱网；没有多实例并发写与真实客户端分布。整体方案保持未完成。


### 图表 PPTX 产物 round-trip（§4.3，2026-11-10）

- **用例**：新增 `artifact-roundtrip-pptx-chart.test.ts`：JSZip 注入最小 bar chart（chart1.xml + graphicFrame + chart rel + content-type），打开后 unit JSON 含 chart；删除会话/重启后 unit 完全一致，`PptxSession.open` 未调用、`sourceParsesStarted=0`。
- **覆盖**：round-trip 已含多页、图片、超链接、图表 PPTX 与 DOCX image/font/table；仍缺组合形状/主题/动画/嵌入字体。
- **验证**：新增 1 项；默认 **71 文件 / 428 通过 + 83 跳过（511）**；真实 MySQL+Redis 串行 **95 文件 / 511 项全部通过、无跳过**（132.0 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：图表 fixture 是最小 bar chart，未覆盖 chartEx/主题/用户绘制 overlay；没有验证重绘视觉等价。整体方案保持未完成。


### 组合形状 PPTX 产物 round-trip（§4.3，2026-11-10）

- **用例**：新增 `artifact-roundtrip-pptx-group.test.ts`：注入 `p:grpSp`（组内两个形状），打开后 unit JSON 含 group；删除会话/重启后 unit 完全一致，`PptxSession.open` 未调用、`sourceParsesStarted=0`。
- **覆盖**：round-trip 已含多页、图片、超链接、图表、组合形状 PPTX 与 DOCX image/font/table；仍缺主题/动画/嵌入字体。
- **验证**：新增 1 项；默认 **72 文件 / 429 通过 + 83 跳过（512）**；真实 MySQL+Redis 串行 **96 文件 / 512 项全部通过、无跳过**（119.0 s）；类型检查、改动文件 ESLint、`git diff --check` 通过。
- **边界**：只验证组合结构/子形状模型 round-trip，未验证组合变换与渲染视觉等价；动画 timing 的最小 fixture 未被 parser 识别，暂未覆盖。整体方案保持未完成。


### 主题 PPTX 产物 round-trip（§4.3，2026-11-10）

- **用例**：新增 `artifact-roundtrip-pptx-theme.test.ts`：修改 theme1.xml 的 accent1 为 `FF00AA`，slide 形状用 `schemeClr accent1` 填充；打开后 unit JSON 含解析后的 FF00AA；删除会话/重启后 unit 完全一致，`PptxSession.open` 未调用、`sourceParsesStarted=0`。
- **覆盖**：round-trip 已含多页、图片、超链接、图表、组合形状、主题色 PPTX 与 DOCX image/font/table；仍缺动画/嵌入字体。
- **验证**：新增 1 项；默认 **73 文件 / 430 通过 + 83 跳过（513）**，真实 MySQL+Redis **97 文件 / 513 项全部通过、无跳过**（113.9 s）；类型检查、ESLint、diff 通过。
- **边界**：只验证 scheme 色解析与 round-trip，未覆盖完整 theme 字体/效果矩阵与多主题覆盖；动画 timing 最小 fixture 未被 parser 识别。整体方案保持未完成。


### 动画 PPTX 产物 round-trip（§4.3，2026-11-10）

- **用例**：新增 `artifact-roundtrip-pptx-animation.test.ts`：注入带 `p:spTgt` 的 clickEffect timing（关键是 `presetClass="entr"`，否则 parser 不算动画），打开后 `playback.animations` 非空；删除会话/重启后 unit 完全一致，`PptxSession.open` 未调用、`sourceParsesStarted=0`。
- **覆盖**：round-trip 已含多页、图片、超链接、图表、组合形状、主题色、动画 PPTX 与 DOCX image/font/table；仍缺嵌入字体（fntdata 需 EOT 容器）。
- **验证**：新增 1 项；默认 **74 文件 / 431 通过 + 83 跳过（514）**，真实 MySQL+Redis **98 文件 / 514 项全部通过、无跳过**（103.3 s）；类型检查、ESLint、diff 通过。
- **边界**：只覆盖一个 clickEffect 动画；未覆盖 with/after、退出/强调动画与时间轴视觉等价；嵌入字体 fixture 仍是空白。整体方案保持未完成。


### 嵌入字体 PPTX 产物 round-trip（§4.3，2026-11-10）

- **用例**：新增 `artifact-roundtrip-pptx-font.test.ts`：在 presentation.xml 末尾注入 `embeddedFontLst`（此前插在 defaultTextStyle 失败，因为 blank 模板没有该节点）、裸 sfnt fntdata part、font relationship；打开后 session fonts 含 `RoundtripFont`；重启后 fonts 完全一致，`PptxSession.open` 未调用、`sourceParsesStarted=0`。
- **覆盖**：§4.3 列举的图表/组合形状/主题/动画/链接/嵌入字体 PPTX fixture 现已全部有 round-trip 用例（加 DOCX image/font/table 与多页 PPTX）。
- **验证**：新增 1 项；默认 **75 文件 / 432 通过 + 83 跳过（515）**，真实 MySQL+Redis **99 文件 / 515 项全部通过、无跳过**（108.3 s）；类型检查、ESLint、diff 通过。
- **边界**：字体用裸 sfnt（parser 也接受 LibreOffice 风格），未覆盖压缩 EOT/MTX；chartEx/多主题矩阵与视觉等价仍未验证；Android 无 assetId 抽象。整体方案保持未完成。


### chartEx PPTX 产物 round-trip（§4.3，2026-11-10）

- **用例**：新增 `artifact-roundtrip-pptx-chartex.test.ts`：chartEx funnel 部件（`cx:series` 必须直接位于 `cx:plotAreaRegion` 下，放进 funnelChart 包裹时 parser 只给 placeholder-chip）+ graphicFrame + rel + content-type；打开后 unit 含 Alpha/Beta 与图表模型，重启后一致、不重解析。
- **覆盖**：经典图表 + chartEx funnel 均有 round-trip；仍缺多主题矩阵与渲染视觉等价，Android 无 assetId 抽象。
- **验证**：新增 1 项；默认 **76 文件 / 433 通过 + 83 跳过（516）**（首跑一次失败、重跑通过未复现）；真实 MySQL+Redis **100 文件 / 516 项全部通过、无跳过**（110.7 s）；tsc/ESLint/diff 通过。
- **边界**：chartEx 只覆盖 funnel；waterfall/treemap 仍回退 chip；与主题/字体组合的视觉等价未验证。整体方案保持未完成。


### 500 会话双实例基线（§2/§9，2026-11-10）

- **脚本扩展**：`sessions:load` 新增 `--instances N`（上限 4）：N 个 server 共享同一 dataDir + MySQL catalog，会话按创建顺序轮询分配，健康数据按实例聚合（buildsStarted 求和、perInstanceSessions 分别列出）。
- **结果（strict 通过）**：2 实例 × 500 会话：ready 500、failed 0、perInstanceSessions [251, 250]、buildsStarted 合计 1、create p50 45.6 ms / p95 75.4 ms、status p95 0.3 ms、RSS +38.7 MiB（约 79 KiB/会话）。
- **边界**：两实例同进程同机、共享目录；不是跨机/对象存储，也不是 8C/16G/GB 正文/弱网；仅证明共享 dataDir+catalog 的会话水平扩展基线。整体方案保持未完成。


### 渲染树等价验证（§4.3，2026-11-10）

- **用例**：新增 `artifact-roundtrip-render-equivalence.test.ts`：组合形状 + theme accent1 + clickEffect 动画的 slide，打开后取 `/v1/sessions/:id/layout/slides/0`，`buildRenderSlide` 生成渲染树；删除会话/重启后重开，layout 模型与 render tree JSON 完全一致，且不重解析。
- **意义**：把 round-trip 从“unit/layout JSON 相等”推进到“渲染树逐字节相等”，覆盖渲染前最后一层（仍不是像素级截图对比）。
- **验证**：新增 1 项；默认 **77 文件 / 434 通过 + 83 跳过（517）**，真实 MySQL+Redis **101 文件 / 517 项全部通过、无跳过**（100.4 s）；tsc/ESLint/diff 通过。
- **边界**：单 slide、单主题、无媒体解码；未覆盖多主题矩阵、字体回退差异与像素级视觉 diff；Android 无 assetId。整体方案保持未完成。


### 跨实例备份/恢复演练（P4，2026-11-10）

- **用例**：新增 `backup-manifest-cross-node-mysql.test.ts`：A/B 共享 dataDir + MySQL catalog；A 构建并服务 ready 会话；B 用自身 `db` 生成 backup manifest（含 catalog 依赖边）；A 用自身 `db` 执行 `verifyRestore`，结果 ok 且 errors 为空。
- **意义**：备份不再要求“停服/同一进程”，可在同部署的另一实例上在线快照并交叉校验。
- **验证**：新增 1 项；默认 **77 文件 / 434 通过 + 84 跳过（518）**，真实 MySQL+Redis **102 文件 / 518 项全部通过、无跳过**（112.9 s）；tsc/ESLint/diff 通过。
- **边界**：两实例同机共享目录，不是跨机器/对象存储；备份仍在同一 dataDir 校验，没有异地恢复或调度。整体方案保持未完成。


### monorepo 验证与既有失败边界（2026-11-10）

- **本轮验证**：`@genoffice/parse-contract` 13 项测试通过；parse-contract、viewer、parse-server 三个受影响 workspace 的 `tsc --noEmit` 均通过。
- **根目录 typecheck 现状**：`npm run typecheck` 在 `apps/sheets` 的依赖注入类型（`IdentifierDecorator` / `clipboardService` / `lazy-find`）报错，属工作区既有问题，与 parse 持久化改动无关；本轮未修改 sheets，也未把根目录 typecheck 当作本方案验收项。
- **结论**：方案相关包的验证链完整；monorepo 整体类型检查要等 sheets 的既有类型问题单独处理。整体方案保持未完成。


### artifact:export 支持 catalog 后端（§4.2 工具，2026-11-10）

- **脚本**：`export-artifact.mts` 新增 `--catalog`：从 `MYSQL_*` 连接数据库，`MysqlArtifactCatalog.getReady(key)` 取 ready 指针，`ArtifactGenerations.open(ready)` 读 `g-N`，复用 `exportArtifactDirectory` 输出 canonical 文件；local 模式行为不变。
- **验证**：真实 MySQL + catalog 手工跑通：生成 blank PPTX ready generation 1，导出 `document.json`/`units/0.json`/`artifact-manifest.json`/`fonts/`/`external-media.json`，`totalBytes=1951`。
- **边界**：脚本是运维工具，不改变运行时 packed 布局；需要 `MYSQL_*` 环境与共享 dataDir；未做 catalog 离线归档场景。整体方案保持未完成。


### 真实 Chrome 像素级等价演练（§4.3，2026-11-10）

- **脚本**：新增 `apps/viewer/scripts/slide-pixel-equivalence.mts` / `npm run test:pixel`：Vite dev server + Playwright/Chrome + 真实 parse server（catalog 或 local）；上传含主题色/组合形状/动画/PNG 的 PPTX，打开 viewer iframe，轮询 canvas `toDataURL` 直到稳定；重启 parse server（同一 dataDir）后重开同一 fileId，再次采样。
- **结果**：before/after canvas 哈希均为 `8b5a01be3911321d9a0f7b3104c6e2f1bd02498d55307531f57071a45701a022`，`equal=true`、无 page error；截图写到 `/tmp/genoffice-slide-pixel-before.png` / `-after.png`。
- **意义**：从 render tree 等价推进到真实浏览器 canvas 像素等价，覆盖 artifact 重启复用路径的主题/组合/动画/图片合成。
- **边界**：单机单浏览器，未覆盖多设备/多主题矩阵/字体回退差异；脚本不是 CI 默认套件，依赖本机 Chrome 与 Vite dev server。整体方案保持未完成。


### 双主题 deck 产物 round-trip（§4.3，2026-11-10）

- **用例**：新增 `artifact-roundtrip-two-theme.test.ts`：在 blank 模板上复制并扩展第二套 slideMaster/slideLayout/theme（theme2 accent1=00AAFF），两张 slide 分别走两套主题；打开后 slide0/layout 含 FF00AA、slide1 含 00AAFF；删除会话/重启后逐页一致、不重解析。
- **覆盖**：主题方向从单 theme 扩到**双 theme master/layout 继承链**；像素等价仍是单 slide 演练。
- **验证**：新增 1 项；默认 **78 文件 / 435 通过 + 84 跳过（519）**，真实 MySQL+Redis **103 文件 / 519 项全部通过、无跳过**（97.7 s）；tsc/ESLint/diff 通过。
- **边界**：只覆盖两个 theme、无字体/效果矩阵；不是多设备像素回归；Android 无 assetId。整体方案保持未完成。


### 像素等价视口矩阵（§4.3，2026-11-10）

- **扩展**：`slide-pixel-equivalence.mts` 支持 `--width`（600–2000），在 960/1200/1280 视口分别做“重启前后 canvas `toDataURL` 哈希”对比。
- **结果**：960 → `39d89bf7…`（equal）、1200 → `8b5a01be…`（equal）、1280 → `cc274e9a…`（equal）；均无 page error，截图按宽度分别输出。
- **意义**：从单视口像素等价扩到视口矩阵，降低“只在某一宽度偶然一致”的风险。
- **边界**：仍是单机单浏览器；不是多设备/多 DPR/多字体回退矩阵。整体方案保持未完成。


### 像素等价 DPR 维度（§4.3，2026-11-10）

- **扩展**：`slide-pixel-equivalence.mts` 增加 `--dpr`（1–3），与 `--width` 组合成视口×DPR 矩阵。
- **结果**：960@2 与 1280@1.5 的 canvas backing 均为 1920×1080，before/after 哈希同为 `3e3ba62d…`，`equal=true`、无 page error；截图分别为 1920×1080。
- **结论**：至少两种 DPR 路径在重启复用后保持像素一致；仍未覆盖多设备/多字体回退。
- **边界**：本机单浏览器；不同 DPR 恰好落到相同 backing 尺寸，不能替代多设备矩阵。整体方案保持未完成。


### 像素等价设备档矩阵（§4.3，2026-11-10）

- **扩展**：`slide-pixel-equivalence.mts` 增加 `--device`（Playwright device profile），使用该 profile 的 viewport/DPR/UA 渲染。
- **结果**：Pixel 5（393×851@2.75）`before/after=75b9e886…`；iPad Mini（768×1024@2）`before/after=3902a9fe…`；均 equal、无 page error。
- **意义**：像素等价矩阵从 viewport/DPR 扩到移动/平板设备档；仍是同一 Chromium。
- **边界**：不是真实多设备/多浏览器；字体回退与 Safari/WebView 未覆盖。整体方案保持未完成。


### 像素等价多引擎矩阵（§4.3，2026-11-10）

- **扩展**：`slide-pixel-equivalence.mts` 增加 `--browser chromium|firefox|webkit`；判定从“canvas data URL 字符串相等”改为**逐像素比较**（`pngjs` 解码 + `pixelmatch`，阈值 0.1、`includeAA`），报告 `byteEqual`/`pixelEqual`/`diffPixels`。原因是 Firefox 的 canvas PNG 编码跨页面实例不逐字节稳定，即使所有像素一致也会得到不同 SHA；只比字节会把正确渲染误判为失败。
- **结果**：Chromium 1200 字节相等 `8b5a01be…`；WebKit 1200 字节相等 `87acf7f4…`、960 `c40c51f0…`、Pixel 5 `7a732b32…`；Firefox 1200/960 均 `byteEqual=false` 但 `pixelEqual=true`、`diffPixels=0`（Firefox 157 / Playwright firefox-1555）。
- **403 跨引擎**：`--fail-first-part` 在 WebKit（哈希仍 `87acf7f4…`）与 Firefox（`diffPixels=0`）下同样通过，说明 403 签名刷新后的重试与重启复用不依赖 Chromium 的编码/缓存路径。
- **意义**：像素等价从单 Chromium 扩到 Chromium/WebKit/Firefox 三引擎，并明确了“像素等价 ≠ 编码字节相等”的判定口径。
- **边界**：Firefox 只验证像素等价；Safari 真机与 Android WebView 未跑；音视频/字体 403 的浏览器断言仍未做；设备档仍是 Playwright profile，不是真实多设备回归。整体方案保持未完成。


### 403 签名刷新与浏览器重试（验收 6，2026-11-10）

- **服务端**：新增 `POST /v1/files/:fileId/part-url`（bearer 认证）重新签发指定 part 路径，返回 `{url, expiresAt}`；拒绝路径穿越/控制字符；未授权 401、非法路径 400。
- **Web**：新增 `part-url.ts` 客户端刷新函数；`createImageLoader` 支持一次性 `retry`，加载失败时调用刷新并使用新 URL 重试；Slides 接入（音频/视频已有 mediaRef 刷新）。
- **验证**：`part-url.test.ts`（server 1 项 + viewer 2 项）；像素演练新增 `--fail-first-part`：首个 part 请求 403，刷新后仍渲染出与基线一致的 `8b5a01be…`（Chromium），并在 WebKit/Firefox 下通过（见多引擎矩阵一节）。默认 server **79 文件 / 437 通过 + 84 跳过（521）**、真实 MySQL+Redis **104 文件 / 521 项全部通过**；viewer **100/100**；tsc/ESLint/diff 通过。
- **边界**：仅为图片加载接入 403 重试；音视频/字体 403 的专门浏览器断言与客户端 token 主动注入未做；part-url 依赖当前 token 重新签名。整体方案保持未完成。

### 多引擎像素演练的判定口径修正（§4.3，2026-11-10）

- **问题**：Firefox 157 下同一 slide 重启前后的 canvas 像素完全一致，但 PNG 编码字节不同（`before`/`after` SHA 不同、文件大小相同）。若只比较 `toDataURL` 字符串，会产生假阴性。
- **修正**：`slide-pixel-equivalence.mts` 用 `pngjs` 解码并 `pixelmatch`（阈值 0.1、`includeAA`）逐像素比较，报告 `byteEqual`/`pixelEqual`/`diffPixels`/`canvas`；`equal` 以 `pixelEqual` 为准，字节哈希仅留作追溯。
- **验证**：Firefox 1200/960 均 `diffPixels=0`；同一 Firefox 版本两次独立运行的 before/after PNG 逐像素差也为 0。Chromium/WebKit 仍保持 `byteEqual=true`（哈希见多引擎矩阵一节）。
- **边界**：该结论只说明“同一机器同一浏览器的重启复用路径像素稳定”，不是跨设备视觉回归基线；Safari 真机/Android WebView 仍未跑。整体方案保持未完成。


### 加密文档入口显式拒绝（§8.2，2026-11-10）

- **问题**：带打开密码的 DOCX/PPTX 是 OLE 复合容器（CFB）而不是 zip；此前 `detectFormat` 只认 PDF/zip，会落入 `unsupported_format`，无法区分“格式不支持”和“需要密码”。
- **实现**：`detect.ts` 识别 CFB magic `D0 CF 11 E0 A1 B1 1A E1` 并返回 `encrypted`；上传入口对 `encrypted` 返回 **415 `encrypted_document`**，消息明确“password-protected… not supported”，不进入解析、不落产物、不占预留。
- **验证**：`tests/library.test.ts` 新增 1 项：CFB 头文件上传返回 415、`code=encrypted_document`、`tmp` 为空、`artifacts.reservedBytes=0`。默认 **79 文件 / 437 通过 + 84 跳过（521）**；真实 MySQL+Redis 串行 **104 文件 / 521 项全部通过（111.33 s）**；tsc/ESLint 通过。
- **边界**：只做入口拒绝，不做口令输入/解密；旧版二进制 `.doc` 同样按加密容器拒绝（产品语义为“不支持”）。后续独立设计解密任务、密钥生命周期与缓存访问范围。整体方案保持未完成。


### 会话空闲 TTL 对齐 30 分钟（§6.1，2026-11-10）

- **实现**：`createParseServer` 默认 `sessionTtlMs` 从 15 分钟改为 **30 分钟**，`runtime-options.ts` 默认值同步为 `1_800_000`；显式 `PARSE_SERVER_SESSION_TTL_MS`/构造参数仍可覆盖。
- **验证**：`pptx-session.test.ts` 的 125 分钟续期用例改为显式 `sessionTtlMs: 15 * 60_000`（保持“续期 vs 20 分钟空闲过期”的算术不变），其余默认行为用例通过；`session-record-mysql.test.ts` 三处 `expires_at = last_used + 30 min` 断言随默认值更新。默认 **437/521**、真实 MySQL+Redis **521/521**。
- **边界**：§6.1 其余预算项见下一节。整体方案保持未完成。

### §6.1 内存读缓存字节预算与 HTTP 并发上限（2026-11-10）

- **模型读缓存**：新增 `model-cache.ts`（按字节计量的 LRU，默认 **256 MiB**，`PARSE_SERVER_MODEL_CACHE_MAX_BYTES=0` 可关闭）；缓存工件 `document`/`unit:*`/`layout`/`styles`/字体记录，键为 `artifactKey:contentDigest:recordId`，因此重建/修复后的新 generation 不会命中旧记录。派生离线包记录（`bundle`、`bundle:*`）显式绕过缓存，保证损坏演练仍能读到坏帧并触发重建（`offline-bundle-catalog-mysql` 回归）。
- **总预算**：新增 `memoryCacheBudgetBytes`（默认 **2 GiB**，`PARSE_SERVER_MEMORY_CACHE_BUDGET_BYTES`），模型缓存被钳制在总预算内并在启动时校验；`/v1/health.memoryCache` 暴露 `budgetBytes` 与 `model.stats()`，`/metrics` 新增 `genoffice_parse_model_cache_{bytes,max_bytes,entries,hits_total,misses_total,evictions_total,skipped_total}`。
- **HTTP 并发上限**：请求入口新增 `httpMaxConcurrency`（默认 **128**，`PARSE_SERVER_HTTP_MAX_CONCURRENCY`）；超过上限返回 **503 `server_busy` + `Retry-After: 1`**，`/v1/health` 与 `/metrics` 始终可达，便于观测饱和；`health.http` 与 `genoffice_parse_http_{requests_in_flight,concurrency_limit,rejected_total}` 暴露在途/上限/拒绝数。
- **验证**：新增 `model-cache.test.ts` 5 项（按字节 LRU 淘汰、超大记录跳过、同键更新、0 预算禁用、JSON/Buffer 计量）与 `model-cache-server.test.ts` 3 项（重复读命中且字节不越预算、小预算不越界、单 slot 被占时 503 且 health/metrics 可达）；默认 **81 文件 / 445 通过 + 84 跳过（529）**，真实 MySQL+Redis 串行 **106 文件 / 529 项全部通过（107.56 s）**；tsc/ESLint 通过；viewer 100/100。
- **边界**：2 GiB 预算只对模型读缓存做字节强制，预览缓存仍是 2 MiB 字节上限、reader 缓存仍是 512 条上限，尚未统一计入总预算；缓存命中不再重复校验 SHA（首次读入已校验，generation 不可变）；磁盘 I/O 与解压工作池见下一节。整体方案保持未完成。

### §6.1 磁盘 I/O 与解压工作池上限（2026-11-10）

- **实现**：新增 `work-pools.ts`（FIFO 计数信号量 + `WorkPools`）：`disk` 默认 **32** 并发（`PARSE_SERVER_DISK_IO_CONCURRENCY`）、`inflate` 默认 **4** 并发（`PARSE_SERVER_INFLATE_CONCURRENCY`）。`ArtifactReader.read` 把 `open/read/close` 包进 disk 池、`gunzip` 包进 inflate 池；超限请求排队而不是拒绝（HTTP 层已有拒绝上限），避免读放大直接变成无界内核 I/O / zlib 工作。
- **观测**：`/v1/health.pools` 暴露 `{limit, active, waiting, peak, peakWaiting}`；`/metrics` 新增 `genoffice_parse_work_pool_{limit,active,waiting,peak,peak_waiting}{pool=disk|inflate}`。
- **验证**：新增 `work-pools.test.ts` 4 项（limit=2 时 5 个任务峰值并发 2、`peakWaiting=3`、异常释放槽位、非法 limit 拒绝、默认/自定义池暴露）与 `work-pools-server.test.ts` 2 项（disk/inflate 均设 1 时 4 个并行 unit 读全部 200、健康/指标暴露 limit=1、peak≤1；非法 limit 启动前拒绝）。默认 **83 文件 / 451 通过 + 84 跳过（535）**、真实 MySQL+Redis 串行 **108 文件 / 535 项全部通过（107.10 s）**；tsc/ESLint 通过。
- **边界**：池只覆盖工件记录读路径；manifest/目录枚举与解析子进程内的解压仍分别受文件系统与解析并发约束；池无单任务超时，依赖上层 `unitTimeoutMs`。整体方案保持未完成。

### §6 可恢复基础设施错误有限重试（2026-11-10）

- **实现**：新增 `retry-policy.ts`：仅对 `EAGAIN/EBUSY/ETIMEDOUT/ECONNRESET/ECONNREFUSED/EPIPE/ENETRESET/ENETUNREACH/EHOSTUNREACH/ER_LOCK_DEADLOCK/ER_LOCK_WAIT_TIMEOUT/PROTOCOL_CONNECTION_LOST/PROTOCOL_SEQUENCE_TIMEOUT`（含 cause 链）做指数退避重试；解析/模型错误、损坏、租约丢失、`ENOSPC/EDQUOT` 等立即失败。
- **接入**：`ArtifactCoordinator` 对 catalog 共享构建的 `claim → build → complete` 失败按 `buildRetryAttempts`（默认 2，`PARSE_SERVER_BUILD_RETRY_ATTEMPTS`，0 关闭）重试，每次重新 claim 新 generation；local `ArtifactStore.getOrBuild` 同样在失败后清 staging 并以新 writer 重试。`health.artifactCoordinator.retries`、`artifacts.stats.buildRetries` 与 `genoffice_parse_build_retries_total{scope=local|shared}` 暴露重试次数。
- **验证**：新增 `retry-policy.test.ts` 3 项（可恢复/不可恢复分类、cause 链、指数退避上限）、`artifact-coordinator.test.ts` 3 项（临时错误后第二次 claim 成功且 `stats.retries=1`、解析错误不重试、重试预算耗尽后失败）、`build-retry.test.ts` 3 项（local 构建重试且清空 staging、畸形源不重试、预算耗尽）。默认 **85 文件 / 460 通过 + 84 跳过（544）**、真实 MySQL+Redis 串行 **110 文件 / 544 项全部通过（105.66 s）**；tsc/ESLint 通过。
- **边界**：只重试构建路径，不重试读请求/上传；重试会重新执行构建回调（可能重解析源文件），因此仅限瞬时基础设施错误且次数有界；无抖动（单构建内串行重试，不形成惊群）；`artifact_lease_lost` 不重试，交由上层重新 claim 周期处理。整体方案保持未完成。

### §6 cancelled 任务状态（2026-11-10）

- **实现**：`parse_jobs`/`parse_artifacts` 新增独立的 `cancelled` 状态。`MysqlArtifactCatalog.cancel(lease, 'build_cancelled')` 在租约事务内把任务标记为 `cancelled`（有 ready 时 artifact 保持 `ready`，无 ready 时 artifact 为 `cancelled`），到期租约不能再 `complete`。
- **接线**：`ArtifactCoordinator` 在构建因 `AbortError` 主动中止（服务关闭）时调用 `cancel`，租约丢失/真实构建错误仍走 `fail`（`build_interrupted`/`build_failed`）；`cancel` 为可选能力，旧 catalog 实现自动回退 `fail`。
- **验证**：`artifact-coordinator.test.ts` 关闭用例断言 `cancel(..., 'build_cancelled')` 且 `fail` 未被调用；`artifact-catalog-mysql.test.ts` 新增 1 项真实 MySQL 用例：`parse_jobs.state='cancelled'`、`error_code='build_cancelled'`、artifact 无 ready 时为 `cancelled`、旧租约 `complete` 返回 false、下一次 claim 仍得到递增 generation、非法错误码拒绝。默认 **85 文件 / 460 通过 + 85 跳过（545）**、真实 MySQL+Redis 串行 **110 文件 / 545 项全部通过（103.63 s）**；tsc/ESLint 通过。
- **边界**：「无等待者时取消尚未开始的任务」见下一节；重启后的过期 lease 仍依赖 `claim` 惰性接手，没有主动扫描重排。整体方案保持未完成。

### §6 无等待者时取消排队中的临时预览（2026-11-10）

- **实现**：构建链新增 demand 信号并贯通 `ArtifactCoordinator.getOrBuild(..., demand)`、`ArtifactStore.getOrBuild(..., demand)`、`ArtifactSession.open/openShared`。服务端 `startAsyncWork` 为每个异步预览建立 `AbortController` 并登记 `{artifactKey, controller}`；当最后一个 reader 离开（DELETE/连接关闭/待处理会话 TTL 清理）时调用 `cancelPendingBuild`。
- **共享保护**：`cancelPendingBuild` 先检查同一 `artifactKey` 是否还有其他 pending waiter；有则不动。只有最后一个 waiter 离开才 abort 该 artifact 的所有 demand 控制器。abort 经 `ParseQueue` 的 signal 只取消仍在排队的构建；已开始的构建继续跑完（worker/内存由队列在 settle 时回收），构建完成后发现无 reader 仍按原逻辑丢弃产物。
- **验证**：`artifact-source-build.test.ts` 新增 2 项（catalog 共享构建在排队时因 demand abort 取消、`cancel('build_cancelled')` 且不启动 worker；local store 同样经 demand 取消排队构建）；`preview-cancel.test.ts` 2 项（同一 artifact 还有其他 waiter 时保持构建、最后一个 waiter 才 abort、不同 artifact 不受影响、幂等/未知会话安全）。`async-session.test.ts` 的双 viewer 共享构建用例回归通过（同一实例两个 pending viewer 共用 readerId 时，第一个关闭不会误杀共享构建）。默认 **86 文件 / 464 通过 + 85 跳过（549）**、真实 MySQL+Redis 串行 **111 文件 / 549 项全部通过（107.29 s）**；tsc/ESLint 通过。
- **边界**：只取消“尚未开始”的排队构建；运行中的构建不因 waiter 离开而 abort（由队列与 worker 生命周期负责）。重启后的过期 lease 见下一节。整体方案保持未完成。

### §6 重启扫描过期 lease 并恢复排队任务（2026-11-10）

- **实现**：`MysqlArtifactCatalog.recoverExpiredBuilds(limit=100)` 在单事务内找出 `parse_jobs.state='building'` 且 `lease_until` 为空/已过期的行（JOIN artifact，`FOR UPDATE`，上限 1000），把任务置为 `state='queued'`、清空 `lease_owner/lease_until`，无 ready 的 artifact 置 `queued`；已有 ready 指针的 artifact 保持 `ready`，只重置任务行。活跃 lease 不受影响。
- **启动接线**：catalog 后端在监听前调用一次，日志 `expired_build_leases_requeued`（examined/requeued），`/v1/health.maintenance.leaseRecovery` 暴露结果；随后监听时恢复 pending session，会重新 claim 并得到递增 generation。
- **验证**：`artifact-catalog-mysql.test.ts` 新增 1 项：过期任务重排为 queued/lease 清空、artifact 变 queued、活跃 builder 不受影响、再次 claim generation+1、ready 指针在重建任务过期后仍保留（artifact 仍 ready）；新增 `lease-recovery-startup-mysql.test.ts` 1 项：预置过期 building 行后真实启动 catalog server，health 报 `{examined:1,requeued:1}`，SQL 中 job/artifact 均变 queued。默认 **86 文件 / 464 通过 + 87 跳过（551）**、真实 MySQL+Redis 串行 **112 文件 / 551 项全部通过（139.92 s）**；tsc/ESLint 通过。
- **边界**：只在启动时扫描一次，运行期不做周期性过期 lease 巡检；以 `lease_until` 过期作为唯一判据（不校验 owner 进程是否存活）；重排不改变 generation，下一次 claim 才递增。整体方案保持未完成。

### P4 目标负载样本（§6.1/§11，2026-11-10）

- **脚本**：新增 `apps/parse-server/scripts/load-profile.mts` / `npm run load:profile -w @genoffice/parse-server`：22 个不同 60 页 PPTX（2 冷解析 + 20 排队，队列上限 20）、热文件先做 50 次隔离缓存阅读、再在冷解析/排队期间做 50 次并发缓存阅读、随后创建 500 个轻量阅读会话；同时采样 health 延迟与父/子进程 RSS。
- **结果**（本机 Apple Silicon 10 核 / 16 GiB，macOS 27.2.1，Node 22.23.4，local 后端）：队列峰值 running 2 / queued 20；冷任务就绪 p50 **3541 ms**、p95 **6662 ms**（22×60 页，冷阶段 8123 ms）；隔离热阅读 50 次 p95 **20.64 ms** 且解析启动增量 **0**；冷/排队期间 50 次并发阅读 p95 **10.83 ms**（全部 200）；396 次 health 探针 p95 8.70 ms、最大 62.3 ms 无失败；500 轻量会话创建 p95 **73.28 ms**；RSS 峰值（父+子）**0.41 GiB**，远低于 12 GiB 目标；上传源文件 1.16 MB。
- **报告**：完整数据与口径见 [parse-load-profile.zh-CN.md](parse-load-profile.zh-CN.md)。
- **边界**：未在精确 8 核/16 GiB 机型复跑；未接真实 MySQL/Redis；样本是 60 页 PPTX，不含 GB 正文、弱网、真实磁盘吞吐与长时稳定性；RSS 为健康接口采样近似值，不是 cgroup 内核计量。整体方案保持未完成。

### P4 独立目录/异机式恢复演练（§9/§10，2026-11-10）

- **脚本**：新增 `apps/parse-server/scripts/restore-drill.mts` / `npm run restore:drill`：源端构建 2 个文件（30/12 页）与 2 条历史库记录 → 生成备份清单 → 整目录拷贝到第二个独立 dataDir（模拟另一台机器/介质）→ 只读 `verifyRestore` + restore 门禁启动 → 缓存重开验证零重解析；再分别篡改 source 与派生 artifact 验证失败关闭/可重建语义。
- **结果**：清单 9 条目（2 source / 4 artifact / library 2 行、digest `cbc9b2cf…`）；machine B 只读校验 `ok=true/readyAllowed=true`、门禁 `ok=true`、缓存重开 `sourceParsesStarted` 增量 **0**、unit 与源端一致、历史库 2 条；篡改 source → `source_size_mismatch`、`ok=false`（启动失败关闭）；篡改派生 artifact → 仅 `artifact_size_mismatch` 警告、`ok=true`（filesystem 后端无 ready 指针，可在请求时重建）。
- **报告**：[parse-restore-drill.zh-CN.md](parse-restore-drill.zh-CN.md)。
- **边界**：第二目录仍在同一主机，未用真实第二台机器/外接介质，也未导出/导入 MySQL catalog；真实跨机器与 catalog 库恢复、备份保留/调度与 on-call 仍未做。整体方案保持未完成。

