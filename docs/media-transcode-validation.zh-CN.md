# FFmpeg 音视频转换验证

> 本文保留原设计或当时验证条件；当前三端职责、已知边界与测试入口请参阅[架构主文档](runtime-workflows.zh-CN.md)、[运行边界](runtime-boundaries.zh-CN.md)和[测试指南](testing-guide.zh-CN.md)。历史数字不自动代表当前结果。

日期：2026-11-11。

> 本文记录自动流程接入前的可行性实验。后续已完成在线自动准备、队列、缓存与前端状态接入，当前说明见 [生产流程](media-transcoding-production.zh-CN.md) 和 [生产验收](media-transcoding-production-validation.zh-CN.md)。下文“尚未接入”描述仅表示当时实验的范围。

## 验证边界

本次验证服务端 FFmpeg 将 PPTX 内嵌视频转换为 H.264/AAC MP4、将独立音频对象转换为 MP3 的可行性。转换结果装入临时 PPTX 副本，通过现有 parse-server 与 Viewer 验证。

**这不是生产自动转换功能交付。** 当前生产代码尚未接入媒体准备接口、持久化转码任务、跨实例去重或转换状态 UI。本次脚本顺序执行转换，临时副本用未压缩 ZIP entry 保存媒体以验证现有资源接口的 Range 行为；生产方案应把转换结果作为独立媒体 artifact 保存。

业务原件只读，提取文件、临时 PPTX、截图与详细 JSON 都在 `/tmp/genoffice-media-validation/`，不进入 Git。浏览器验证采用静音播放，验证解码、进度、拖动、视频尺寸与帧输出；没有人工听音、Office 动画时序对照或多浏览器验收。

## 环境与转换规则

- Linux arm64 Docker；FFmpeg/ffprobe `5.1.9-0+deb12u1`。合成输入由本机 FFmpeg `8.0.1` 生成。
- 业务转换容器：2 核 CPU 配额、2 GiB 内存、无额外 swap、禁用网络，视频编码线程 2，过滤线程 1，任务顺序执行。
- 合成转换容器：1 核、768 MiB、禁用网络。parse-server 使用独立的现有验证镜像与临时数据目录。
- 视频：`libx264 -preset fast -crf 23 -pix_fmt yuv420p`，调整为偶数尺寸；存在音轨时使用 AAC 128 kbit/s 双声道，`+faststart`。
- 音频对象：选择实际音轨，`libmp3lame` 192 kbit/s、44.1 kHz、双声道。即使源文件带视频流，PPT 中的音频对象仍只输出 MP3。
- 输出需通过编码、音轨数量、时长检查及 `ffmpeg -xerror` 完整解码；MP4 顶层 atom 检查要求 `moov` 在 `mdat` 前。检查后才把临时输出改名为完成文件。
- 每个容器内的 FFmpeg/ffprobe 也受 `timeout` 约束，避免只杀死 Docker 客户端而遗留编码进程。

这些是本次验证参数，不是生产容量结论或所有素材的最终画质配置。

## 业务样本结果

扫描用户指定目录中的 9 份业务 PPTX，5 份包含音视频，共 26 个独立媒体。PPT 声明用途为 21 个视频、5 个音频；实际探测到 23 个 H.264 视频流、22 个 AAC 音轨、2 个 MP3 音轨和 1 个 PCM 音轨，差异来自两个被作为音频使用的 MP4 文件。

| 检查项                                     | 结果                                                             |
| ------------------------------------------ | ---------------------------------------------------------------- |
| 业务媒体转换、目标编码与完整解码           | 26/26 通过：21 个 MP4、5 个 MP3                                  |
| MP4 `moov` 前移检查                        | 21/21 通过                                                       |
| 原格式通过真实资源接口播放、进度推进与拖动 | 26/26 通过                                                       |
| 转换后通过真实资源接口播放、进度推进与拖动 | 26/26 通过                                                       |
| 转换后媒体 Range                           | 26/26 返回 206，准确返回请求的 32 字节                           |
| 原格式 Viewer 预览与放映抽样               | 4 份直接点击通过，1 份画布外音频经组件事件验证通过并记录交互警告 |
| 转换后 Viewer 预览与放映抽样               | 同上：4 份直接点击通过，1 份保留交互警告；无页面运行异常         |
| 解析后媒体对象与页数                       | 5/5 副本保留各页媒体 `sourceId`、`kind` 与总页数                 |
| 临时业务 PPTX 副本结构校验                 | 5/5 通过，以各自原件为基线                                       |
| 页面及其他非关系 XML                       | 5/5 副本与原件字节一致；只替换媒体、关系及内容类型               |
| 原文件完整性                               | 9/9 SHA-256 未改变                                               |

