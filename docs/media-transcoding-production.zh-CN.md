# 在线音视频自动准备

## 接入范围

Web Viewer 的在线 PPT 预览和放映已接入独立媒体准备流程。正文和页面先展示，点击预览媒体或进入含媒体的放映页时自动准备当前媒体。小于自动远端阈值、但包含音视频的 PPT，在服务器声明支持此能力时也走服务端；显式本地模式和离线包继续使用本地资源。

原 PPTX、解析模型和原媒体均不修改。转换结果不写回 PPT，不把签名 URL 写入持久模型。已有离线 bundle 的媒体仍为原格式，本次没有扩展离线转换清单。

## 处理策略

1. 流式提取指定 ZIP part，并计算 SHA-256；不把整个音视频读入 Node Buffer。
2. 用 ffprobe 读取实际容器、编码、像素格式、profile、level 和音轨。PPT 中的对象用途决定输出是视频还是音频，不能只看文件扩展名。
3. 兼容 MP4/H.264 8-bit（Baseline/Main/High、level≤5.1），且无不兼容音轨、有前置索引的资源直接复用；MP3 音频直接复用。兼容编码但封装或索引不合适时仅重新封装。
4. 其余视频转换为 MP4/H.264 High、level 4.1、8-bit `yuv420p`、AAC-LC；最大 1920×1080、最大 30 fps，保持比例、不放大小素材，尺寸取偶数。独立音频输出 MP3 192 kbit/s、44.1 kHz 双声道；源文件即使包含视频轨，也只提取 PPT 音频对象使用的音轨。
5. 新转换或重新封装的输出需通过流、时长、MP4 索引和完整解码检查。临时文件 fsync、目录原子发布后，才能提交 SQL ready 状态。

缓存键包含**原媒体 SHA-256、对象用途、转换配置版本、FFmpeg/ffprobe 构建标识**。同一媒体在不同 PPT 中可共用产物。兼容资源也存为独立可分段读取文件，解决源 ZIP 压缩 entry 只能完整返回的问题。重试使用独立的强制规范化配置，避免浏览器不支持原格式时不断拿回原字节。

## 持久任务与缓存

- MySQL 的 `parse_media_jobs` 保存排队、处理阶段、进度、失败原因、尝试次数和租约；`parse_media_cache` 保存缓存代次及 ready 指针。Redis 不承担媒体任务真相。
- 所有副本共享同一 MySQL 数据库和同一 `/data` 文件系统。任务领取通过事务串行准入，全局限制运行数量与排队数量；各副本必须使用一致的队列、容量和保留参数。
- 处理进程持续续租。服务正常退出会终止子进程并交回任务；进程崩溃后，租约过期的任务可由另一实例接管，连续中断最多自动尝试三次。过期执行者不能发布覆盖新结果；故障接管可能重新计算，保证的是受租约保护的唯一发布。
- 排队和运行中的任务通过外键保护源文件。完成或失败后释放源引用。运行时升级或关闭功能后，无存活运行时可承接的旧任务退出并释放引用。
- 缓存按容量、条目数及闲置 TTL 清理；领取新任务时预留输入与输出空间，缓存压力下主动回收。目录代次不可变，回收与重建互相隔离；孤立临时文件及旧代次由后台清理。
- 同一请求、跨文件复用和重启复用都检查缓存存在性；准备请求还校验缓存文件哈希，损坏时重新准备。服务端按需签发媒体 URL，支持 GET/HEAD、ETag、Range/If-Range 和 416。

FFmpeg 通过 `spawn` 调用，不使用 shell；只允许本地文件/pipe 协议及明确的媒体 demuxer，禁止从 PPT 触发任意网络媒体下载。探测输出和日志大小有上限，FFmpeg stderr 不返回浏览器。转换有总超时、输入/输出大小限制，以及 Linux 进程 RSS 看门狗；容器 CPU/内存限制仍是部署资源边界。

## 部署

从仓库根目录构建：

```bash
docker build -f apps/parse-server/Dockerfile -t genoffice-parse-server:media .
```

镜像含 FFmpeg、ffprobe、libx264、AAC 和 libmp3lame，并以非 root 用户运行。挂载的数据目录需允许 UID 1000 读写。默认不打开新功能；启动时通过配置启用：

