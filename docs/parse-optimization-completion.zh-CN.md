# 解析优化方案完成度评估

> **2026-11-11 更新：本文件以下为历史方案自评。** 旧版 86% / 73% 口径有冲突，且不能体现新发现的远程 DOCX 功能缺口；不再用这些数字作当前交付依据。当前可核验结论、业务样本、Docker 限额、551 项集成回归、GB 正文及数据库冷恢复见 [最新验收报告](parse-docker-validation.zh-CN.md)。当前未完成项优先级为脚注编号、分节 / 页眉页脚、最大 PPT 首页素材就绪、16 GiB 环境及真实异机 / Office 基线。

评估日期：2026-11-10。评估对象：[`parse-persistence-optimization.zh-CN.md`](parse-persistence-optimization.zh-CN.md)（2026-11-10 版，292 行）。
代码基线：分支 `feat/parse-server`，HEAD `de677f0d`（该提交只改文档，新增可选 Redis 热缓存层）；工作区另有 P3.5 最小实现、v2 契约补齐、部署开关、测试夹具修复与文档改动（未提交），见 §7。
进度自述：[`parse-optimization-progress.zh-CN.md`](parse-optimization-progress.zh-CN.md)。本评估不采信进度文档结论，以源码、路由、SQL 表和可执行回归为准；口径与局限见 §9。

## 1. 结论

**整体约八成完成：按方案细项计权 86%（104 完成 / 25 部分 / 6 未实现，共 135 项）。方案整体目标仍未完成，不能宣布完成。**

- **P0 正确性、P1 持久化基础：退出条件已达成。** 并发预占、恢复 single-flight、配置校验、DOCX 游标/心跳/签名、产物编解码与原子发布、重启命中不重解析都有回归；P1 退出条件「新会话和重启命中产物时解析启动数为 0」有直接测试。
- **P2 资源解耦、P3 大文件与体验：主体已落地。** v2 异步会话、有界队列、SQL 租约、独立子进程 RSS 看门狗、DOCX 真流式、Web 有界 chunk 缓存、增量首屏、Android 清单/续传/版本目录/配额均可用；跨实例等待会话与 **ready 产物**（共享 dataDir + catalog 时）均可按 sessionId 只读附着，**会话记录已只引用产物（新行不再持久化 model/fonts/baseUrl，v1/v2 读产物 document，layout_prefs 已持久化）**；仍缺「ready 所有权/对象存储、SQL/IO 关闭硬超时、精确目标硬件与 GB 正文压测」。
- **P3.5 可选 Redis 热缓存：最小实现已落地（约 86%）。** 方案 §5.1 的两条通道已接入：`cache-contract.ts`、最小 RESP2 客户端（socket/TCP/TLS、ACL、80 ms 单次预算、5 s 熔断）、`hot-cache.ts`（预览帧 `pv:{artifactKey}:{jobId}` 60 s / 进度 `job:{jobId}` 5 min、256 KiB 字段上限、200 ms 全局节流、失败即删两键、只做否定证据）、`catalog.activeJob` 跨节点 jobId 定位、`health.cache` 与 `genoffice_cache_*`；默认仍是 `memory`，未配置不建连接。真实 MySQL+Redis 用例覆盖「A 真实构建暂停/B 读首屏」「清空缓存仍 200 不伪装 ready」「Redis 不可达只降级」；新增慢而不死（超时+熔断 fail-fast）、同刻批量过期、单 key 热读用例，以及 `npm run cache:slo` 本地 SLO 演练（loopback 800 次：hitRate 1.0、p95 桶 1 ms、错误 0）。仍缺：目标硬件 SLO、主从切换与容量演练、Sentinel/Cluster（方案归 P4）。
- **P4 运维上线：过半。** GC、配额、备份清单/恢复演练门禁已在代码与隔离 MySQL 上验证；告警规则/仪表盘/runbook、catalog→local 回滚安全演练、`asyncSessionsV2` 进程级开关、按文件/租户 header 的 v2 灰度均已落地；仍缺真实告警路由与 on-call、自动放量、精确 8 核 16 GiB/GB 正文压测与恢复报告（本机 10C/16G 样本已记录）。
- **仍需注意的两个边界**：
  1. `artifactBackend` **默认仍是 `local`**；已补 `PARSE_SERVER_ARTIFACT_BACKEND=catalog`/`PARSE_SERVER_STORAGE_ADMISSION`/restore 门禁的 CLI 解析与真实子进程部署测试，但 catalog 仍不是默认部署形态，尚未做多实例共享目录的生产验收。
  2. **`parse_sessions` 旧列保留一个回滚窗口**（新行写 NULL，旧版本无法恢复新行会话，但产物与源仍在可重建）；ready 跨节点读取已支持共享 dataDir + catalog，客户端尚未上报/恢复阅读位置。

## 2. 计分（细项口径）

状态含义：**完成**＝代码已实现且仓库内有可执行回归（catalog 能力注明是否需显式后端）；**部分**＝主体在但缺关键子项或仅部分路径/环境验证；**未实现**＝方案要求的能力缺失。计分 = 完成 + 0.5 × 部分。

| 方案部分 | 条目 | 完成 | 部分 | 未实现 | 得分 |
| --- | ---: | ---: | ---: | ---: | ---: |
| §1 必须达到 | 5 | 4 | 1 | 0 | 90% |
| §2 优化前问题表 + limits bug | 10 | 8 | 2 | 0 | 90% |
| §3 目标结构 | 4 | 3 | 1 | 0 | 88% |
| §4.1 身份与指纹 | 6 | 6 | 0 | 0 | 100% |
| §4.2 目录与 manifest | 4 | 2 | 2 | 0 | 75% |
| §4.3 DTO 与资源引用 | 5 | 2 | 2 | 1 | 60% |
| §5 MySQL 索引与一致性 | 8 | 8 | 0 | 0 | 100% |
| §5.1 Redis 热缓存 | 11 | 7 | 4 | 0 | 82% |
| §6 状态/故障/调度 | 8 | 6 | 1 | 1 | 81% |
| §6.1 预算 | 11 | 8 | 2 | 1 | 82% |
| §7 HTTP 契约 | 7 | 6 | 1 | 0 | 93% |
| §8.1 Web | 7 | 6 | 1 | 0 | 93% |
| §8.2 服务端逐格式 | 4 | 2 | 1 | 1 | 63% |
| §8.3 Android | 10 | 7 | 2 | 1 | 80% |
| §9 保留/删除/GC | 10 | 5 | 5 | 0 | 75% |
| §10 拆分与迁移 | 5 | 4 | 1 | 0 | 90% |
| §11 验证与观测 | 14 | 7 | 7 | 0 | 75% |
| §12 默认假设 | 6 | 4 | 1 | 1 | 75% |
| **合计** | **135** | **104** | **25** | **6** | **86%** |

## 3. 阶段完成度（方案 §10 口径）

| 阶段 | 退出条件 | 判定 | 阶段得分 | 主要剩余 |
| --- | --- | --- | ---: | --- |
| P0 正确性 | 对应回归通过；保留现有接口行为 | **达成** | 100% | 无（`POST /v2/sessions/:id/heartbeat` 本轮已补，v1 行为不变） |
| P1 持久化基础 | 新会话和重启命中产物时解析启动数为 0 | **基本达成** | 96% | 六张表/关键列/依赖图/启动对账已落地；剩余 catalog 非默认部署形态与共享对象存储/多写入者生产验收 |
| P2 资源解耦 | 大任务排队不阻断缓存读取；客户端兼容迁移完成 | **基本达成** | 99% | ready 附着、pending waiter 崩溃接管、last-waiter 取消、关闭阶段硬超时与本地 500 会话基线已就绪；对象存储/无共享盘与多写入者生产验收未做 |
| P3 大文件与体验 | 大正文和弱网场景达标，记录峰值内存与首屏数据 | **主体达成** | 90% | 真实 GB 正文/弱网/峰值 RSS 曲线未验收；复杂 PPTX/DOCX round-trip 与保真未完成 |
| P3.5 可选热缓存 | 双实例 A 构建/B 读首屏；宕机/清空/变慢不影响 ready | **最小实现达成** | 88% | 两通道、memory 默认/回滚、health/metrics、慢而不死/批量过期/热 key 故障用例与本地 SLO 演练已具备；主从切换、容量演练与目标硬件 SLO 归 P4 |
| P4 运维上线 | 压测与恢复报告可复查，可回滚 | **过半** | 86% | 告警规则/仪表盘/runbook + Alertmanager 路由模板、跨实例备份/回滚 safety 测试、进程级 `asyncSessionsV2`、按文件/租户灰度、时间 ramp 与观测驱动自动暂停、本机 10C/16G 负载样本已落地；真实告警路由/on-call、精确 8C/16G 与 GB 正文压测、真实跨机器/介质与 MySQL 库恢复（独立目录演练已记录）、`nginx -t` 仍缺 |
| **整体（细项计权）** | | **未完成** | **73%** | 阶段包含的改动量差异很大（P3.5 明显小于 P0/P4），总完成度以细项计权为准，阶段表仅用于定位剩余工作 |