浏览器为本机 Chrome `157.0.8103.39`。业务原格式已经能播，所以这批文件没有复现编码不兼容；恢复不兼容格式的证据来自后面的独立合成对照。

业务媒体累计时长约 31.1 分钟；逐项转换及检查累计耗时 **489.174 秒**，最长单项 **131.049 秒**。业务 FFmpeg 容器的 cgroup `memory.peak` 为 **741,036,032 字节，约 706.7 MiB**，包含文件缓存，不等同于进程 RSS。该容器有 2 核配额，但这些结果不能外推为 8 核/16 GiB 生产吞吐量。

本轮有意强制转换全部输入以验证编码路径，媒体总大小从 **201.7 MiB 增至 225.6 MiB，约增加 11.8%**。其中已有低码率 H.264 素材重编码后变大；这支持生产环境采用探测后直用或重新封装，而不是无条件重编码。未进行客观画质评分。

## 合成样本结果

以下 6 个 PPTX 明确为合成样本，每段媒体约 2 秒。结构检查使用 PPTX 技能提供的校验器，以仓库原模板为基线，6/6 通过。

| 输入                       | 原始资源播放     | 转换后资源播放与拖动  | 转换后 Viewer 预览 / 放映 |
| -------------------------- | ---------------- | --------------------- | ------------------------- |
| WMV2 / WMA2                | 失败             | 通过                  | 通过                      |
| MPEG-4 Part 2 / MP3，AVI   | 失败             | 通过                  | 通过                      |
| HEVC 10-bit / AAC          | 本机 Chrome 通过 | 通过                  | 通过                      |
| FFV1、321×241、无音轨，MKV | 失败             | 通过，320×240，无音轨 | 通过                      |
| WMA2 独立音频              | 失败             | 通过，MP3             | 通过                      |
| FLAC 独立音频              | 通过             | 通过，MP3             | 通过                      |

HEVC 和 FLAC 的原格式结果只代表当前浏览器与系统，不能外推其他设备。

## 已确认的独立问题

1. **不能从扩展名决定编码或用途。** “武术正踢腿课件”中的两个 `.wav` 实际是带 H.264/AAC 的 MP4；在 PPT 中引用为音频对象。验证按对象用途提取音轨，生成 MP3。
2. **现有压缩 entry 的 Range 行为有限。** `openFilePart()` 只对 ZIP method 0 直接定位字节范围；压缩 entry 返回完整 HTTP 200。本次原始业务媒体均走完整返回，但本机浏览器拖动仍通过。生产独立转换文件应真正返回 206，避免把完整下载成功视为分段能力通过。
3. **画布外音频交互。** `4a2c58…pptx` 的音频对象在画布外，常规鼠标点击受工具栏或视口影响。脚本保留 `previewPointerReachable=false` / `showPointerReachable=false`，另用 DOM 点击事件验证组件播放，结果计为带警告。转码不会改变对象位置。
4. **缺失外链源。** “展会课件1”中有一个媒体关系的外部目标为 `NULL`，没有源字节，无法转码恢复。
5. **探测退出码不足以判断有效性。** 随机损坏文件被 ffprobe 拒绝；32 字节截断 MP4 的 ffprobe 可成功退出却没有可用流。流水线还检查实际流，两个无效输入均未生成可发布媒体。
6. **超时产物不能发布。** 受控中断的 FFmpeg 返回 124，留下临时 MP4；完成文件不存在。该实验验证临时/完成文件分离，不代表已实现生产任务重启恢复。

