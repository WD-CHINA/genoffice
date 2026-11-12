# 在线自动媒体流程验收

> 本文保留原设计或当时验证条件；当前三端职责、已知边界与测试入口请参阅[架构主文档](runtime-workflows.zh-CN.md)、[运行边界](runtime-boundaries.zh-CN.md)和[测试指南](testing-guide.zh-CN.md)。历史数字不自动代表当前结果。

日期：2026-11-11。实现与配置见 [在线自动媒体准备](media-transcoding-production.zh-CN.md)。本轮从原始业务 PPTX 经过生产镜像的真实接口准备媒体，未使用替换媒体后的 PPT 副本。

## 环境

- 本机 Docker Desktop，Linux arm64；两个 `apps/parse-server/Dockerfile` 构建的非 root 实例，共享 MySQL 8、数据卷和媒体缓存。Redis 7 保留原解析热缓存用途。
- A 实例配额 8 核 / 4 GiB，B 为 2 核 / 2 GiB；媒体队列全局并发 1，FFmpeg 解码与编码各限制 2 线程。不是 8 核 / 16 GiB 生产容量验收。
- FFmpeg/ffprobe `5.1.9-0+deb12u1`；浏览器为 macOS Chrome `157.0.8103.39`。
- 业务文件、临时上传变体、截图、JSON 和测试日志保留在 `/tmp/genoffice-media-production/`，不进入 Git。

## 业务文件

扫描用户指定目录中的 9 份业务 PPTX，5 份有嵌入音视频，共 26 个独立媒体。所有 9 份原件的 SHA-256 未变化。

| 项目                               | 结果                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| 直接复用                           | 21 个，SQL 缓存元数据与源媒体哈希逐项核对，输出字节哈希与原媒体完全相同               |
| 仅重新封装                         | 2 个，视频不重编码，MP4 索引前移                                                      |
| 转码                               | 3 个独立音频输出 MP3：1 个 PCM WAV、2 个被当作音频引用的 MP4                          |
| 视频重编码                         | 0 个业务视频                                                                          |
| 准备后实际资源播放、进度推进及拖动 | 26/26 通过                                                                            |
| Range                              | 26/26 返回 206 和准确的 32 字节范围                                                   |
| Viewer 预览与放映                  | 每份含媒体课件抽样一页，5/5 能播放，无页面运行异常；其中 1 份保留画布外音频的交互警告 |
| 重复准备                           | 26/26 立即命中既有任务和缓存，无新增探测                                              |
| 跨 PPT 复用                        | 只改变 ZIP 注释的临时上传变体，原文件 ID 不同、媒体内容相同，缓存命中                 |
| 双实例重启                         | 两实例重启后准备既有媒体，无探测、无重新编码                                          |

源媒体累计 **201.7 MiB**，按 PPT 对象用途准备后的媒体为 **152.4 MiB**。减少的主要原因包含将两个“音频对象中的视频文件”提取为音频；不能据此推断任意文件的压缩率。复用和重新封装避免了前期全量重编码实验中的视频画质损失与体积增长。

## 不兼容格式与界面

对 6 份约 2 秒的合成课件，直接上传原始 WMV/WMA、AVI、HEVC 10-bit、奇数尺寸无声 FFV1/MKV、WMA、FLAC，通过本轮自动接口准备。**6/6 实际资源播放和拖动通过，6/6 Viewer 预览及放映通过。** 此处没有预先替换媒体文件。

浏览器另验证以下实际交互：

1. 小型 WMV PPT 在自动模式选择文件后会上传到服务器，媒体 URL 来自兼容缓存，能播放；捕获到“正在准备媒体”“媒体正在排队”。
2. 损坏媒体显示无法解码提示和“重试媒体”按钮；点击后实际发送 `retry=true`，未静默退回原资源。
3. 对已能播放的业务视频制作仅附加合法 MP4 `free` atom 的临时课件，避免重复运行命中已有强制转换缓存；注入受控 `error` 事件，验证重试的强制规范化路径。界面实际捕获到多次百分比转换进度及“正在校验媒体”，完成后可播放。这里是界面故障注入，不表示原业务视频本身存在编码错误。