## 4. §1「必须达到」逐条

| 要求 | 判定 | 证据 | 缺口 |
| --- | --- | --- | --- |
| 同文件同版本并发只构建一份；历史与重启命中不重解析 | 完成 | `artifact-store.ts:742-826` 单飞；`artifact-catalog.ts:399-438` 唯一键 claim；`tests/artifact-preview.test.ts`「shares one PPTX parse…reopens after restart without parsing」（重启后 parse 0 次）；`tests/async-session.test.ts:73` | 跨进程共享只对非默认 catalog 后端成立 |
| 关闭页面/会话过期只释放临时状态，不删历史与共享产物 | 完成 | `server.ts:1092-1100`、`:2119-2127`；`tests/library.test.ts:46`（跨 TTL/GC/重启存活）；`tests/artifact-preview.test.ts` 删光会话后产物仍在 | 无 |
| 解析任务数与阅读人数分开限制；大任务排队时缓存文档可读 | 完成 | `parse-queue.ts:14-74`（并发+内存双闸）；`server.ts:735-738` 预占；`tests/pptx-session.test.ts:263`（3 并发/上限 1 → 201,429,429）；`tests/async-session.test.ts:117` | 无 |
| Web 与 Android 共享可版本化模型、资源引用与离线包契约 | 部分 | Web 走 v2 document/units 与 `artifactKey`；Android 走 `/v2/sessions/:id/bundle` 权威清单（`BundleDownloader.java:246-297`，bundleSchemaVersion=1、逐资源 size/SHA-256、external 清单） | Web 不消费 `bundle-manifest`/capabilities；资源用 path 而非 `assetId`（`BundleDownloader.java:388-405`）；两端契约命名不一致 |
| 下载失败、任务崩溃、磁盘写满、进程重启不能把半成品当成功 | 完成 | 校验+fsync+rename 后才 `complete`（`artifact-generations.ts:15-50`）；失败保留旧 ready（`artifact-catalog.ts:484-492`）；507/503 映射（`server.ts:1399`、`:350-351`）；`tests/artifact-preview-mysql.test.ts` 失败构建不留 ready；`tests/artifact-generations.test.ts` rename 后 sync 失败保留孤儿 | 真实断电与 OS 级崩溃未注入 |

## 5. 逐节核对

### 5.1 §2 优化前问题表
9 行问题中 7 行已修复、2 行部分；`bin.ts` 未设置 limit 以 `undefined` 覆盖默认值的问题已修（`limits.ts:23-34` 逐字段校验，`tests/limits.test.ts`）。
- 部分 1：默认原文件 TTL 仍按**上传时间**而非最后访问时间（`server.ts:1323` `now - Date.parse(createdAt)`）；显式保存的历史原件已不受 TTL 影响。
- 部分 2：Android 已从「全部完成才打开」升级为权威清单+续传+版本目录+部分离线标记（真机 33 项通过），但「在线首屏可用、后台下载」未实现。
- 另一处偏差：`layout=server` 旧排版会话仍按分钟续租（`tests/pptx-session.test.ts` 125 分钟用例），默认客户端模型会话已不再占服务端 worker。

### 5.2 §3 目标结构
HTTP 主进程做鉴权/流式上传/会话/调度，大 XML 解析与大型压缩在子进程：**完成**（`isolated-worker.ts`、`process-bootstrap.mjs`、`docx-worker.ts`）。解析落盘后子进程退出、缓存读取不起解析进程：**完成**（`tests/artifact-preview.test.ts:51` 断言 activeWorkers=0）。独立 Node 子进程 + RSS 采样看门狗 + Linux cgroup v2 入口：**完成**（`isolated-worker.ts:129-137,180-223,283-302`；`tests/isolated-worker.test.ts:27/40/51/68`），但 **Linux 内核 cgroup OOM 实测未做**（本机 Darwin）。

### 5.3 §4 数据身份与持久化格式
- §4.1：`fileId`=字节 SHA-256、`artifactKey` 输入仅 fileId/format/parserFingerprint/schemaVersion/options（`artifact-store.ts:37-55`）、拒绝 token/URL/sessionId（`artifact-session.ts:104-118,203-209`）：**完成**。构建指纹已哈希解析相关源码与 pnpm-lock（`parser-fingerprint.ts:7-36`），并新增 `scripts/build-fingerprint.mts` / `npm run fingerprint` 在构建时生成并注入 `PARSE_SERVER_BUILD_FINGERPRINT`（`--out` 记录、`--check` 校验），`bin.ts` 只读注入值：**完成**（`parserVersion` 默认仍 0.1.0，需发布流程传入）。options 由 `normalizeArtifactOptions()` 统一：缺省/null→`{}`、仅接受纯 JSON、`artifactKey` 的 canonicalJson 再统一键序，非法 options 直接拒绝：**完成**（当前模型 options 仍为空对象，扩容点已就绪）。布局缓存键已实现：`layout-key.ts` = sha256(artifactKey+rendererVersion+width+fontSetHash+measurementProfileHash)，v2 ready/document 暴露 `layoutKey`（width/fontSet/版本变化即换 key）：**完成**（渲染器/测量版本仍是代码常量，客户端尚未用它缓存）。
- §4.2：默认运行时布局仍是 `manifest.json + units.bin`（本地扁平、catalog 为 `g-N`）；新增 `canonicalArtifactExport` / `PARSE_SERVER_CANONICAL_ARTIFACT_EXPORT=1`（staged opt-in）在首次打开时于同一 generation 目录物化 `document.json`、`units/*.json`、`fonts/*.sfnt`、`external-media.json`，并提供 `artifact-export.ts` / `npm run artifact:export` 工具；manifest 已补 unitCount/fonts/warnings/dependencies。ArtifactReader/Writer 增量帧、大单元/单块上限、拒绝静默截断：**完成**。默认仍是 packed；sidecar 写入按字节走 storage reservation（不足则跳过），但写后目录不再严格不可变（仅新增只读文件）：**部分**。
- §4.3：`modelDto` 运行时拒绝非纯 JSON、AssetRef 有 id/kind/mime/sha256/partPath、签名与部署 URL 出站生成、外链媒体单列 external：**部分**。round-trip 覆盖已扩：DOCX image/font/table、5 页 PPTX 逐页 model/index、内嵌图片 PPTX、外链超链接 PPTX、最小 bar chart PPTX、chartEx funnel PPTX、组合形状 PPTX、自定义 theme scheme 色 PPTX、slide timing 动画 PPTX、嵌入字体 PPTX（均重启复用、不重解析）；新增渲染树等价用例：同一组合/主题/动画内容重启后 render tree 逐字节一致；新增真实浏览器像素等价演练：含主题色/组合/动画/图片的 slide 在 Chromium/WebKit 重启后 canvas PNG 逐字节一致，Firefox 下逐像素一致（`diffPixels=0`；Firefox 的 canvas PNG 编码跨页面实例不字节稳定，故判定改为逐像素）；新增双主题 deck（两套 master/layout/theme）round-trip；DTO 已独立版本化。仍缺：真实多设备像素回归与更广主题/字体矩阵；Android 无 `assetId` 抽象。

