# 三端测试、精简映射与验收指南

更新日期：2026-11-12。范围为 `apps/viewer`、`apps/parse-server`、Android Demo 及其测试/演练辅助代码；共享解析与契约包仅检查依赖与覆盖关系，不删减其测试；共享渲染包另包含一处已复现的视频单击双重切换修复。

功能与交互见[架构主文档](runtime-workflows.zh-CN.md)，产品与验收边界见[运行边界](runtime-boundaries.zh-CN.md)。本文记录本轮实际结果，保留失败与复验记录，不能用历史报告替代。

新增业务样本登记见 [南宁天桃实验（2026-11-16）](samples/nanning-tiantao.zh-CN.md) 与[私有样本清单](samples/business-corpus.json)。新增样本的复测单独记录，不改写下文历史验收统计。

## 1. 精简标准与覆盖关系

每项删除或合并必须保留目标行为、输入差异、故障阶段和关键断言。逐项快照见 [742 项用例前后映射](test-case-map.json)，包含原路径、新路径、具名行为、输入与故障设置代码范围、关键断言行号、共享辅助函数定位和常规测试结果（133 项 Web、564 项服务端、45 项 Android，不含独立演练）；它是本轮快照，不代表后续新增测试已自动纳入。行号按本轮最终测试源码记录，参数场景还保留参数定义定位；完整断言文本索引在证据目录的 `coverage-detailed.json`，不把这些定位信息当作语义覆盖率百分比。用例数量不作为删减目标；不同层次的单元、HTTP、真实数据库、浏览器和设备验证不相互替代。

### 1.1 服务端模型往返场景

下列 10 个原测试文件统一到 `apps/parse-server/tests/artifact-roundtrip-pptx.test.ts` 的 10 个具名参数场景；源文档生成移到 `tests/helpers/roundtrip-pptx-fixtures.ts`。除保留主文件外，删除 9 个被完整替代的测试文件。独立的 `artifact-roundtrip-render-equivalence.test.ts` 保留。

| 原文件后缀（`artifact-roundtrip-*.test.ts`） | 新场景键    | 保留的专属断言                        |
| -------------------------------------------- | ----------- | ------------------------------------- |
| `pptx`                                       | `multiple`  | 5 页均有模型，每页重启后相同          |
| `pptx-image`                                 | `image`     | 图片 part 路径存在，资源描述稳定      |
| `pptx-link`                                  | `link`      | 外链目标完整保留，不被 URL 归一化掩盖 |
| `pptx-chart`                                 | `chart`     | 图表模型仍在                          |
| `pptx-chartex`                               | `chartex`   | chartEx 数据标记仍在                  |
| `pptx-group`                                 | `group`     | 组合结构仍在                          |
| `pptx-theme`                                 | `theme`     | 指定主题颜色仍在                      |
| `pptx-animation`                             | `animation` | 动画列表非空并往返一致                |
| `pptx-font`                                  | `font`      | 嵌入字体家族与字体描述仍在            |
| `two-theme`                                  | `twoThemes` | 两页各自主题颜色均正确                |

每个场景独立启动、上传、读页、关闭、重启和清理；均检查重启后未重新调用源解析器、health 的新源解析计数为零。对首读和重读均执行专属断言。只归一化本服务生成的 part URL 的 origin 与短期签名参数，外链和资源路径仍精确比较。

### 1.2 其他精简与测试设施修复

| 范围               | 处理                                                              | 保留的覆盖 / 修复依据                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web Fetch 替身     | 5 个文件共用 JSON 响应工厂                                        | HTTP 状态、凭据、会话状态、队列拒绝与错误断言保留                                                                                                             |
| Web 模型会话       | 两个文件共用临时字体加载钩子和 Worker RPC 探针                    | 125 分钟模拟续期、并发去重、关闭后拒绝、逐页释放及签名刷新各自保留                                                                                            |
| DOCX 签名刷新      | 新鲜/过期两场景参数化，保留两个原具名用例                         | 初次 URL、第二次 URL 与实际读取次数均检查                                                                                                                     |
| 服务端样本路径     | 共用包根目录，移除测试对调用者工作目录的依赖                      | npm workspace 和仓库根目录直接指定 Vitest root 都能定位同一批样本                                                                                             |
| 服务端清理栈       | 27 个测试文件共用固定所有权的 LIFO 清理                           | 先快照本用例资源，再异步清理，错误仍抛出；避免超时后误清理下一用例的数据库                                                                                    |
| 服务端退出钩子     | 钩子预算覆盖服务 30 秒退出期限；独立捕获服务器/目录集合           | 测试执行超时仍为 20 秒；正常退出、硬超时与损坏回归不删除                                                                                                      |
| Android 原生测试   | 公用私有临时目录、HTTP 与文件工具                                 | 原 4 个测试类、45 个测试方法全部保留，Runner 的真实服务探针保留                                                                                               |
| Android 设备脚本   | 公用显式设备选择、ADB、WebView 连接所有权与关闭、USB 映射恢复     | DOCX/PDF/PPTX 各自的格式检查、PDF 冷启动和离线隔离保留；同步与异步 ADB 按宿主服务是否需要响应选择；就绪判断核对 fileId 和在线/离线 origin，避免读取上一个页面 |
| Android 离线旧断言 | 只接受本地 v1 重放对可选能力探测/心跳的预期 404/405               | 新增成功建立本地 v1 会话的要求；其他失败、外部资源请求和页面异常仍失败                                                                                        |
| 浏览器脚本端口     | 动态端口允许选空闲端口；业务/媒体脚本可用 `VIEWER_TEST_PORT` 隔离 | 不停止其他开发服务，默认命令及默认业务端口保留                                                                                                                |
| 资源库重排探针     | 增高量按纸张高度计算，保证超过末页剩余空间                        | 继续要求可见重排、源块锚点恢复及去掉样式后恢复原高度                                                                                                          |
| 媒体脚本退出状态   | 播放报告包含失败时返回非零退出码                                  | 保留静音解码、seek、Range、预览和放映断言，不能以报告已写出代替通过                                                                                           |
| GB 压测判定        | 增加可选严格模式、鉴权及真实 Range 字节检查                       | 不能用脚本仅打印状态、退出 0 代替验收；显式指定部署预期的会话状态，媒体留盘后按精简包预算判定，当前该 1 GiB 媒体样本应为 201                                  |
| 静态发布检查       | 删除恒为真的末尾断言                                              | 文件存在、无 Node 服务和无 PM2 残留等实际检查全部保留                                                                                                         |

