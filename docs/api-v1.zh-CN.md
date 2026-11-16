# 三端 API v1

正式 HTTP 入口统一为 `/v1`。Web、Android 下载器、Android 本地重放和仓库演练脚本均使用 v1，服务端返回的 Location、资源 URL 与离线包 href 也使用 v1。

## 请求模式与数据表示

| 行为                       | v1 请求                                                   | 返回                                                        |
| -------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| 能力探测                   | `GET /v1/capabilities`                                    | `contractVersion=1`、`dtoVersion=1`；通过 features 判断能力 |
| 上传、原文件与媒体         | `/v1/files/...`                                           | 鉴权、签名、Range 和转码任务                                |
| 异步打开                   | `POST /v1/sessions`，头 `Prefer: respond-async`           | 冷任务 202；排队/构建状态轮询同一 v1 路径；缓存命中 201     |
| 同步打开                   | `POST /v1/sessions`，不带 Prefer                          | 同步创建并返回 201；Android 本地重放使用此模式              |
| 状态、增量模型、位置与取消 | `/v1/sessions/:id`、`/document`、`/heartbeat`、DELETE     | pending/ready、首屏预览、读者租约和布局偏好                 |
| PPT 渲染树单页             | `GET /v1/sessions/:id/units/:unitId`                      | 完整会话默认返回渲染树，支持字宽反馈                        |
| PPT 布局模型单页           | `GET /v1/sessions/:id/layout/slides/:unitId`              | 供客户端 Worker 排版                                        |
| 增量模型单元               | `GET /v1/sessions/:id/units/:unitId?representation=model` | ready 返回布局模型；构建中提供已提交单元，未就绪返回 202    |
| 权威离线包                 | `/v1/sessions/:id/bundle`、`/bundle/resources/...`        | 只允许清单声明的资源                                        |
| 历史库                     | `/v1/library`                                             | 保存、游标列表和移除引用                                    |

## 已上传文档列表

`GET /v1/files?limit=20&cursor=<next>` 与上传/读取接口使用相同 Bearer 鉴权。limit 为 1–100，默认 20；游标不可自行构造，下一页直接传回响应的 next。响应设置 `Cache-Control: private, no-store`：

```json
{
  "items": [{
    "fileId": "<64位sha256>", "sha256": "<64位sha256>", "format": "docx",
    "size": 1234, "createdAt": "2026-11-16T00:00:00.000Z", "displayName": "课时计划.docx"
  }],
  "next": "<可选游标>"
}
```

列表包含全部现存上传文件（包括未入历史库的文件），按 createdAt 倒序、fileId 升序做游标分页。名称优先取有效历史库记录，否则为格式及 ID 前缀。删除历史库引用不会立即删除文件；文件过期或被删除后不再列出。列表读取不触碰正文、创建会话或更新保留时间，翻页不是数据库快照，新上传文件需刷新后查看。非法参数返回 400，鉴权失败返回 401。MySQL 使用有界查询及批量名称读取；文件存储模式扫描元数据文件后分页。

## 异步模式与版本字段

Web 和 Android 仅在异步创建明确返回 404/405 时，移除 Prefer 后同步重试同一个 v1 地址。能力声明 `asyncSessions=false` 时 Web 直接同步创建。429、鉴权失败、解析失败和普通服务错误均不得触发同步重试绕过准入控制。跨域允许 Prefer、Idempotency-Key，并暴露 Location 和版本头。

`API_VERSION=1` 是共享定义，`CONTRACT_VERSION`、`PARSE_DTO_VERSION` 均从其派生。`contractVersion`、`dtoVersion` 与 `X-Genoffice-Dto-Version: 1` 代表同一个 v1 协议。同步创建保留原有响应体。解析器软件版本、离线包 schema、媒体 profile 和缓存 generation 按各自用途管理。

## 部署配置