### 5.4 §5 MySQL 索引与一致性、§5.1 Redis
| 表 | 判定 | 证据与缺口 |
| --- | --- | --- |
| `parse_files` | 完成 | 保留原字段并新增幂等迁移的 `storage_state`/`verified_at`；上传提交写入 `stored` 与校验时间，重复上传只推进 `verified_at` |
| `library_entries` | 完成 | 新增迁移列 `library_scope='instance'`、`retention='saved'`、`deleted_at`；移除为软删除（保留墓碑、清空 `file_id` 以允许源 GC），列表/`hasFile` 过滤墓碑，30 天后启动清理；重复保存生成新的活跃行 |
| `parse_artifacts` | 完成 | `mysql.ts:105-122`：artifactKey 主键、state、generation、ready_generation、storage_path、manifest_sha256、bytes、unit_count、last_access_at、error_code |
| `parse_jobs` | 完成 | `mysql.ts:124-138`：唯一 artifact 行、attempt/generation/lease_owner/lease_until、(state,lease_until) 索引 |
| `parse_sessions` | 完成 | 迁移后新增 `format`/`artifact_key`/`expires_at`/`layout_prefs`，**新记录只写轻量字段**（旧 `base_url`/`model`/`fonts` 放宽为 NULL、不再写入，旧行仍可读回退）；GET/heartbeat 刷新 `expires_at`，v2 ready 暴露 `expiresAt`，v1/v2 的 model/fonts 从产物 document 读取；可选 `layoutPrefs` 经有界 DTO 校验后随 waiter 持久化并在 pending/ready 回显、重启恢复 |
| `artifact_dependencies` | 完成 | 新增 `parse_artifact_dependencies(artifact_key, dependency_type, dependency_id, created_at)`，主键去重、目标索引、目录行删除级联；`complete()` 同事务写入 `file` 依赖，离线包额外写 `artifact` 依赖到模型代次；`fileInUse` 把 `hasDependencyOnFile` 作为额外保守保护，GC 不再只看 FK |
- 事务去重、generation 单调递增与迟到写入拒绝、旧 generation 隔离、发布次序（fsync→rename→SQL ready）：**完成**（`artifact-catalog.ts:399-492`、`artifact-generations.ts:15-50`；隔离 MySQL 用例 `tests/artifact-catalog-mysql.test.ts`）。
- 启动对账：临时/staging/chunk 孤儿清扫、以及**「已落盘未登记」generation 目录的启动对账**均已实现——`generation-reconcile.ts` 在监听前扫描规范 `g-N` 目录，目录年龄超过 1 h 且该 artifactKey 无任何 catalog 行（building/ready）时删除；有行即保护，catalog 读取失败 fail-closed，工作有 500 key 上限并暴露到 `health.maintenance.startupReconcile`；失效 ready 指针仍由可选 restore 门禁/后台 repair 处理。
- **§5.1 Redis：最小实现已落地（77%）。** 新增 `cache-contract.ts` / `redis-cache-client.ts` / `hot-cache.ts` 三个模块与 `server.ts`/`bin.ts`/`runtime-options.ts`/`telemetry.ts` 接线：默认 `memory` 不建连接；`redis` 模式需 MySQL + `artifactBackend: 'catalog'`，镜像 `pv:{artifactKey}:{jobId}`（60 s、≤`previewMaxUnits` 单元、单字段 >256 KiB 抑制）与 `job:{jobId}`（5 min、200 ms 全局节流、done 强制、failed 删除）；`catalog.activeJob` 用 SQL 时钟定位构建中 job；`/v1/health.cache` 与 `genoffice_cache_*` 暴露命中/错误/超时/延迟/熔断。仍未达：SLO 实测、主从切换/容量演练、连接池与"模式热 key"压测；响应缓存/会话投影/分布式限流按方案未进入首版。

### 5.5 §6 状态、故障与调度、§6.1 预算
- **部分**：主动取消已独立为 `cancelled` 状态（`MysqlArtifactCatalog.cancel`：shutdown abort 记 `build_cancelled`，到期租约不能再 complete；租约丢失仍记 failed/`build_interrupted`）；崩溃/超限有稳定错误码与预算释放；**「仅对可恢复基础设施错误有限重试」已实现**（`retry-policy.ts`：13 个瞬时 FS/SQL 错误码按指数退避重试，默认 2 次、`PARSE_SERVER_BUILD_RETRY_ATTEMPTS` 可调，解析/损坏/租约/ENOSPC 不重试；`build-retry`/`artifact-coordinator` 共 6 项回归）；共享构建不随单视图关闭取消（`tests/artifact-coordinator.test.ts`）；**最后一个等待者取消已实现**（`last-waiter-cancel-mysql.test.ts`：保留其他读者、最后读者离开即丢弃构建），**「无等待者时取消未开始任务」已实现**（demand 信号贯通 coordinator/store/session，最后一个 waiter 离开才 abort，且先检查同 artifactKey 是否还有其他 pending viewer；只取消仍在 ParseQueue 排队的构建，abort 记 `cancelled`）；关闭阶段用 `shutdownDeadline` 给 parseQueue/coordinator/artifact drain/HTTP/gc/DB 加可配置硬超时（`shutdown-timeout.test.ts`）；重启已实现「扫描过期 lease 主动重排」（`recoverExpiredBuilds`：启动时把过期 building 任务置 queued、清 lease，保留 ready 指针，health 暴露 examined/requeued）。
- **完成**：队列满只拒新任务（429+Retry-After，`server.ts:2075`、`tests/async-session.test.ts:117`）；失败不覆盖 ready、损坏 compare-and-clear 自动修复（`artifact-catalog.ts:93-112`、`tests/artifact-corruption-recovery.test.ts`）。
- §6.1 数值：重解析并发 2、解析总 RSS 8 GiB、单任务 4 GiB、队列 20、会话 500、PDF Range 不占名额——**与方案一致**（`runtime-options.ts:30-59`、`server.ts:1986-2014`）。会话空闲 TTL 默认已从 15 分钟改为 **30 分钟**（`server.ts:2701`、`runtime-options.ts:114`），与方案一致；新增**按字节计量的模型读缓存**（`model-cache.ts`，默认 256 MiB，可 0 关闭）并暴露 2 GiB 聚合缓存预算（模型缓存被钳制在预算内；预览 2 MiB 与 reader 512 条仍各自独立计量）；新增 **HTTP 并发上限**（默认 128，超限 503 `server_busy`，health/metrics 豁免）；新增 **磁盘 I/O 与解压工作池**（`work-pools.ts`，disk 默认 32、inflate 默认 4，超限 FIFO 排队），`health.pools` 与 `work_pool_*` 指标暴露占用/排队/峰值；原文件/产物容量仍默认 20 GiB（`server.ts:1940`）。

### 5.6 §7 HTTP 契约
12 个 v2 端点全部可用：`POST /v2/files`、`/v2/library`、`/v2/sessions`、`GET .../document`、`.../units?cursor`、`.../units/:unitId`、`DELETE .../sessions/:id`、`GET/DELETE /v2/library`，以及本轮补齐的 `POST .../heartbeat`（200 `state`/`pollAfterMs`，未知 id 404，只续期轻量阅读会话，不碰构建租约/ready）。`bundle-manifest` 成为 `/bundle` 的正式别名（别名不带子资源）；`GET /v2/sessions/:id` ready 增加 `artifactKey`、终态 `progress`、`pollAfterMs: 0`、`complete: true`（v1 body 不变）；同一 artifact 的 in-flight catalog 构建会被新 waiter 通过 `catalog.activeJob` 复用为同一 jobId。`Idempotency-Key` 已接入 `POST /v2/sessions`（进程内有界回放、只缓存 2xx JSON、重放当前 ready/building 状态）；上传按内容寻址、library 按唯一文件引用天然去重。仍缺：幂等键不跨实例/重启、并发同键不合并；Web 不消费 capabilities。