未发现可仅凭名称判为无效的独立风险用例，因此不删除 MySQL/Redis、多实例、源码一致性、下载完整性或长稳用例。样本无引用不等于可以删除；本轮未移除共享包或业务样本。

## 2. 前后统计与验收口径

| 测试层                  | 精简前                                | 精简后已确认                                 |
| ----------------------- | ------------------------------------- | -------------------------------------------- |
| Viewer                  | 38 个用例文件，133 项通过             | 38 个用例文件，133 项通过                    |
| 服务端常规本机          | 115 个用例文件；474 通过、90 依赖跳过 | 106 个用例文件；474 通过、90 依赖跳过        |
| 服务端真实依赖          | 常规基线未运行这 90 项依赖测试        | 完整 564 项通过，0 失败、0 跳过              |
| Android Instrumentation | 4 个测试类及 Runner，45 项通过        | 4 个测试类及 Runner，另有公共基类；45 项通过 |

10 个模型往返测试文件原为 877 行，统一后的具名场景和源文档 helper 合计 511 行，减少 366 行。其余触及文件按仓库 Prettier 规则格式化，部分旧长行展开，因此总行数不能直接表示精简量；本轮不以行数或用例数作为删减目标。

三端未配置统一的行/分支覆盖率百分比门槛，本轮不宣称该百分比已测量或维持不变；必要覆盖通过上述场景映射、具名用例、专属断言与分层复跑验证。测试通过数量相同本身不是全部覆盖依据。

## 3. 环境、隔离与常规命令

命令在仓库根目录执行；Node、Chrome、Android SDK/Java 复用当前项目环境，不新增测试框架。根目录 `npm test` 不包含 Viewer 专属命令，Viewer 必须单独运行。

```sh
npm test -w @genoffice/viewer
npm test -w @genoffice/parse-server
npm run typecheck -w @genoffice/viewer
npm run typecheck -w @genoffice/parse-server
npm run package -w @genoffice/viewer
npm run test:standalone -w @genoffice/viewer
npm run test:ui -w @genoffice/viewer
npm run test:library -w @genoffice/viewer
npm run test:pixel -w @genoffice/viewer
npm run test:performance -w @genoffice/viewer
```

Android 的原生测试与真实 WebView 验证是两层。先打包 Viewer，再构建 `:app:assembleDebug`、`:app:assembleDebugAndroidTest` 并安装；使用明确的 `ANDROID_SERIAL` 运行：

```sh
adb -s "$ANDROID_SERIAL" shell am instrument -w \
  com.genoffice.viewerdemo.test/com.genoffice.viewerdemo.BundleTestRunner
npm run test:android-backend -w @genoffice/viewer
npm run test:android-docx -w @genoffice/viewer
npm run test:android-pdf -w @genoffice/viewer
npm run test:android-media -w @genoffice/viewer
```

后三项分别需要 `ANDROID_WORD_INPUTS`、`ANDROID_PDF_INPUTS`、`ANDROID_MEDIA_INPUTS` 指向上传后生成的具名 fileId 清单，另设 `PARSE_SERVER_URL`、`PARSE_SERVER_TOKEN` 和各自证据目录。输入清单在本轮临时证据目录保留。测试不清空应用数据，结束恢复原 USB reverse/forward 映射。

### 3.1 真实 MySQL/Redis

