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

- Android 本地完整性：离线 manifest 增加 bundleSchemaVersion=1 和逐文件 size/SHA-256 清单，complete 保存 manifest 哈希；发布前校验模型/字体必需文件，后台打开前重算资源哈希，拒绝缺页、截断、同长度篡改及路径越界。未完成包不能创建本地回放会话；发布重命名中断导致目标缺失时恢复已封存的 .previous。旧版无校验清单的包需重新下载。本项是本地缓存完整性，尚非服务端 artifactKey/schema/源哈希清单。

- Android 下载取消：设置页按钮和 Activity 销毁接入取消；中断排队睡眠、异步断开活动 HTTP、在媒体块和 SHA-256 读取中检查中断，最终关闭本次阅读会话并清 staging。已完成包原子发布前保留；发布是提交点，进入后不撤销。下载进度按代次隔离，取消后不再覆盖 UI；共享服务端构建不随单个下载者取消。

- Android 空间保护：开始下载先检查余量；媒体/字体按 Content-Length 做单资源预检，未知长度逐写入块检查，模型/manifest/complete 写入同样保留 64 MiB。检查发生在 staging，不删除旧完整包；已有缓存读取不要求额外空闲。仍非整包容量预算或跨应用磁盘预留，缓存配额/清理界面及权威清单仍待完成。

## 权威离线包清单（新增）

- PPTX 离线清单和资源接口已接入。清单含辅助 artifactKey、主模型 modelArtifactKey、解析指纹、schema、每个资源的大小/SHA-256；显式字体路径支持 `embed:0` 等非文件名 ID。清单覆盖全部 ppt/media，未引用媒体也下载；外部媒体另行列明。
- 清单按需生成独立持久辅助产物，绑定主模型记录内容摘要，共用有界队列，不重复启动源解析。正常在线预览不提前读取全部媒体。ZIP 校验和清单失败不破坏已就绪预览；单个下载者取消、关闭会话后共享构建仍继续。
- Android 优先读取服务端清单，逐资源验证源大小和哈希，成功后 sourceVerified=true；仅清单 404/405 兼容旧流程并标记 false。下载地址由配置服务及验证路径生成，不信任 href。整包容量预检加元数据余量，写入中继续检查 64 MiB 余量。包含外部媒体时明确拒绝完整离线，部分离线提示仍待实现。
- 原先“尚非服务端清单”“整包预检待完成”描述为早期检查点，现由本节替代。仍按 fileId 存目录；续传、版本目录、缓存管理仍待实现。

## 最近验证

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

1. 辅助离线包从旧 `ArtifactStore.getOrBuild` 布局切到 generation + 独立依赖 pin，并把损坏修复统一到 catalog 后端。
2. 跨进程统一空间准入：`StorageBudget` 目前是单实例账本，需把并发预留/水位回收移到 SQL 或等价共享协调层；
   generation 高水位归档、目录最终清理与完整启动对账。
3. 解析中的增量首屏（当前仍全量 ready 后才发布）、复杂 PPTX/DOCX round-trip 与真实 GB 正文压测记录。
4. 最后一个等待者取消后的共享任务调度策略、SQL/IO 关闭宽限期硬超时、跨节点任务状态映射。
5. Android 续传（ETag/Content-Range 严格校验）、按 artifactKey 的版本目录、缓存配额与清理入口；
   部分离线提示（当前含外链媒体直接拒绝完整离线）。
6. 备份清单与恢复演练、损坏 generation 的单条 unit/font 更广泛故障注入与并发修复压测。

**依赖部署 / 目标环境，不能由本机代码改动代替**

7. Linux 委派 cgroup v2 上验证内核 OOM 与进程组清理；8 核 16 GiB 上 2 冷解析 + 20 排队 + 50/500 会话的
   p50/p95、RSS 峰值、CPU、磁盘吞吐和目标延迟基线。
8. 真实 MySQL 多写入者共享目录、nginx 路由 `nginx -t`、生产容量/配额/备份位置、灰度开关与回滚演练。
9. Android 真机、Windows 内存采样、PDF/DOCX 移动预览闭环。

## 当前限制

`artifactBackend` 默认仍是 `local`；catalog（MySQL + generation + 租约）是可程序化选择的入口，尚未设为默认，
也没有多实例共享目录的生产验收。文件索引适配器仍是单服务进程去重；`StorageBudget` 的并发预留与软水位是进程内状态，
只能看见别的进程已落盘字节。历史库按实例共享，尚无多用户归属。已支持打开清单时的条件失效、单条记录损坏的
按代次撤销/重建、已打开视图的 single-flight 修复，以及旧扁平产物两遍校验后的导入；普通 IO 错误不误判为损坏，
旧 generation 目录不会被修复路径删除。离线包衍生产物仍走旧布局，其损坏只清除视图内缓存。原文件与产物字节已纳入
上传准入配额，产物写入增量预留，上传临时文件逐块保护，DOCX scratch 接入预算，压力下闲置派生产物回收、高低水位、
共享 staging 对账与后台 generation 回收均已接入；跨进程统一准入、generation 高水位归档、目录最终清理与完整启动
对账仍待实施；显式保存的原文件不会被自动删除。客户端仍保留小 DOCX 全量本地渲染。DOCX 已移除全量 document.xml、
slices、blocks 与 parsedChunks 的持有，使用正文双遍流读取、最多 200 块一批落盘；辅助 parts、元数据索引和单个
XML 块仍在内存，单块上限 64 Mi UTF-16 字符。产物仍构建完后整体发布，尚无解析中的增量首屏。独立进程隔离及采样式
RSS 限制已验证；Linux cgroup 内核硬限制、真实 GB 正文压测、500 阅读会话压测及 Android 真机未完成。
nginx 配置已补路由，但本机没有 nginx 可执行文件，尚未执行 `nginx -t`。


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
Android 续传/版本目录与目标硬件压测仍未完成，整体目标保持未完成。