### 5.7 §8 三端
- §8.1 Web 7 条：PPTX 默认客户端 Worker 读持久化模型、DOCX chunk 原子提交/去重/重试/锚点、有界 chunk LRU（8 MiB/128 条）、页范围索引、资源迟到重测——**完成**；**能力探测 + 格式策略集中**（`capabilities.ts` 超时/缓存/失败回退；`format-policy.ts` 按 capabilities 格式与 `thresholds` 工作，缺省 32/64/64 MiB）；**URL 导入流式计数**；**手动 server 默认远程，整文件本地排版仅显式 `docxLocalFallback=1` 且 ≤阈值**；**无法本地预览的大 DOCX 在读取文件前提示**——仅剩「资源签名在 PPTX 图片/字体上的刷新」为部分，见 `tests/capabilities.test.ts`、`tests/format-policy.test.ts`、`tests/fetch-limited.test.ts`、`tests/server-capabilities.test.ts`、`tests/capabilities-thresholds.test.ts`。
- §8.2 服务端逐格式：PPTX slim+openPptx 首阶段、DOCX 双遍流式（`docx-stream.ts`、每 200 块落盘、CRC/UTF-8/单块上限）、PDF 复用原文件+Range——**完成**；跨块编号/表格/修订/脚注/页眉页脚/分节的语义一致性验证**未覆盖**；加密文档入口已明确：`detect.ts` 识别 CFB/OLE 容器并返回 `encrypted`，上传返回 **415 `encrypted_document`**（消息含 password-protected，不落盘/不占预留），Web 端仍有本地 `isEncryptedDocx` 检测（`apps/viewer/src/web/docs.tsx:114`），但尚无口令输入/解密任务。
- §8.3 Android：第一阶段（仅 PPTX、权威清单、staging→complete→publish、续传 ETag/Content-Range/忽略 Range、artifactKey 版本目录、整包配额与清理、取消/空间预检/进度、失败保旧包/.previous）**完成**，本轮真机复跑 33 项通过（§7）；第二阶段仅部分（`offlineScope=partial` 标记与提示，**在线回源未实现**）；`assetId` 抽象未做（用 path/URL）；**PDF/DOCX 移动端闭环未实现**（`BundleDownloader.java:133-135` 拒绝非 pptx，方案本就另立任务）。

### 5.8 §9 保留、删除与 GC
- 显式保存原件不被 TTL/GC 删除：**完成**（`server.ts:1243-1255`、`tests/library.test.ts`、`tests/library-mysql.test.ts`）；**无库级配额**（`handleLibrary` 无条目/字节上限）。
- 历史文件当前产物压力下撤下并可重建：**完成（catalog）**（`artifact-ready-eviction.ts:53-235`、`tests/artifact-ready-eviction-mysql.test.ts`）；local 只在超 `maxStoreBytes` 时回收。
- 临时文件按最后访问 7 天：**部分**（按 createdAt 7 天；catalog 的 `last_access_at` 每次 pin/renew 写库，未合并）。
- 老解析版本、staging/失效残留按租约与宽限回收：**完成（catalog）**（`artifact-generation-sweeper.ts:121-160,239-248`、退役事务 `artifact-catalog.ts:366-397`）；local 仅按 1 h 年龄。
- 方案字面「deleting 状态、等读租约结束」：**语义等价但状态名与等待方式不同**（`reclaimed`+不可逆退役；活租约直接放弃、下轮再试）。
- 持久化≠备份：清单+演练+启动门禁+CLI 有，且清单已纳入**产物依赖图**（`dependencies`，MySQL 全表读取；生成前拒绝悬空边；恢复演练校验清单内与活动目录的 parent/目标，备份后新增边记 warning），相关测试覆盖篡改清单与真实 MySQL 依赖；但**演练仍以本机独立目录模拟异机**（`restore-drill.mts`：拷贝到第二个 dataDir、只读校验+restore 门禁、缓存重开零解析；篡改 source 失败关闭/篡改 artifact 仅告警），无真实第二台机器/外接介质、无 MySQL catalog 导出导入、无调度/保留策略，门禁仍未接 `bin.ts`。

### 5.9 §10 实施拆分与迁移
旧扁平产物与旧 flat 离线包两遍校验导入、DB 迁移只加列、按阶段独立 PR：**完成/部分**。分批开关现状：`artifactStore`（`PARSE_SERVER_ARTIFACT_BACKEND`）、`storageAdmission`、`cacheMode`、`asyncSessionsV2`、`v2RolloutPercent` 均有 CLI/env 开关并在启动前校验；`processWorkers` 已不适用（迁移后始终使用独立子进程，旧 worker_threads 入口已移除）。回滚顺序与本地演练（catalog→local 源码保护、async v2→v1）已有测试与 runbook；v2 可按文件确定性灰度/停量，但**自动放量、用户/租户级灰度与生产回滚演练**仍缺；`nginx -t` 未执行（本机无 nginx）。

### 5.10 §11 验证与观测
- 验收 1、2、3、4、5、9：**通过**（逐条对应测试见 §5 各节与 `tests/artifact-*-mysql.test.ts`、`tests/pptx-session.test.ts`、`tests/async-session.test.ts`、`tests/storage-temp.test.ts`、`tests/startup-reconcile.test.ts`）。验收 1 缺单一 HTTP 级「3 并发+上限 1+独立文件」组合用例。
- 验收 6（token、签名过期、换部署域名后刷新描述）：**部分**。Web 侧新增 `signed-url.ts`（解析 `exp/sig`、提前 60 s 判过期、检测部署 origin 变化）；DOCX 缓存 chunk、PPTX 音视频 mediaRef、以及 PPTX 模型页的 layout slide/source 在复用前检测过期并 `refresh` 重取描述（图片 `media` 引用一并更新）；服务端每次响应重签。真实浏览器 403/签名刷新已覆盖（Chromium/WebKit/Firefox 三引擎）；仍未覆盖：嵌入字体经 Authorization 的 token 轮换、换部署域名端到端验收（`resilience-validation.md` 的 12 小时限制仍需发布级验证）。
- 验收 7、8、10：**部分**（单测齐全但无「会话过期+锚点恢复」串联、无弱网/真机长时、无复杂 PPTX/DOCX round-trip 与关键页截图）；验收 8 本轮真机 33 项通过。
- 验收 11（Redis，仅启用时）：**部分**。真实 MySQL+Redis 用例覆盖双实例 A 构建/B 读首屏、清空/驱逐视为 miss、Redis 不可达仅降级；未覆盖主从切换、慢而不死 p99 与 SLO 判定（见 §7）。
- 指标：方案 §11 列出的新增指标已补齐——`artifact_hit/miss/corrupt`（health + 新计数器）、`parse_started`(health)、`job_queue_depth/age`、`deduplicated_waiters`、`worker_rss`、`reserved_bytes`、`unit_read_latency`（histogram）、`storage_bytes`（原文件/产物/staging 三项拆分 + 总览）、`gc_deleted_bytes_total`（源 TTL/淘汰 + legacy flat + sweeper 实删字节）、`signature_refresh_total`、`bundle_failure_total`、`model_cache_{bytes,max_bytes,entries,hits,misses,evictions,skipped}`、`http_{requests_in_flight,concurrency_limit,rejected_total}`、`work_pool_{limit,active,waiting,peak,peak_waiting}`、`build_retries_total{scope=local|shared}`，以及既有 `cache_*`。日志关联 requestId/artifactKey/sessionId，异步失败日志新增 `jobId`；query/sig/token/密码不入日志，脱敏达标。剩余：request 级日志仍无 jobId（请求阶段尚不知道 jobId），需在建立任务后再关联。
- 性能样本与 8 核 16 GiB 压测（2 冷解析+20 排队+50 并发缓存阅读、500 轻量会话、RSS≤12 GiB）：**部分**。新增 `scripts/load-profile.mts` 并在本机 10 核/16 GiB 采样：队列 2+20、冷 p95 6.7 s、热缓存阅读 p95 20.6 ms（解析增量 0）、冷/排队期阅读 p95 10.8 ms、health 最大 62 ms、500 会话 p95 73 ms、RSS 峰值 0.41 GiB，详见 `parse-load-profile.zh-CN.md`；未在精确 8 核/16 GiB 机型、GB 正文、MySQL/Redis 与真实磁盘/弱网下复跑。