| 环境变量                                   | 程序选项                  | 用途                     |
| ------------------------------------------ | ------------------------- | ------------------------ |
| `PARSE_SERVER_ASYNC_SESSIONS`              | `asyncSessions`           | 是否接受新的异步创建     |
| `PARSE_SERVER_ASYNC_ROLLOUT_PERCENT`       | `asyncRolloutPercent`     | 文件或租户灰度比例       |
| `PARSE_SERVER_ASYNC_ROLLOUT_HEADER`        | `asyncRolloutHeader`      | 用于租户分桶的请求头     |
| `PARSE_SERVER_ASYNC_ROLLOUT_RAMP_PER_HOUR` | `asyncRolloutRampPerHour` | 每小时增加的灰度百分点   |
| `PARSE_SERVER_ASYNC_AUTO_PAUSE_ERROR_RATE` | `asyncAutoPauseErrorRate` | 错误率触发自动暂停的阈值 |

比例配置接受整数 0–100，0 可用于关闭灰度；配置值冲突时拒绝启动。关闭异步模式只拒绝新的异步创建，同步模式与已有会话读取、清理保持可用。

部署顺序为服务端、Web、APK，代理按 `/v1` 转发请求。沿用现有数据目录、数据库、签名配置与幂等账本；此次统一不改变数据库或离线包格式。历史报告的接口名称统一按 v1 整理，历史测量结果保持原值。

## 本轮验证

执行记录与日志索引位于 `/tmp/genoffice-api-v1-20261116/`；临时目录不随 Git 分发。每条命令的 `*.run.json` 记录时间、耗时及退出状态，`*.log` 保存原始输出。早期失败与修正后的通过记录均保留。

| 检查                  | 命令或证据                                                                                            | 结果                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Web 单元              | `npm test -w @genoffice/viewer`；`viewer-final.*`                                                     | 136 项通过，0 跳过                                                                                                                             |
| 服务端完整集成        | 隔离 Compose 的 `compose.yml + compose.media.yml run --rm tests`；`server-real-final.*`、`suite.json` | 568 项通过，0 失败、0 跳过；含真实 MySQL、Redis、FFmpeg、多实例                                                                                |
| 共享契约              | `npm test -w @genoffice/parse-contract`；`contract-test.*`                                            | 13 项通过                                                                                                                                      |
| 静态检查              | 三包 typecheck、改动文件 ESLint、格式和 `git diff --check`                                            | 通过                                                                                                                                           |
| Web 构建              | `npm run package -w @genoffice/viewer`；`web-package.*`                                               | 通过                                                                                                                                           |
| Android 构建/原生测试 | assembleDebug、assembleDebugAndroidTest；`android-build.*`、`android-native.*`                        | APK 构建通过；Instrumentation 45 项通过                                                                                                        |
| 浏览器回归            | Viewer `test:ui`、`test:library`、`test:pixel`                                                        | 三格式响应式/主题/控件、连续 DOCX 缓存与会话恢复、PPT 像素等价均通过                                                                           |
| 业务 PPT 在线及下载   | `business-setup.json`、`android-business-download.*`、`extended-online.json`                          | 16 页、13 个媒体；原生下载、Range、拖动播放、实际触控预览/放映通过；v1 两实例会话复用通过                                                      |
| 业务 PPT 物理断网     | `extended-offline.json`、`android-offline-extended.*`                                                 | Wi-Fi/移动数据均关闭、无默认网络且 USB 服务转发移除；冷启动 16 页、13 媒体 Range/定位播放与触控预览/放映通过，外部请求 0；网络设置与转发已恢复 |

业务样本使用此前保留的只读私有副本《南宁天桃实验.pptx》，上传后核对 SHA-256/fileId 与既有样本一致；下载目录原路径当前不存在。截图与完整媒体清单位于证据目录，仓库不保存业务原文件。本轮是接口迁移回归，不包含新一轮容量、长稳或异机恢复验收。