## 任务中断与发布

对业务视频制作仅在 MP4 尾部增加合法 `free` atom 的临时上传变体，确保故障实验不会命中此前强制转换的缓存。原件未修改。

任务进入编码阶段后，向 **A 容器发送 SIGKILL，并保持 A 停机**。B 在租约过期后接管，同一个任务 ID 在约 **56.5 秒**后就绪，输出经过生产流程的完整解码检查，HTTP Range 返回 206。随后恢复 A。

后端自动化测试另覆盖：

- 多实例并发领取只允许一个任务运行，队列满时拒绝新请求。
- 排队时源文件受外键保护，完成或失败后释放。
- 租约过期后旧执行者不能覆盖新执行者的缓存发布。
- 运行时消失后旧队列退出；缓存驱逐期间不能并发重建同一 key。
- 缓存损坏重新准备、缓存条目压力回收。
- 正常重启复用，签名错误返回 401，准备请求拒绝越界 part 路径。
- 关闭转换开关后能力标志关闭、拒绝新准备任务，但已有签名媒体 URL 仍能返回 206。

故障后的媒体 staging 目录已清空。两个实例没有 OOMKilled 记录。

## 回归检查

| 检查                                            | 结果                               |
| ----------------------------------------------- | ---------------------------------- |
| Linux 后端全量测试，真实 MySQL / Redis / FFmpeg | 561/561，通过，0 跳过              |
| Viewer 测试                                     | 110/110，通过                      |
| Parse contract 测试                             | 13/13，通过                        |
| 服务端、Viewer 与 contract 类型检查             | 通过                               |
| 三个 Node 验证脚本独立 TypeScript 检查          | 通过                               |
| 修改及新增实现的 ESLint                         | 无错误；保留原组件的 Hook 依赖提示 |
| Viewer 打包和独立静态包检查                     | 通过；仍有既有大 chunk 构建提示    |

## 复现入口

先按 [部署文档](media-transcoding-production.zh-CN.md) 构建生产镜像，再构建带 FFmpeg 的验证镜像并启用 overlay：

```bash
docker build -f apps/parse-server/Dockerfile -t genoffice-media-production:local .
docker build -f apps/parse-server/deploy/validation/Dockerfile.media \
  -t genoffice-media-validation:local .
docker build --build-arg BASE_IMAGE=genoffice-media-validation:local \
  -f apps/parse-server/deploy/validation/Dockerfile -t genoffice-media-tests:local .
docker compose -f apps/parse-server/deploy/validation/compose.yml \
  -f apps/parse-server/deploy/validation/compose.media.yml up -d app-a app-b
```

使用 `media-transcode-drill.py --phase scan` 在证据目录生成本机业务清单 `transcode.json`；随后执行：

```bash
PARSE_SERVER_TOKEN=validation-local node --import tsx \
  apps/viewer/scripts/media-playback-drill.mts \
  --out /tmp/genoffice-media-production --phase original --automatic
```

`media-ui-drill.mts` 验证小文件自动路由、错误重试和真实进度；`media-recovery-drill.mts --allow-kill` 验证两个隔离容器的重启和中断接管。故障脚本只接受 `genoffice-validation-app-a-1` / `app-b-1`，不能用于线上容器。故障实验和浏览器验收顺序运行，避免重启打断另一项验证。

## 仍有边界

- “展会课件1”中目标为 `NULL` 的外链没有原始媒体字节，转码无法补回。
- `4a2c58…pptx` 的音频对象位于画布外。组件播放验证通过，但正常指针点击仍受工具栏 / 视口影响，计为交互警告；本次没有移动原对象。
- 播放检查采用静音自动化，验证了音轨完整解码、视频帧、进度和拖动，没有人工听音、Office 动画时序对照，以及 Safari / Firefox / Android WebView 的实际设备验收。
- 本轮完成在线服务接入和本机生产镜像验证，未部署到外部线上环境；离线 bundle 兼容媒体导出及目标硬件生产容量不属于本轮结论。

后续 Android 在线及断网播放接入与真机验收见
[Android 媒体验收](android-media-validation.zh-CN.md)，该报告补充了本报告未覆盖的离线包与 WebView 范围。