### 5.11 §12 默认假设
单机/实例级历史库、首期 PPTX+DOCX 持久化+PDF 原文件复用、默认并发 2、已保存原件不按 TTL 删除：**符合**。Redis 为可选热缓存、单机默认 memory、未配置即关闭：**已按此实现**（`cacheMode` 默认 memory，未配置不建连接）。磁盘规格/配额/备份位置/目标延迟待定：**仍待定**。

## 6. 关键缺口（按影响排序）

1. **catalog/MySQL 仍不是默认部署形态**：代码默认 local；已支持 `PARSE_SERVER_ARTIFACT_BACKEND=catalog` CLI 启用、restore 门禁与真实子进程 env-only 启动/重启复用测试，但尚未做多实例共享目录的生产验收。
2. **多实例/跨节点闭环基本完成**：等待会话与 **ready generation** 均可从 MySQL 按 sessionId 只读附着；ready 附着、**pending waiter 崩溃接管**与 **last-waiter 取消**均已通过共享 dataDir + catalog 双实例测试（B 不重建已 ready 的模型、不抢活跃 lease；A 未发布即退出时 B 可接管，claim fencing 保证单赢家；最后一个 reader 离开时构建结果被丢弃）；关闭阶段有可配置硬超时；仍缺**共享对象存储/无共享盘**与 MySQL 多写入者共享目录的生产验收。
3. **P3.5 生产化**：本地 loopback SLO 演练（`npm run cache:slo --strict`：hitRate 1.0、p95 桶 1 ms、错误 0）与慢 Redis/批量过期/热 key 故障用例已具备，但目标硬件 SLO、主从切换/Sentinel/Cluster、`maxmemory` 容量演练、TLS/ACL 生产验证、告警与灰度仍归 P4。
4. **目标环境验收仍缺**：Linux cgroup v2 内核 OOM、精确 8C/16G 与 GB 正文压测（本机 10C/16G 样本与 RSS 曲线已记录，见 `parse-load-profile.zh-CN.md`）、弱网/长时、真实跨机器/介质与 MySQL 库恢复（独立目录演练已记录）、`nginx -t`；告警规则/仪表盘/runbook、本地回滚安全演练、进程级 `asyncSessionsV2`、按文件/租户 header 灰度、时间 ramp 与观测驱动自动暂停已落地，但真实告警路由/on-call 与生产回滚演练仍未做。
5. **客户端签名生命周期**：验收 6 已部分实现（DOCX 缓存 chunk、PPTX 音视频 mediaRef、PPTX 模型页 layout slide/source 均在 exp 过期/部署 origin 变化时重取；Web 已消费 capabilities）；服务端新增 `PARSE_SERVER_PREVIOUS_TOKEN` 认证重叠窗口；新增 `POST /v1/files/:fileId/part-url` 重新签发单个 part URL，Web 图片加载遇到 403 时刷新签名并重试一次。真实 Chrome smoke 已通过：过期 DOCX 会话 404/410/500 恢复、被淘汰 unit 重取、嵌入字体恢复/清理、延迟窗口取消；新增浏览器 403 演练：首个 part 请求返回 403 后仍渲染出与基线一致的 canvas 哈希（Chromium `8b5a01be…`、WebKit `87acf7f4…`、Firefox `diffPixels=0`）。仍缺音视频/字体 403 的专门浏览器断言与客户端 token 主动注入。
6. **契约剩余**：`Idempotency-Key` 已在 MySQL 下落到共享账本（跨实例/重启 replay、并发同键 pending claim 合并；file 模式仍进程内）；v1 兼容层的内部等待语义仍为固定超时；Web 已消费 capabilities/阈值。
7. **表结构/迁移收尾**：六张表、关键列、依赖图与启动孤儿 generation 对账均已落地；`parse_sessions` 旧 `base_url`/`model`/`fonts` 列保留一个回滚窗口；Web 已本地恢复 PPTX/DOCX 位置（DOCX 用源锚点而非页码，跨窗口按 cursor 有界预取最多 20 chunk），创建 v2 会话时回传 `layoutPrefs`，翻页/滚动停止后经 heartbeat 增量同步；服务端仍不按偏好定位首屏；失效 ready 指针默认由访问时 compare-and-clear/后台 repair 处理，restore 门禁为可选严格模式。
8. **§4 格式细节**：generation manifest 已补 `unitCount`/`fonts`/`warnings`/`dependencies`；v2 DTO 已独立版本化；构建指纹有构建脚本注入 + check；布局缓存键已实现并在 v2 暴露 `layoutKey`；artifact options 已统一缺省/键序/校验；仍无 `document.json`/`fonts/` 目录布局、复杂特性 round-trip 未验证。
9. **§6.1 预算缺口**：256 MiB 模型热缓存 LRU、HTTP 并发上限、磁盘 I/O 与解压工作池均已实现；2 GiB 聚合预算已配置但未把预览/reader 缓存统一计入，原文件/产物容量仍默认 20 GiB；会话空闲 TTL 已对齐 30 分钟。
10. **Android 在线回源**：仅部分离线标记，无「未缓存资源在线取、断网明确提示」；`assetId` 抽象缺失。
11. **观测/日志**：方案 §11 指标已补齐（既有 `cache_*` + 本轮 `unit_read_latency`/`job_queue_age`/`gc_deleted_bytes`/`bundle_failure`/`signature_refresh`/`artifact_miss/corrupt`/storage 三项拆分）；异步失败日志已带 jobId，request 级日志仍只能关联 requestId/artifactKey/sessionId。

## 7. 本轮复跑与验证（2026-11-10）