复用 `apps/parse-server/deploy/validation/compose.yml` 与 `compose.media.yml`，使用独立项目 `genoffice-test-cleanup`。本轮专用覆盖文件把 HTTP 端口改为 **19787/19788**，保留已有开发环境；测试容器使用本轮测试文件和 Vitest 配置的只读挂载。业务/媒体浏览器脚本使用 `VIEWER_TEST_PORT=11029`，并在 CORS 中同时保留 11019 与 11029。媒体 Python 脚本依赖 `defusedxml`，本轮在仓库外临时 venv 安装 0.7.1，不修改项目依赖。

```sh
export EVIDENCE_DIR=/tmp/genoffice-test-cleanup-20261112
# compose.override.yml 的本轮内容：
# services:
#   app-a:
#     ports: !override ['127.0.0.1:19787:8787']
#     environment:
#       PARSE_SERVER_ALLOWED_ORIGINS: http://127.0.0.1:11019,http://127.0.0.1:11029
#   app-b:
#     ports: !override ['127.0.0.1:19788:8787']
#     environment:
#       PARSE_SERVER_ALLOWED_ORIGINS: http://127.0.0.1:11019,http://127.0.0.1:11029
docker compose -p genoffice-test-cleanup \
  -f apps/parse-server/deploy/validation/compose.yml \
  -f apps/parse-server/deploy/validation/compose.media.yml \
  -f "$EVIDENCE_DIR/compose.override.yml" up -d --wait mysql redis
```

首次缺少媒体基础镜像时，先按[隔离验证环境说明](../apps/parse-server/deploy/validation/README.md)构建 `Dockerfile.media`。本轮完整真实依赖套件的复现入口为：

```sh
docker build -f apps/parse-server/deploy/validation/Dockerfile.media \
  -t genoffice-media-validation:local .
docker compose -p genoffice-test-cleanup \
  -f apps/parse-server/deploy/validation/compose.yml \
  -f apps/parse-server/deploy/validation/compose.media.yml \
  -f "$EVIDENCE_DIR/compose.override.yml" build tests
docker compose -p genoffice-test-cleanup \
  -f apps/parse-server/deploy/validation/compose.yml \
  -f apps/parse-server/deploy/validation/compose.media.yml \
  -f "$EVIDENCE_DIR/compose.override.yml" run --rm \
  -v "$PWD/apps/parse-server/tests:/workspace/apps/parse-server/tests:ro" \
  -v "$PWD/apps/parse-server/vitest.config.ts:/workspace/apps/parse-server/vitest.config.ts:ro" \
  tests
```

使用该 Compose 配置运行 `tests` 服务，向其注入隔离的 `PARSE_TEST_MYSQL_SOCKET` 和 `PARSE_TEST_REDIS_SOCKET`。测试创建并清理自己的随机数据库，不能连接用户数据库；只运行本机常规套件会跳过这些场景。本轮 Docker VM 实际为 10 个 vCPU、约 7.75 GiB 内存，不是 8 核/16 GiB 专机。`load-profile.mts` 为 22 个冷任务及 500 个轻量读者显式设置 `maxParseJobs=2`、`maxQueuedParseJobs=20`、`maxSessions=800`，不把演练准入上限当成部署默认值。

### 3.2 业务与媒体回归

- `test:docx-reading`：包含业务课时计划、不同列行距、长表格、嵌套/合并、脚注尾注、分节、双栏、重复表头和边框样式。
- `corpus-drill.mts`、`docx-semantic-drill.mts`、`corpus-browser.mts`：使用用户指定的课件与教案目录，原文件只读；覆盖跨实例复用、语义与浏览器实际读取。
- `media-transcode-drill.py`：扫描和转换业务内嵌媒体，生成合成编码变体；`media-playback-drill.mts`、`media-ui-drill.mts` 验证浏览器解码、状态和错误入口。
- Android 三格式在线/离线脚本在后端不可达时读取本地资源，检查尾页、资源、字体和错误；静音媒体检查不认证音质。

## 4. 完整长测矩阵

按最新要求，三个长稳模式各连续运行 3600 秒（1 小时），保留独立结果，可以使用独立进程、端口并行采样；容量测试在三个长稳都结束后执行，避免把竞争环境的数据作为容量基线。

```sh
SOAK_SECONDS=3600 VIEWER_TEST_PORT=11027 \
  RESILIENCE_REPORT=/tmp/soak-desktop.json \
  node --import tsx apps/viewer/scripts/resilience-smoke.mts
SOAK_SECONDS=3600 MOBILE_VIEWER=1 VIEWER_TEST_PORT=11028 \
  RESILIENCE_REPORT=/tmp/soak-mobile.json \
  node --import tsx apps/viewer/scripts/resilience-smoke.mts
SOAK_SECONDS=3600 RESILIENCE_REPORT=/tmp/soak-android-offline.json \
  node --import tsx apps/viewer/scripts/android-offline-smoke.mts
```