## 复现

先创建独立 Python 环境，避免修改全局依赖：

```bash
uv venv /tmp/genoffice-media-validation/qa-venv
uv pip install --python /tmp/genoffice-media-validation/qa-venv/bin/python defusedxml lxml
docker build -f apps/parse-server/deploy/validation/Dockerfile.media \
  -t genoffice-media-validation:local .
docker run -d --name genoffice-media-ffmpeg --cpus 2 \
  --memory 2g --memory-swap 2g --network none \
  -v /tmp/genoffice-media-validation:/evidence genoffice-media-validation:local
```

扫描、转换及生成临时副本（命令从仓库根目录执行，业务目录可替换）：

```bash
/tmp/genoffice-media-validation/qa-venv/bin/python \
  apps/parse-server/scripts/media-transcode-drill.py \
  --input '/Users/dddd/Downloads/01-工作-融梦智慧体育/06-课件与教案' \
  --out /tmp/genoffice-media-validation --phase scan
/tmp/genoffice-media-validation/qa-venv/bin/python \
  apps/parse-server/scripts/media-transcode-drill.py \
  --input '/Users/dddd/Downloads/01-工作-融梦智慧体育/06-课件与教案' \
  --out /tmp/genoffice-media-validation \
  --container genoffice-media-ffmpeg --phase convert
/tmp/genoffice-media-validation/qa-venv/bin/python \
  apps/parse-server/scripts/media-transcode-drill.py \
  --input '/Users/dddd/Downloads/01-工作-融梦智慧体育/06-课件与教案' \
  --out /tmp/genoffice-media-validation --phase variants
```

启动测试 parse-server（使用现有验证镜像，不覆盖正常服务）：

```bash
docker build -f apps/parse-server/deploy/validation/Dockerfile \
  -t genoffice-validation:local .
docker run -d --name genoffice-media-parse --cpus 2 \
  --memory 2g --memory-swap 2g -p 127.0.0.1:18787:8787 \
  -e PARSE_SERVER_HOST=0.0.0.0 \
  -e PARSE_SERVER_DATA_DIR=/data \
  -e PARSE_SERVER_ALLOWED_ORIGINS=http://127.0.0.1:11019 \
  -e PARSE_SERVER_WORKER_MEMORY_MB=512 \
  -e PARSE_SERVER_WORKER_RSS_MB=1024 \
  -e PARSE_SERVER_PARSE_MEMORY_MB=1536 \
  -v /tmp/genoffice-media-validation/server:/data genoffice-validation:local
node --import tsx apps/viewer/scripts/media-playback-drill.mts \
  --out /tmp/genoffice-media-validation --phase original
node --import tsx apps/viewer/scripts/media-playback-drill.mts \
  --out /tmp/genoffice-media-validation --phase converted
```

浏览器脚本使用本机 Chrome，占用本机 11019 端口。合成样本生成器为 `apps/parse-server/scripts/media-codec-fixtures.py`，生成后可用相同扫描、转换、浏览器流程验证；相应转换容器需把合成输出目录挂载到 `/evidence`。

本轮 Viewer 类型检查、浏览器脚本独立 TypeScript 检查及 ESLint、两个 Python 脚本语法检查通过。验证结束后仅删除本次创建的三个测试容器；镜像及 `/tmp/genoffice-media-validation/` 证据保留。

## 生产接入仍需完成

- 媒体探测结果与对象用途共同决定输出配置；兼容资源直用、适合的资源仅重新封装，其余才重编码。
- 独立媒体任务队列、超时和磁盘限额，以及按原媒体哈希、配置版本、FFmpeg 构建标识生成的持久化缓存。
- 复用 artifact 的租约与原子发布，避免多实例重复转换；持久模型保存资源标识，读取时生成签名 URL。
- Viewer 的排队、转换中、失败重试状态，以及需要再次点击播放时的交互。
- 离线 bundle 的兼容媒体清单与映射、多实例中断恢复、弱网与目标 Android WebView/Safari/Firefox 验证。