本轮在隔离真实 MySQL 9.7.1 + 隔离 Redis 8.8 上复跑（各自私有 socket/datadir，MySQL `--skip-networking`；未访问用户数据库；结束时清理）。parse-server 本轮新增独立目录/异机式恢复演练脚本与报告；viewer 与 Android 本轮无改动，其数字来自同日上一轮。

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| parse-server 默认全量 | `cd apps/parse-server && npm run test` | **86 文件通过 / 26 跳过；464 通过 / 87 跳过（共 551）**，21.23 s |
| parse-server + 真实 MySQL/Redis 串行全量 | `PARSE_TEST_MYSQL_SOCKET=… PARSE_TEST_REDIS_SOCKET=… npx vitest run --no-file-parallelism` | **112 文件 / 551 项全部通过，无跳过**，139.92 s |
| 模型读缓存字节预算（新增） | `vitest run model-cache model-cache-server` | **8 项通过**：按字节 LRU 淘汰/超大跳过/同键更新/0 预算禁用；HTTP 重复读命中且 `bytes <= maxBytes`；小预算不越界；`/v1/health.memoryCache` 与 `/metrics` 暴露统计 |
| HTTP 并发上限（新增） | `vitest run model-cache-server` | **1 项通过**：单 handler slot 被占时 `/v1/capabilities` 返回 503 `server_busy` + `Retry-After`，`/v1/health`、`/metrics` 仍 200，释放后恢复 |
| 磁盘 I/O / 解压工作池（新增） | `vitest run work-pools work-pools-server` | **6 项通过**：limit=2 时 5 任务峰值并发 2 且 `peakWaiting=3`、异常释放槽位、非法 limit 拒绝；server 级 disk/inflate=1 时 4 个并行 unit 读全部 200，`health.pools`/`work_pool_*` 暴露 limit=1、peak≤1 |
| 可恢复错误有限重试（新增） | `vitest run retry-policy build-retry artifact-coordinator` | **9 项通过**（3+3+3）：瞬时 FS/SQL 错误分类与指数退避；local 构建重试并清空 staging；catalog 构建二次 claim 新 generation 后成功且 `stats.retries=1`；解析错误不重试；重试预算耗尽后失败 |
| cancelled 状态（新增） | `vitest run artifact-coordinator artifact-catalog-mysql` | **2 项通过**：shutdown abort 调用 `cancel('build_cancelled')` 且不调用 fail；真实 MySQL 下 `parse_jobs.state='cancelled'`、无 ready 时 artifact 为 `cancelled`、旧租约 `complete=false`、下一次 claim generation 递增 |
| 无等待者取消排队预览（新增） | `vitest run artifact-source-build preview-cancel async-session` | **新增 4 项通过**：catalog 共享构建排队时 demand abort → `cancel('build_cancelled')` 且不启动 worker；local store 同样取消排队构建；同 artifact 还有其他 waiter 时不取消、最后一个才 abort、不同 artifact 不受影响；双 viewer 共享构建回归通过 |
| 重启过期 lease 重排（新增） | `vitest run artifact-catalog-mysql lease-recovery-startup-mysql` | **2 项通过**：过期任务 → queued/lease 清空、artifact queued、活跃 builder 不受影响、再次 claim generation+1、ready 指针保留；真实启动 catalog server 后 health `{examined:1,requeued:1}` 且 SQL 状态为 queued |
| 目标负载样本（新增） | `npm run load:profile -w @genoffice/parse-server` | **本机 10 核/16 GiB**：队列 2/20、冷 p50/p95 3.5/6.7 s、热阅读 p95 20.6 ms 且解析增量 0、冷/排队期阅读 p95 10.8 ms、health max 62 ms、500 会话 p95 73 ms、RSS 峰值 0.41 GiB；未在精确 8C/16G 与 GB 正文复跑 |
| 独立目录恢复演练（新增） | `npm run restore:drill -w @genoffice/parse-server` | **通过**：清单 9 条目拷贝到第二 dataDir 后只读校验+门禁 ok、缓存重开解析增量 0、unit 一致、历史库 2 条；篡改 source → `source_size_mismatch` 失败关闭；篡改 artifact → 仅告警（可重建） |
| 加密容器入口（新增） | `vitest run library` | **14 项通过**，含 1 项：CFB/OLE 头文件上传返回 415 `encrypted_document`、消息含 password、`tmp` 为空、`reservedBytes=0` |
| 会话 TTL 30 分钟 + 续期 | `vitest run pptx-session session-record-mysql` | 12 项 + 真实 MySQL 1 项通过：125 分钟续期/20 分钟空闲过期（显式 15 min 用例）、新会话 `expires_at=last_used+30 min` |
| 新增缓存定向用例 | `vitest run cache-contract cache-mode hot-cache redis-cache-client cache-redis-mysql` | **54 项通过**（5 + 3 + 20 + 23 + 3）；`redis-cache-client` 含真实 socket 用例，`cache-redis-mysql` 为真实 MySQL+Redis 双实例 |
| parse-server 类型检查 | `npm run typecheck -w @genoffice/parse-server` | 通过 |
| 新增契约/部署定向用例 | `vitest run v2-contract idempotency deployment-options` | **34 项通过**（4 + 16 + 14） |
| 部署/会话/跨实例定向用例 | `vitest run deployment-e2e cross-instance-journal-mysql session-record-mysql` | **4 项通过**（2 + 1 + 1）；真实子进程 + 真实 MySQL，含 env-only catalog 重启复用与旧表列迁移 |
| 观测定向用例 | `vitest run observability` | **3 项通过**：unit 读延迟/queue age/bundle/signature/artifact 计数、GC 实删字节、队列等待时长 |
| 缓存故障/SLO 演练 | `vitest run cache-slow-redis cache-fault-matrix` + `npm run cache:slo --strict` | **2 项故障用例通过**（慢 Redis 超时+熔断、批量过期/热 key）；loopback 800 次：hitRate 1.0、p95 桶 1 ms、错误/超时 0 |
| 可观测资产校验 | `vitest run observability-assets` | **3 项通过**：告警引用的 metric 必须在 telemetry 中存在、每条告警带 severity/runbook、dashboard JSON 合法且 metric 已知、runbook 含回滚关键词 |
| 回滚安全演练（真实 MySQL） | `vitest run rollback-mysql` | **1 项通过**：catalog→local 回滚 + TTL 0 GC 后，保存文件与仅会话文件的原件都仍可下载、历史库条目仍在、generation 目录未被本地 GC 触碰 |
| 分阶段回滚开关 | `vitest run async-sessions-switch` | **2 项通过**：`asyncSessionsV2=false` 时 v2 会话 404 + capabilities 声明 false、v1 全流程可用；默认开启且非布尔值启动前拒绝 |
| §5 表结构列（真实 MySQL） | `vitest run schema-columns-mysql` | **1 项通过**：`library_scope`/`retention`/`deleted_at` 写入、软删除隐藏且清空文件引用、重复保存复活、30 天后墓碑清理；`parse_files.storage_state='stored'` 与 `verified_at` 写入 |
| 备份依赖图 | `vitest run backup-manifest backup-manifest-dependencies-mysql` | **5 项新增通过**（4 + 1）：依赖写入与恢复 ok、篡改清单悬空边被拒、live 新增边 warning、生成清单前拒绝悬空边；真实 MySQL 模型+离线包后清单含 `file`/`artifact` 边且 `verifyRestore` ok |
| ready 跨节点附着（真实 MySQL） | `vitest run cross-node-ready-mysql` | **1 项通过**：A 构建 `buildsStarted=1`，B 共享 dataDir+catalog 读到 ready 且 unit 内容一致、`buildsStarted=0`；B 仅新增派生 bundle 构建；无共享盘时保持 404 |
| v2 灰度 | `vitest run v2-rollout rollout` | **6 项通过**（4 + 2）：0% 全 404；50% 文件分桶；100% 正常；租户 header 稳定且缺失回退 fileId；自动 ramp 启动为 0/封顶/非法值拒绝；分桶确定性 |
| 观测驱动自动暂停 | `vitest run canary-guard` | **4 项通过**：样本不足不暂停、超阈值暂停/冷却到期、窗口过期清理、默认关闭/非法参数；真实 server 的 health 状态与启动前拒绝 |
| 告警路由模板 | `vitest run observability-assets` | **4 项通过**：告警规则 metric 对齐、dashboard JSON、runbook 回滚关键词、Alertmanager 路由/inhibit/receiver 模板与 README 引用 |
| v2 DTO 独立版本 | `vitest run dto-version` | **1 项通过**：capabilities/创建/pending/ready/document 均带 `dtoVersion` 与 `X-Genoffice-Dto-Version` 头；v1 创建无字段且无头 |
| 构建指纹注入 | `vitest run build-fingerprint` + `npm run fingerprint` | **1 项通过 + 脚本实跑**：同版本哈希稳定、64-hex、换版本变化；脚本输出指纹并写 JSON，`--check` 可校验注入值 |
| 布局缓存键 | `vitest run layout-key` | **2 项通过**：纯函数确定性/宽度/fontSet/版本变化；真实 server 640 与 1280 的 `layoutKey` 不同、document 与 ready 一致、v1 无字段 |
| artifact options 归一 | `vitest run artifact-store` | **19 项通过**（新增 1）：缺省/null→`{}`、纯 JSON 校验、非法值拒绝、键序不影响 artifactKey |
| 多页 PPTX round-trip | `vitest run artifact-roundtrip-pptx` | **1 项通过**：5 页 PPTX 重启后逐页 unit 完全一致、`sourceParsesStarted=0`、`PptxSession.open` 未调用 |
| 图片 PPTX round-trip | `vitest run artifact-roundtrip-pptx-image` | **1 项通过**：注入 PNG 的 slide 重启后 unit 签名 URL 归一化后完全一致、不重解析 |
| canonical 产物导出 | `vitest run artifact-export` | **2 项通过**：blank PPTX 导出 document/units/manifest；font.docx 导出 fonts/*.sfnt |
| 超链接 PPTX round-trip | `vitest run artifact-roundtrip-pptx-link` | **1 项通过**：外链 URL 写入 unit，重启后 unit 完全一致且不重解析 |
| 图表 PPTX round-trip | `vitest run artifact-roundtrip-pptx-chart` | **1 项通过**：最小 bar chart 重启后 unit 完全一致、不重解析 |
| 组合形状 PPTX round-trip | `vitest run artifact-roundtrip-pptx-group` | **1 项通过**：group 内子形状重启后 unit 完全一致、不重解析 |
| 主题 PPTX round-trip | `vitest run artifact-roundtrip-pptx-theme` | **1 项通过**：自定义 accent1 的 scheme 色解析为 FF00AA，重启后 unit 完全一致、不重解析 |
| 动画 PPTX round-trip | `vitest run artifact-roundtrip-pptx-animation` | **1 项通过**：带 presetClass 的 clickEffect timing 解析为 playback.animations，重启后一致、不重解析 |
| 嵌入字体 PPTX round-trip | `vitest run artifact-roundtrip-pptx-font` | **1 项通过**：embeddedFontLst + 裸 sfnt fntdata 的字体被解析，重启后 fonts 一致、不重解析 |
| chartEx PPTX round-trip | `vitest run artifact-roundtrip-pptx-chartex` | **1 项通过**：funnel chartEx 解析为图表（非 placeholder），重启后 unit 一致、不重解析 |
| 渲染树等价 | `vitest run artifact-roundtrip-render-equivalence` | **1 项通过**：组合/主题/动画内容重启后 layout 模型与 `buildRenderSlide` 渲染树完全一致 |
| 真实浏览器像素等价（Chromium/WebKit/Firefox） | `npm run test:pixel -w @genoffice/viewer`（`--browser`/`--width`/`--dpr`/`--device`） | **通过**：Chromium 1200 `8b5a01be…`、960 `39d89bf7…`、1280 `cc274e9a…`、960@2/1280@1.5 `3e3ba62d…`、Pixel 5 `75b9e886…`、iPad Mini `3902a9fe…`；WebKit 1200 `87acf7f4…`、960 `c40c51f0…`、Pixel 5 `7a732b32…`（均逐字节相等）；Firefox 1200/960 `byteEqual=false`/`pixelEqual=true`/`diffPixels=0`；各 case 重启前后一致、无 page error |
| 403 part 刷新（浏览器 + API） | `test:pixel --fail-first-part` + `vitest run part-url` | **通过**：首个 part 403 后刷新签名重试，Chromium 1200 哈希仍为 `8b5a01be…`，WebKit 仍为 `87acf7f4…`，Firefox `diffPixels=0`；API 返回可取的签名 URL，未授权 401、路径穿越 400 |
| 双主题 deck round-trip | `vitest run artifact-roundtrip-two-theme` | **1 项通过**：两套 master/layout/theme 的 slide 分别解析出 FF00AA/00AAFF，重启后一致、不重解析 |
| canonical sidecar 布局 | `vitest run canonical-layout` | **2 项通过**：opt-in 时 PPTX 生成 document/units/manifest、font.docx 生成 fonts/*.sfnt；默认关闭不生成 |
| catalog 产物导出 CLI | `artifact:export -- --catalog`（真实 MySQL + catalog） | **手工验证通过**：ready generation 1 → document.json/units/0.json/artifact-manifest.json，totalBytes 1951 |
| 真实 Chrome viewer smoke | `npm run test:library -w @genoffice/viewer` | **全链路通过**：历史库保存/重试/重启复用、DOCX 过期会话恢复、淘汰 unit 重取、嵌入字体恢复、延迟窗口取消；截图 `/tmp/genoffice-library-ui/library-flow.png` |
| token 轮换重叠窗口 | `vitest run token-rotation` | **1 项通过**：旧 token 仍可上传/开会话/取 unit/刷新签名 URL；错误 token 401；previous==token 或缺失 token 启动前拒绝 |
| pending waiter 崩溃接管（真实 MySQL） | `vitest run pending-takeover-mysql` | **1 项通过**：A 构建暂停时 B 只读且 `buildsStarted=0`；A 关闭未发布后 B 下次轮询接管并 ready，`buildsStarted=1`，unit 可读 |
| 关闭阶段硬超时 | `vitest run shutdown-timeout` | **2 项通过**：`ArtifactStore.drain` 永不 resolve 时 `close()` 仍在 150 ms 预算内返回；非法超时值启动前拒绝 |
| last-waiter 取消（真实 MySQL） | `vitest run last-waiter-cancel-mysql` | **2 项通过**：单读者 DELETE 后 pending 行删除、构建完成不落 ready、GET 404；双实例 A 删除后 B 仍 200 且构建继续到 B 侧 ready |
| 500 会话本地基线 | `npm run sessions:load -- --sessions 500 --strict` | **strict 通过**（file 模式）：500/500 ready、1 次共享构建、create p95 0.9 s、status p95 0.5 ms、RSS +103 MiB（约 211 KiB/会话） |
| 500 会话 MySQL+catalog 基线 | `sessions:load -- --mysql --catalog --strict`（隔离 MySQL） | **strict 通过**：500/500 ready、1 次共享构建、create p95 70 ms、status p95 0.6 ms、RSS +31.6 MiB（约 65 KiB/会话）；仍非目标硬件 |
| 500 会话双实例基线 | `sessions:load -- --sessions 500 --instances 2 --mysql --catalog --strict` | **strict 通过**：共享 dataDir+MySQL catalog，251/250 会话分配、1 次共享构建、create p95 75 ms、status p95 0.3 ms、RSS +38.7 MiB |
| 跨实例备份/恢复（真实 MySQL） | `vitest run backup-manifest-cross-node-mysql` | **1 项通过**：A 构建后 B 用自身 catalog 连接生成 manifest（含依赖边），A 侧 `verifyRestore` ok 且无错误 |
| 共享契约包 | `npm run test -w @genoffice/parse-contract` | **13 项通过**；parse-contract / viewer / parse-server 各自 `tsc --noEmit` 通过 |
| 产物清单元数据 | `vitest run artifact-store artifact-manifest-metadata` | **3 项新增通过**（2 + 1）：元数据 round-trip、非法 unitCount/dependency 拒绝；端到端模型清单 unitCount=1/字体/warnings，bundle 清单 dependencies 指向模型 key |
| 共享 Idempotency-Key（真实 MySQL） | `vitest run shared-idempotency-mysql` | **1 项通过**：双实例并发同 key 合并为同一 sessionId；第三实例 replay；重启后同 key 仍映射同一 session 且账本 body 落库 |
| 依赖图（真实 MySQL） | `vitest run artifact-dependencies-mysql`（+ 离线包用例断言） | **1 项通过**：`complete()` 同事务写 `file` 依赖、bundle 写 `artifact` 依赖、重复幂等、目录行删除级联清理；离线包 HTTP 用例断言两件产物各有 file 依赖且 bundle→model 边存在 |
| 会话布局偏好 | `vitest run layout-prefs layout-prefs-mysql` | **3 项通过**（2 + 1）：DTO 边界/任意 JSON 拒绝、v2 pending+ready 回显且 v1 不暴露、真实 MySQL `layout_prefs` 列写入与重启恢复 |
| 启动孤儿 generation 对账 | `vitest run generation-reconcile generation-reconcile-mysql` | **4 项通过**（3 + 1）：仅删除无 catalog 行的老化 g-N、年轻/有行/未知名字/符号链接保留、catalog 失败 fail-closed、上限与空 key/prefix 清理；真实 MySQL 启动接线与 `health.maintenance.startupReconcile` |
| 会话轻量化断言 | `session-record-mysql` + `pptx-session` 重启 + `server.test` DOCX 重启 | 新行 `model/fonts/base_url` 为 NULL；v1/v2 仍返回 model/fonts；重启后 `PptxSession.open` 未被调用 |
| 改动文件 ESLint / `git diff --check` | — | 通过 |
| viewer 全套（本轮改动） | `npm run test -w @genoffice/viewer` | **98/98 通过**（format-policy 6、fetch-limited 4、capabilities 9、signed-url 2、server-capabilities 5、docx-signed-refresh 2、pptx-signed-refresh 1、reading-position 4） |
| 阅读偏好增量同步 | `vitest run layout-prefs` + viewer heartbeat 用例 | **通过**：ready 后 heartbeat 更新 `{page:5}` 再 GET 回显一致，非法值 400；viewer 断言 heartbeat 路由/body |
| 阈值下发（服务端） | `vitest run capabilities-thresholds` | **1 项通过**：自定义 3/5/7 MiB 经 `/v2/capabilities.thresholds` 下发，默认 32/64/64 MiB，非法值启动前拒绝 |
| PPTX 签名刷新 | `node --test tests/pptx-signed-refresh.test.ts` | **1 项通过**：已加载页含过期图片 URL 时先向 worker 发 `refresh` 再重取该页描述，返回新 `exp` |
| Android instrumentation（上一轮，真机 AGS5-W00 / API 31） | `adb shell am instrument -w -e class com.genoffice.viewerdemo.BundleDownloaderTest …` | OK (33 tests)，23.246 s |

**Redis 联合用例实际覆盖**：①A 实例真实构建被暂停在 `unit:1` 之前，B 实例读到 `previewable`、`progress 1/2`、`units/0` 200 与 `units/1` 202，释放后由 catalog ready；②外部持有构建租约时跨实例读帧/进度；③删除（等价 FLUSHALL/驱逐）后仍 200 且不伪装 ready；④Redis socket 不可达时仅降级（正常 pending→ready、`health.cache.errors>0`、无 5xx）。未覆盖主从切换、慢而不死 p99 与 SLO 判定。

**复跑中修复一处测试夹具缺陷（非产品缺陷）**：`tests/storage-pressure-mysql.test.ts` 的共享压力用例三次上传 `createBlankPptx()`，而该 fixture 的 ZIP DOS 时间戳只有 2 秒粒度，同一窗口内字节相同 → 内容寻址去重成 1 个产物，用例却期望 3 个 ready，因此在我机器上稳定失败（`expected 0 to be 2`）。先用「3 个不同字节文件」独立复现产品语义：只撤下 1 个、只删 1 个代次、账本 `reclaimedBytes ≤ targetBytes`、剩余 2 个 ready——**产品行为正确**。随后把夹具改为按需等待时间戳跨窗（`distinctBlankDecks`），该文件与全量回归恢复通过。仓库内此修复、P3.5 实现与本文档均未提交，位于工作区。

未在本轮执行：ESLint/format 全量、viewer 与 Android 复跑（本轮无改动）、`nginx -t`、Linux cgroup、目标硬件压测、Redis 主从切换与容量演练。

## 8. 与进度文档的差异（需要修正或补注的自述）

- 「会话只引用产物」「parse_sessions 逐步移除 baseUrl 与完整 model/fonts 副本」：**新记录已达成**（新行不写副本，v1/v2 从产物 document 读取；旧行仍可读，旧列保留回滚窗口）；布局/阅读偏好尚未持久化。
- 「catalog/generation/SQL 目录表/租约已接入」：**成立但非默认**，默认部署仍 local；进度文档「当前限制」已自述，但「已完成」列表容易让人误以为生产 MySQL 路径已启用。
- 「P0/P1 已完成」：**成立**；P0 的心跳端点本轮已补，P1 仍缺 `artifact_dependencies` 表（用读租约/fork 表达依赖）。
- 「358 项全通过」：更早轮次口径；一次复跑曾为 357/358，原因是测试夹具时间戳去重（已修），不是产品回归。本轮累计为 **551/551**（默认套件 464 通过 + 87 跳过；带真实 MySQL+Redis 112 文件无跳过）；viewer 100/100。
- 进度文档「下一步」第 3 条仍把 Redis 与最后等待者取消并列；两者均已落地（P3.5 最小实现 + `last-waiter-cancel-mysql`），剩余是 SLO/主从切换/容量演练与无等待者时取消未开始任务。
- 进度文档中「最近验证」日志多为 11-07/11-09，且部分早于 HEAD；本轮提供了 HEAD 上的完整复跑证据（§7）。

## 9. 口径与局限

1. **完成 = 代码在仓库中 + 有可执行回归**；不把「文档声称」「组件存在」算完成。需要 MySQL/Redis 的项只在隔离实例上验证，未在用户环境执行。
2. 「部分」不折算为更大比例：按 0.5 计权，避免把「有骨架」当「能用」。
3. 总完成度以细项计权为准（76%）。§10 的阶段表用于定位剩余工作而不做等权平均：阶段改动量差异很大（P3.5 从 0 到最小实现会让等权值剧烈跳变，P0/P1 的少量契约缺口也会被摊薄），等权平均不再作为结论。
4. **P3.5 是"可关闭的最小实现"口径**（方案明确的 P3.5 交付边界）：单 Redis、两条 key、TLS/ACL 支持与降级；SLO 实测、Sentinel/Cluster、容量演练属于 P4，不计入 P3.5 完成度。
5. 本评估不判定部署环境事实：磁盘规格、配额/备份位置、目标延迟、生产实例数、真机容量/弱网/长时稳定性均未验证，方案 §12 自述这些「尚待部署信息确定」。
6. 改动集中在 parse-server 与 viewer：P3.5 缓存三模块与接线、v2 heartbeat/bundle-manifest 别名/ready 字段、Idempotency-Key（进程内）、部署 env 解析与 bin 接线、跨实例等待会话只读附着与 ready 产物懒加载、`parse_sessions` 的 artifact_key/expires_at/format/layout_prefs 迁移与会话轻量化、方案 §11 观测指标补齐、告警规则/仪表盘/runbook、catalog→local 回滚安全演练、历史库软删除与来源状态列、artifact 依赖图、启动孤儿 generation 对账、capabilities 阈值下发与 Web 读取前预检，以及 README/文档。幂等缓存是单进程内存、不是分布式账本；remote waiter 只读附着没有租约/所有权；ready 跨节点读取依赖共享 dataDir；客户端尚未上报阅读位置——这些是部分实现。如需以 HEAD 为基线继续，应先复核并提交工作区改动（`git status` 见仓库）。

## 10. 建议的下一批可做项（按性价比）

1. **P3.5 生产化**：把 `npm run cache:slo --strict` 移到目标实例做 SLO 基线，补 Redis 主从切换/`maxmemory` 容量演练，并把 `deploy/observability` 告警接入真实路由；v2 已可按文件/租户 header 灰度并按时间 ramp、按错误率自动暂停（P4）。
2. **catalog 部署验收**：在真实 MySQL 上仅用 `PARSE_SERVER_ARTIFACT_BACKEND=catalog` + `MYSQL_*` + `PARSE_SERVER_RESTORE_MANIFEST` 启动，跑真实 HTTP/重启/多实例流程；补恢复门禁的生产演练。
3. **跨节点会话接管**：等待会话与 ready 产物（共享 dataDir + catalog）均可按 sessionId 只读附着；构建实例未发布即退出时另一实例可接管 pending waiter；last-waiter 取消已按 durable reader 实现（保留其他读者、最后读者离开即丢弃构建）；关闭阶段有硬超时兜底；下一步是共享对象存储/无共享盘与跨实例 DELETE/GC 协调。
4. **会话记录收尾**：新行已只引用产物，`layout_prefs` 已持久化并回显；Web 已本地恢复 PPTX/DOCX 位置、创建时回传并经 heartbeat 增量同步翻页与锚点（DOCX 跨窗口最多预取 20 chunk）；下一步让服务端按偏好定位首屏，并在 v1 兼容路径退役后清理 `base_url`/`model`/`fonts` 旧列（当前保留回滚窗口）；用 500 会话压测验收轻量语义。
5. **Web 剩余**：嵌入字体 token 轮换与真实浏览器 403/换域名验收（DOCX chunk、PPTX 音视频、PPTX 模型页图片/parts 均已刷新）；契约侧：幂等键改为可跨实例/重启的共享账本并合并并发同键，v1 兼容层内部等待改为可配置超时。
6. **客户端签名刷新收尾**（验收 6）：PPTX 图片/parts 已接入刷新；剩余嵌入字体 token 轮换与真实浏览器过期/换域名端到端验收。
7. **目标环境脚本与报告**：精确 8C/16G 与 GB 正文压测（本机 10C/16G 样本已记录）、Linux cgroup OOM、跨机器恢复演练；接入真实告警路由/on-call，补生产回滚演练（本地告警资产、回滚安全测试、按文件/租户灰度、时间 ramp 与错误率自动暂停已就绪）。
8. **仍按方案"待评估"**：响应缓存、会话状态投影、分布式限流，不进入首版。