| 场景                  | 入口与固定验收条件                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web 桌面/移动视口长稳 | 各 3600 秒，50 页；连续采样、快速跳页、动画不中断、无异常，检查保留堆增长                                                                                   |
| Android 离线长稳      | 3600 秒；关闭测试后端后重载与放映，检查外部请求、翻页、JS 堆和主进程 PSS                                                                                    |
| 1 GiB 媒体上传/读取   | `stress-smoke.mts --size 1G --sessions 4 --strict --expect-session-status 201`；流式上传、Range、完整下载长度及每块内容校验；精简包超限另由 limits 回归验证 |
| Android 1 GiB 下载    | 原生 `testOneGiBAndFailedReplacement`；检查长度、首尾字节及坏更新保留旧包，包含在 45 项原生测试中                                                           |
| GB 级真实正文         | `body-fixture.py` 生成约 1.12 GB 的 `document.xml`，`body-load-drill.mts` 验证首/中/尾 chunk、健康与内存；不是用未引用媒体填大压缩包                        |
| 冷队列与缓存阅读      | `load-profile.mts`：2 个执行、20 个排队、50 个缓存读者及 500 个轻量会话；保留业务 parts，必要的不同源身份只改变 ZIP comment                                 |
| 500 会话与多实例      | `session-load.mts --sessions 500` 的 local、MySQL/catalog、双实例变体；真实依赖套件另覆盖竞争与接管                                                         |
| Redis 热缓存          | `cache-slo-drill.mts` 的 2000 次请求、并发 8；真实 Redis，不把内存替身当网络故障验收                                                                        |
| 弱网                  | `weak-network-proxy.mjs` 增加 200 ms 延迟与每响应 128 KiB/s 下行限速，再执行浏览器业务读取；记录此模拟范围                                                  |
| 转码恢复              | `media-recovery-drill.mts --allow-kill`：只允许本地验证容器；检查 warm cache、SIGKILL 后同 job 接管与 Range 206                                             |
| 备份恢复              | `restore-drill.mts` 加 catalog/卷恢复验证；副本损坏须拒绝就绪，源环境保留；不宣称物理异机                                                                   |
| 内核 OOM              | 在独立 512 MiB、private cgroup 的验证容器中运行 `cgroup-drill.mts`，检查错误码、OOM 计数与子进程退出                                                        |
| 告警                  | `promtool check rules` 与 `test rules` 检查现有告警及测试规则                                                                                               |

1 小时长稳样本包含图片、跳页和动画，不含嵌入音视频播放器；长稳在单击修复前已完成。媒体事件修复后另跑 `resilience-renderer`、静态发布和实际媒体交互回归，短回归不计入长稳时长。

本轮是在原 7500 秒进程运行期间收到时长调整：监督程序在每组最后一个通过断言的连续采样达到 3600 秒后，关闭该组专属测试浏览器或停止测试 App，让原脚本执行资源与设备映射清理。原始退出码及关闭引发的异常保留在 `soak-*.run.json`，修订时长的验收另存 `soak-*-1h.json` 和 `soak-*-1h.run.json`，不把原始 7500 秒运行标为自然完成。新运行直接使用上面的 3600 秒命令。

1 GiB 用例使用合成全零 part，只验证传输/下载完整性，不是可播放视频样本；真实解码另由业务媒体和编码样本验证。1 GiB 媒体样本的 PPTX 含 ZIP 开销，原文件共 1,073,751,569 字节，超过 Viewer 的本地 1 GiB 预检上限。本轮通过服务端 API 验证上传和完整媒体读取，不代表该文件能从 Web 本机文件入口导入；Android 原生 1 GiB 用例验证下载器，不能代替 GB 级 Office 排版。

GB 正文样本由 65,536 个合成段落组成，1.12 GB 指实际 `word/document.xml` 字节量，不是 GB 级业务原件。该演练只验服务端流式提取、首/中/尾 chunk 和缓存阅读，不声称浏览器完成了 GB 全本排版，也不声称 Android 的 2 GiB 单包预算一定能容纳其全部离线产物。

完整命令参数、输入与每次退出状态保留在本轮证据中。只销毁本轮创建的容器、数据库和临时样本；不能运行无项目范围的 Docker 全局清理。

## 5. 本轮结果与证据

本轮主机为 10 核、16 GiB；Docker VM 为 10 vCPU、约 7.75 GiB。业务负载容器限 8 vCPU/6 GiB，服务实例 A 为 8 vCPU/4 GiB、B 为 2 vCPU/2 GiB；这些配额共享同一 VM。浏览器为 Chrome 157.0.8103.78，设备为华为 AGS5-W00 / Android 12（API 31）/ WebView 114.0.5.302。详细配置见 `environment.json`。

统一证据目录：`/tmp/genoffice-test-cleanup-20261112/`。大体积样本、截图和业务内容不加入仓库。阶段命令、环境、墙钟耗时和退出码在各 `*.run.json`；早期常规套件的 runner 耗时及汇总在 `unit-evidence.json`，不伪造额外墙钟计时。Android CLI 指向的完整 Gradle 日志已复制为 `android-*-build-gradle.log`。