```dotenv
PARSE_SERVER_MEDIA_ENABLED=true
MYSQL_HOST=mysql
MYSQL_PORT=3306
MYSQL_DATABASE=genoffice
MYSQL_USER=genoffice
MYSQL_PASSWORD=通过部署密钥注入
PARSE_SERVER_DATA_DIR=/data
```

启用时若缺少 MySQL、FFmpeg 或必要编码器，启动直接失败。数据库需要原项目已有的建表/迁移权限。生产应固定发布镜像 digest，避免各副本使用不同的 FFmpeg 构建。备份若需要保留媒体缓存，应同时保存 MySQL 和 `/data/media-cache`；只恢复原文件时可按需重建媒体。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PARSE_SERVER_MEDIA_CONCURRENCY` | `1` | 共享数据库范围内的媒体任务并发 |
| `PARSE_SERVER_MEDIA_MAX_QUEUED` | `64` | 排队任务上限，满时返回 429 和 Retry-After |
| `PARSE_SERVER_MEDIA_TIMEOUT_MS` | `1200000` | 单任务总时限，含提取、转换和检查 |
| `PARSE_SERVER_MEDIA_WORKER_RSS_MB` | `1024` | Linux 子进程 RSS 限制 |
| `PARSE_SERVER_MEDIA_MAX_INPUT_BYTES` | `536870912` | 单个输入媒体上限 |
| `PARSE_SERVER_MEDIA_MAX_OUTPUT_BYTES` | `1073741824` | 单个输出上限 |
| `PARSE_SERVER_MEDIA_MAX_CACHE_BYTES` | `10737418240` | 独立媒体缓存空间预算 |
| `PARSE_SERVER_MEDIA_MAX_CACHE_ENTRIES` | `10000` | 缓存条目数上限 |
| `PARSE_SERVER_MEDIA_CACHE_TTL_MS` | `604800000` | 缓存闲置保留时间 |
| `PARSE_SERVER_FFMPEG` / `PARSE_SERVER_FFPROBE` | PATH 中的命令 | 二进制路径 |

媒体预算与原文件/解析 artifact 预算分别配置，要为二者及容器临时空间预留实际磁盘。编码器和解码器限制为 2 线程，过滤器为 1 线程；这不是对 8 核/16 GiB 生产吞吐量的承诺，应按实际素材和解析负载共同测量。

本机双实例部署与测试可使用：

```bash
docker build -f apps/parse-server/Dockerfile -t genoffice-media-production:local .
docker compose -f apps/parse-server/deploy/validation/compose.yml \
  -f apps/parse-server/deploy/validation/compose.media.yml up -d app-a app-b
```

## 接口与前端

服务器通过 `/v2/capabilities` 的 `features.mediaTranscoding=true` 宣告能力。旧服务或关闭功能时，Viewer 保留原有播放路径。

- `POST /v1/files/:fileId/media`：JSON `{ "partPath": "ppt/media/media1.wmv", "kind": "video", "retry": false }`。幂等准备，排队/运行返回 202，已完成返回 200。
- `GET /v1/files/:fileId/media/:jobId`：查询 `queued/processing/ready/failed`、处理阶段和百分比；ready 时返回临时签名 URL、MIME、字节数、处理策略及命中信息。
- `GET|HEAD /v1/files/:fileId/media/:jobId/content`：播放资源。签名绑定原文件和任务，不能跨文件复用签名；准备和状态接口仍要求正常 Bearer 鉴权。

前端显示“正在准备”“排队”“检查”“转换进度”“校验”等状态；错误显示重试入口。切页、关闭媒体或退出放映会终止浏览器轮询，已入队的服务端任务可继续完成并进入缓存。浏览器若阻止等待后的有声自动播放，用户仍可点击媒体或原生控件播放。

`/v1/health` 的 `media` 字段提供全局任务计数、缓存占用及本实例命中/转换计数。`/metrics` 提供 `genoffice_media_jobs`、`genoffice_media_cache_bytes` 及各处理计数，需结合容器内存、CPU、磁盘和持续排队情况监控。

回滚使用 `PARSE_SERVER_MEDIA_ENABLED=false` 并重启。停止领取新任务、能力标志关闭，但已存在缓存目录和数据库时保留只读播放服务，使已发出的兼容媒体 URL 在有效期内继续可用。

验证结论见 [生产流程验收](media-transcoding-production-validation.zh-CN.md)；前期独立转码实验见 [FFmpeg 可行性验证](media-transcode-validation.zh-CN.md)。