| 项目                                 | 当前结果                                                                                                                                 | 证据                                                                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewer 常规                          | 133 项通过，0 跳过                                                                                                                       | `viewer-final.log`、`viewer-tests-renderer.log`、`unit-evidence.json`                                                                                         |
| 服务端常规                           | 474 通过，90 依赖跳过                                                                                                                    | `server-final-local.log`                                                                                                                                      |
| 真实 MySQL/Redis                     | 564 通过，0 失败、0 跳过                                                                                                                 | `suite.json`、`server-final-real.log`                                                                                                                         |
| Android 原生                         | 精简前后均 45 项通过                                                                                                                     | `android-baseline-tests.log`、`android-after-tests.log`、`android-tests-renderer.log`                                                                         |
| 类型、lint、生产包与 APK             | 通过；最新 70 个改动源码/测试定向 lint 通过                                                                                              | `*-typecheck.run.json`、`viewer-types-renderer.run.json`、`lint-delivery-complete.run.json`、`package-renderer.run.json`、`android-build-renderer-gradle.log` |
| 静态发布、UI、资源库、像素等价、性能 | 通过；页码探针已修正，新媒体修复另通过短回归与静态发布                                                                                   | `standalone`、`ui`、`library-reflow`、`pixel-isolated`、`web-performance-globals`、`resilience-renderer`、`standalone-renderer` 的日志和 `*.run.json`         |
| 三个 3600 秒长稳                     | 通过：桌面 3614 秒、移动 3613 秒、Android 离线 3605.736 秒                                                                               | `soak-*-1h.json`、`soak-*-1h.run.json`                                                                                                                        |
| 冷队列、500 会话、Redis SLO          | 合成/业务负载、local/catalog 单双实例及真实 Redis 严格检查通过                                                                           | `load-synthetic.json`、`load.json`、`sessions-*.json`、`redis-slo.json`                                                                                       |
| 1 GiB 服务端媒体传输                 | 上传、HEAD、Range 及完整 1,073,741,824 字节下载内容检查通过                                                                              | `stress-1g-recheck.log`、`stress-1g-recheck.run.json`                                                                                                         |
| GB DOCX 正文与缓存阅读               | 1,119,671,617 字节正文约 52.1 秒 ready；首/中/尾 chunk、50 次缓存阅读通过，104 次健康探测无错误                                          | `body-fixture.log`、`body-load.json`                                                                                                                          |
| 业务文件与跨实例再开                 | 11 份文件解析及 peer 重开通过                                                                                                            | `corpus-a.json`、`corpus-b.json`                                                                                                                              |
| 业务浏览器与 DOCX 阅读               | 浏览器 29 个采样：14 无警告、15 字体替代提示；DOCX 16 个场景通过，业务文件 5 页                                                          | `corpus-browser/report.json`、`docx-reading/browser-report.json`                                                                                              |
| 弱网代理读取                         | 通过，字体替代提示保留；只模拟 API 响应延迟与每响应下行限速                                                                              | `weak-browser/report.json`、`weak-proxy.log`                                                                                                                  |
| 媒体转换、解码与准备 UI              | 26 个业务资源转换及完整解码通过，2 个视频轨/色彩范围修正已定向复验；状态/错误/重试 UI 通过                                               | `media/transcode.json`、`media-repair-range-*.run.json`、`converter-negative-result.json`、`media-ui/`                                                        |
| 共享放映播放器点击                   | 通过；原文件、转换副本及 6 个编码样本的点击持续播放检查通过，原始失败保留                                                                | `media-browser-*-kind-renderer.*`、`codec-browser-renderer.*`、`media-controls-fixed.json`                                                                    |
| 转码强杀恢复                         | 通过：同 jobId 由 B 接管，约 54.3 秒恢复，Range 206                                                                                      | `media/recovery.json`                                                                                                                                         |
| Android 后端与真实三格式             | 通过；后端探针、16 组 DOCX、业务 PDF 全 4 页、11 份音视频样本/32 个媒体对象在线与离线；最终 APK 实际触控检查通过，1 份对象不可达警告保留 | `android-backend.run.json`、`android-docx/`、`android-pdf/`、`android-media-final-validation.json`                                                            |
| 备份恢复、OOM、告警                  | 通过；独立卷/数据库恢复、损坏副本启动拒绝、源卷复查、内核 OOM 及规则检查                                                                 | 各独立报告与日志                                                                                                                                              |

### 5.1 失败修正与保留证据

| 问题                                   | 处理与有效断言                                                                                                                                                                      | 证据                                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 退出钩子及迟到清理                     | 对齐服务 30 秒退出期限，钩子设为 35 秒；测试执行超时仍为 20 秒。先固定本用例资源所有权，再完整清理，错误仍抛出                                                                      | 早期服务端失败日志、最终 `suite.json`                                                                                       |
| 工作目录与端口依赖                     | 样本从模块位置定位；动态端口允许自动选择，业务/媒体前端用专用端口                                                                                                                   | `server-root-invocation`、`pixel-isolated` 及各 `*.run.json`                                                                |
| 资源库与性能探针假设过期               | 重排增高量保证超过末页剩余空间；性能跳页用当前可见缩略图按钮，仍保留旧版可见 select 路径及全部像素/图片/虚拟化断言                                                                  | `library-reflow.*`、`web-performance.*`、`web-performance-controls.*`、`web-performance-globals.*`                          |
| 1 GiB 会话预期错误                     | 媒体留盘，预算针对精简包，应返回 201；严格检查完整上传、Range 与全量下载内容，失败也清理本轮会话。没有放宽服务端限额                                                                | 首次 `stress-1g.*` 与 `stress-1g-recheck.*`                                                                                 |
| 派生媒体误按 WAV 声明丢弃视频          | 两段实际 H.264/AAC 源在派生副本中保留有效视频；纯音频仍用 MP3。全范围源显式归一 TV 范围以得到 yuv420p；新增 `--only-sha` 定向复验，失败返回非零并保留原因                           | `media-before-kind-fix/`、`media-repair-range-*.run.json`、`converter-negative-result.json`                                 |
| 共享视频单击双重切换                   | Chrome 原生 controls 与自定义切换叠加，出现播放后立即暂停；Viewer 共享放映层取消这次原生默认动作。断言同时要求时间推进和未暂停，原生进度条及播放按钮仍通过检查                      | `media-before-renderer-fix/`、`media-controls-fixed.json`、最终 `*-renderer.*`                                              |
| Android 触控探针准备阶段未等 seek 完成 | 记录到跳回 0 秒后 `readyState=1`、`seeking=true`；现在按既有 10 秒 seek 预算等到已暂停、已就绪且不再 seeking，再取实时触点。播放推进断言保持；独立实际 APK 探针及最终逐文件复验通过 | `android-before-touch-recheck/`、`android-before-seek-await/`、`native-seek-inspect.json`、`android-click-fixed-probe.json` |

Android 最终媒体验收合并了同一新 APK 下 **3 份完整在线/离线检查点**与 **8 份定向复跑**，不是把失败整轮改记为通过。`android-media-final-validation.json` 校验 11 个唯一 fileId、全部 32 个媒体的 Range/解码、断网与外部请求、在线/离线触控推进及实际安装 APK 哈希；`android-media-final/device-results.json` 保存合并后的逐文件结果。完整失败日志和命令仍保留。

### 5.2 验收警告与证据使用

- 业务浏览器 29 个采样中，14 个无警告、15 个有字体替代提示，涉及 5 份 PPT。页面、HTTP 和字体加载错误为零；替代字体不计作原字体保真。
- `4a2c58f80c544adc9f6113ed5932610d.pptx` 的媒体对象无法直接触控。组件事件探针能够播放并保留警告，不算该对象真实触控可达；其余 10 份样本的触控路径通过。
- DOCX 复杂合并区域、字体度量及与历史飞书基线的换页差异仍见[运行边界](runtime-boundaries.zh-CN.md)。本轮未重新读取飞书编辑页面。
- `post-matrix.json` 只汇总本轮选用的阶段与复用证据；原始负例、已修复失败和受控结束的 7500 秒记录不混入最终通过数量。完整命令、耗时和退出状态以各 `*.run.json`、`unit-evidence.json` 为准。

### 5.3 证据索引与环境收尾

`verification-index.json` 汇总最终采用的 37 个矩阵阶段、9 份常规套件记录、三组一小时长稳、构建与质量检查，以及负例、警告和原始失败所在位置。索引引用实际命令、配置、耗时和退出状态，不重新计为一次执行。

验证结束后，对已停止写入的源实例保存 catalog 快照、SQL 与 1,996,402,207 字节的数据卷压缩副本，路径与 SHA-256 见 `final-backup-result.json`。独立卷/数据库恢复已先前实测；最终这份归档仅完成一致性备份和校验，未再做第三次归档还原。随后删除本轮两个 Docker 项目的容器与卷，保留备份、日志和其他开发服务；`cleanup-result.json` 记录清理结果。

清理后再次冷启动 Android，后端实际不可达，指定课时计划仍从本地完整遍历 5 页，无外部资源，USB 转发恢复到运行前状态；证据为 `final-offline-word-verified.json`、`final-offline-word.png` 与 `final-offline-word-traverse.run.json`。此前收尾探针把虚拟化 DOM 数量当成总页数、又误用本地阅读器页码控件，失败记录保留；最终改用已验证的逐页遍历方式，未修改阅读器。11 份业务原文件的 SHA-256 均与上传记录相同，见 `originals-readonly-verification.json`。

## 2026-11-16：统一 API v1 的补充验证

当前接口定义见 [API v1](./api-v1.zh-CN.md)。本轮开始时基线为 Viewer 136 项通过、服务端 474 项通过且 90 项依赖测试待补验；不要将前文 11 月 12 日的历史统计当成本轮结果。

- `async-contract.test.ts`：统一就绪字段、心跳、幂等及清单断言，覆盖幂等重试、模型/渲染树表示、权限和 CORS 检查。
- `async-rollout.test.ts`：保留文件/租户确定性灰度、爬坡和开关断言，使用 v1 + Prefer 请求异步模式。
- 其余异步调用迁到 v1 请求模式；同步回归保留，签名资源鉴权仍有独立断言。配置冲突和异步开关禁用生效另有覆盖。
- Android 下载器、Web 会话/能力/资源库和演练脚本全部使用 v1；原生 HTTP fixture 用 Prefer 区分异步拒绝与同步重试，保留 429 不回退的要求。
- 浏览器资源库脚本同步到当前 DOCX 连续阅读 DOM；重启复用检查等待正式 ready，避免用增量首屏代替完整产物发布。缓存回访、错误重试、取消、字体、尺寸变化与锚点断言保留。

命令、耗时、退出状态和原始失败记录统一保存在 `/tmp/genoffice-api-v1-20261116/`；最终通过项汇总见 API v1 文档末尾。覆盖清单中的接口与用例名称统一按当前 v1 整理，历史断言行号与测量结果保留。

## 2026-11-16：Android 服务端目录与默认浅色

本轮增加 `file-list.test.ts` 两项 HTTP 回归（鉴权、空目录、已保存/未保存文件、同时间游标分页、删除后继续读取、重启），以及 `library-mysql.test.ts` 的真实 SQL 文件目录场景。Android 增加三项 `ServerDocumentsTest`（认证与路径/游标编码、错误/重定向/非法响应、在途取消）和一项主题默认值/系统模式回归，保留既有原生断言。

证据目录 `/tmp/genoffice-android-documents-20261116/` 保存 `*.run.json` 命令、耗时与退出状态，`*.log` 原始输出，`final-ui.json` 及对应页面 JSON/设备截图。`verification-index.json` 汇总 11 个最终阶段、原始未通过尝试及收尾校验，`cleanup.json` 记录已安装 APK 与最终构建哈希一致、连接偏好/网络/USB 映射恢复。结果：

| 检查              | 本轮结果与证据                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务端常规套件    | 480 通过、91 依赖测试跳过；`server.*`。跳过不计通过                                                                                                                          |
| 真实 MySQL        | 隔离 Compose 项目 `genoffice-android-documents-20261116` 执行 `library-mysql.test.ts`，12 通过、0 跳过；`mysql.*`。只补验相关数据库套件，未重跑全部 Redis/媒体/多实例矩阵    |
| 静态检查          | parse-server `tsc --noEmit`、修改 TS 文件 ESLint/Prettier、`git diff --check` 通过                                                                                           |
| Android 构建/测试 | `android build '<android-demo绝对路径>?:app:assembleDebug' -- :app:assembleDebugAndroidTest`；应用和测试 APK 构建、保留数据安装通过；`native-final.log` 明确 `OK (50 tests)` |
| 列表与在线预览    | 实机刷新、20 → 25 条分页；课时计划 DOCX、南宁天桃 PPTX、生成 PDF 从列表进入在线顶层预览，无 iframe、主题 light；`final-ui.*`                                                 |
| 下载与离线        | 本轮重新下载 DOCX/PDF；PPTX 使用既有校验缓存。移除两项远程 USB 映射且关闭 Wi-Fi/移动数据，三格式冷启动本地预览成功；页面记录的 API 请求均为本地；`final-*-offline-cold.*`    |
| 主题与空/错误目录 | 深色、跟随系统（设备当前为日间）、浅色选择在进程重启后保留并作用于预览；无效令牌显示 HTTP 401，独立空服务显示暂无文档；`theme-ui.*`                                          |

设备为 HUAWEI AGS5-W00 / Android 12 / WebView 114；服务使用仓库当前源码与独立文件存储目录。PDF 是一页生成样本。此次验证目录、主题及导航，不重跑全部媒体播放、复杂排版或长稳；PPT 首次播放前暂停定位的既有边界仍见[预览入口说明](preview-entry.zh-CN.md)。业务原文件只读。

前两次原生测试因设备残留的系统文件选择窗口未完成 Activity 启动而中止；日志保留，不能用 ADB 返回 0 计为测试通过。关闭该窗口后原生全量通过，最终 APK 又完整复跑 50 项。浅色状态栏和实际正文就绪后移除原生加载遮罩也在最终 APK 实机截图中核对。

主题 UI 首次探针在点击后立即强停进程，未等待选择事件完成；保留 `theme-ui-first.*` 失败。改为确认已选中再强停，三种选择的持久化及预览全部通过。验证结束恢复运行前的连接偏好、网络和 USB 映射，主题留为浅色；只清理本轮私有服务与 Docker 项目，证据和离线缓存保留。此轮未重启日常使用的 8787 服务进程，实际使用新增列表接口需重新加载服务端代码。

## 2026-11-17 上游迁移回归

上游 v0.13.18 合并、私有包迁移及本轮证据见 [迁移记录](upstream-v0.13.18-migration.zh-CN.md)。Android Word 脚本现按连续只读阅读验证；PDF 离线 Range 探针按统一入口的同源默认值定位 API。历史分页验收保留其当时范围，不替代当前连续阅读回归。

## 2026-11-17 PDF 单页失败隔离

独立 Viewer 的私有 PDF 渲染包已接入上游页面探测逻辑：探测或绘制失败的页面保留原页码及占位，其他页面继续阅读。探测失败时沿用前一正常页的尺寸，首个正常页出现前使用 A4 尺寸。表单、链接批注、文字搜索、自动目录、元数据和书签读取分别容错；文字层失败时保留已完成的页面位图。切换文件会取消旧文档的后续扫描并丢弃迟到结果。

`pnpm --filter @genoffice/viewer test:pdf-isolation` 需要先启动 Viewer Vite 开发服务，默认地址 `http://127.0.0.1:11042/`，可用 `VIEWER_PDF_ISOLATION_URL` 指定；通过本机 Chrome 运行。`VIEWER_PDF_ISOLATION_OUTPUT` 指定证据目录，默认 `/tmp/genoffice-pdf-isolation/`。

本轮 Viewer 159 项单元测试、类型检查及独立包构建通过。浏览器 9 个场景通过：真实损坏的三页 PDF（中间页引用缺失对象）、正常文件、绘制失败、辅助信息失败、元数据持续等待、文字层失败、全部页面不可读、探测期间切换文件、整个文件无效。其中真实损坏文件直接经过 PDF.js；其余异常通过测试传输层注入，不修改生产代码。验证包括正常页实际位图与文字、原始页码、跳页及旋转、搜索跳转和无未处理异常。报告与截图保存在上述临时证据目录。

本轮内置浏览器连接超时，使用本机 Chrome 回归；未重新执行 Android 实机验收。此改动不涉及服务端解析契约和原桌面 PDF 应用。

## 2026-11-17 PDF 大文件首屏、内存与加密回归

Viewer 打开时只等待第一页尺寸，其他页面按阅读位置探测，初始占位沿用第一页尺寸；实际尺寸到达时保持当前阅读位置。表单、批注只保留阅读窗口的数据，文字目录只在请求目录时扫描。URL 加载启用按需 Range，关闭自动预取和连续整文件流；无 Range 支持时仍能完整下载并打开。原始文件数据、PDF.js 内部缓存、字体和解码资源不等于页面位图预算，不能把此预算视为进程总内存上限。

页面位图每页最多 800 万像素，常驻窗口总预算 2400 万像素，同时最多两个页面渲染任务。缩小时按像素开销保留更多小页面，窗口最多 32 页，避免固定三页限制使同屏页面空白。离开窗口、取消绘制、替换位图和关闭文档时显式释放画布；取消文字层并清理 PDF.js 页面资源。大型图像使用 PDF.js 的 32 MiB 图像画布配置进行缩放处理，不通过丢弃图像限制内存。

开发服务启动后运行 `pnpm --filter @genoffice/viewer test:pdf-runtime`。可设置 `VIEWER_PDF_RUNTIME_URL`、`VIEWER_PDF_RUNTIME_OUTPUT`，默认服务地址 `http://127.0.0.1:11042/`，证据目录 `/tmp/genoffice-pdf-runtime/`。设置 `VIEWER_PDF_BASELINE_REF=846bb46e` 可附加旧 PDF 入口对照：脚本临时加载该提交的入口，共享本轮私有渲染器，结束删除临时模块。此对照针对打开路径，不是完整旧版本运行时或生产容量测试。

受控样本为 240 页、15,828,980 字节的带批注 PDF，通过真实本地 HTTP Range 服务读取。一次对照记录首屏前应用请求页面数由 240 降至 2，全书文字扫描为 0 次；服务端实际发送字节由 4,425,716 降至 362,484。首屏检查（位图已有实际内容且文字层完成）由 963 ms 至 889 ms，包含浏览器启动页面和测试等待开销；样本和网络条件有限，不据此推算生产加速比例。另验证远距离跳页、混合页面尺寸、缩放往返、离屏画布像素归零、页面清理、无 Range 回退及 4096×4096 图像实际绘制。

加密回归使用既有 qpdf/LibreOffice/pypdf 样本及测试生成的 R6 文件，经真实 PDF.js 和 Viewer 打开，覆盖 RC4、AES-128、AES-256、用户密码、所有者密码、空用户密码、错密后重试、首次取消、错密后取消和取消后重新打开，共 13 个场景。生成器只用于测试，未进入 Viewer 生产包；测试密码不写入生产存储。内置浏览器仍连接超时，本轮使用本机 Chrome，未重跑 Android 实机。

最终检查：Viewer 163 项单元测试、9 个单页失败隔离场景、上述运行时与加密场景、三格式浅色/深色和移动尺寸 UI 回归、类型检查、ESLint、格式及独立包构建均通过。对照数据保存在证据目录的 `comparison-846bb46e.json`，最终运行时验证为 `report.json`；本轮临时开发服务已关闭。
