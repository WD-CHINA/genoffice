# 南宁天桃实验：复杂 PPTX 业务样本

登记日期：2026-11-16。样本清单见 [business-corpus.json](business-corpus.json)，通用执行方式见[测试指南](../testing-guide.zh-CN.md)。这是新增业务回归样本，不计入 2026-11-12 的 11 份业务文件或 742 项常规用例统计。

## 样本保存与身份

原件为 `/Users/dddd/Downloads/南宁天桃实验.pptx`，保持只读。私有测试副本保存在 `$HOME/Library/Application Support/GenOffice/test-samples/nanning-tiantao/南宁天桃实验.pptx`；79 MiB 级二进制、提取资源和截图均不加入 Git。其他机器需自行取得同一授权文件，放到对应目录，并按清单校验大小与 SHA-256；缺少样本不能记为通过。

- 大小：82,805,864 字节（约 78.97 MiB）。
- SHA-256：`7ecabe9e2e97b2595cd176387d95e43da8e188f74b8d2de1dd2ea8d4245f17a3`。
- 16 页，实际画布为 12,192,000 × 6,858,000 EMU，即 16:9。原 `type=screen4x3` 标签与几何不一致，测试应以实际尺寸为准，不能修改原文件掩盖差异。
- 嵌入资源：8 个 MP4、5 个 MP3、15 个 PNG、5 个 GIF、1 个 JPEG；1 个图表；12 页包含动画时间线；外链关系为零。

## 固定回归范围

1. 服务端上传后读取全部 16 页模型；保留每页摘要，重新打开时比较摘要，禁止重新解析源文件。
2. Web 检查第 1、9、16 页的画布、图片就绪、字体、页面异常及放映进入/翻页/退出。
3. 13 个音视频资源通过生产准备接口选择复用、重封装或转码；检查就绪、Range 206、浏览器播放推进与中段 seek。
4. 首个有媒体的页面为第 2 页；检查预览及放映中的实际指针点击、时间推进且未暂停。

上述检查不代替全部 16 页的 Office/WPS 视觉对照、完整动画时间线、全部媒体对象的逐个触控或有声听测，Android 专项结果在下文单列。

## 复跑命令

在仓库根目录执行，先启动隔离服务并设置 `PARSE_SERVER_URL`。媒体流程还要求服务端启用 MySQL、FFmpeg/FFprobe 与 `PARSE_SERVER_MEDIA_ENABLED=true`。可选鉴权使用 `PARSE_SERVER_TOKEN`，浏览器端口须加入服务的 allowed origins。以下脚本均复用现有体系，不改变常规测试命令：

```sh
export SAMPLE_DIR="$HOME/Library/Application Support/GenOffice/test-samples/nanning-tiantao"
export SAMPLE_EVIDENCE=/tmp/genoffice-nanning-20261116
export VIEWER_TEST_PORT=11039
# 将本机实际验证服务填入此变量；本轮为 http://127.0.0.1:20887。
export PARSE_SERVER_URL=http://127.0.0.1:20887
mkdir -p "$SAMPLE_EVIDENCE"
shasum -a 256 "$SAMPLE_DIR/南宁天桃实验.pptx"
node --import tsx apps/parse-server/scripts/corpus-drill.mts \
  --input "$SAMPLE_DIR" --url "$PARSE_SERVER_URL" \
  --out "$SAMPLE_EVIDENCE/corpus.json"
node --import tsx apps/viewer/scripts/corpus-browser.mts \
  --corpus "$SAMPLE_EVIDENCE/corpus.json" --server "$PARSE_SERVER_URL" \
  --out "$SAMPLE_EVIDENCE/browser" --playback
python3 apps/parse-server/scripts/media-transcode-drill.py \
  --phase scan --input "$SAMPLE_DIR" --out "$SAMPLE_EVIDENCE/media"
node --import tsx apps/viewer/scripts/media-playback-drill.mts \
  --out "$SAMPLE_EVIDENCE/media" --server "$PARSE_SERVER_URL" --automatic
# 关闭并重新启动同一隔离服务后执行；不停止其他人的开发服务。
node --import tsx apps/parse-server/scripts/corpus-drill.mts \
  --reopen-report "$SAMPLE_EVIDENCE/corpus.json" --url "$PARSE_SERVER_URL" \
  --out "$SAMPLE_EVIDENCE/reopen.json"
```

媒体扫描所用 Python 需要 `defusedxml`，通过仓库外 venv 安装；本轮复用此前验证 venv。上传及重开报告必须只有该样本、`status=passed`、`unitCount=16`、`fileId` 等于清单 SHA-256；重开须比较全部 16 个摘要，并检查源解析计数未增加。不能只凭进程退出 0 判定选中了正确样本。

## 本轮结果与证据

证据目录：`/tmp/genoffice-nanning-20261116/`。各 `*.run.json` 保存实际命令、耗时与退出码，报告和截图保存在该目录。汇总索引为 `validation.json`；首次启动缺少媒体所需 MySQL，以及探针先于服务就绪的失败记录均保留，最终使用真实 MySQL 就绪后复验。

| 检查               | 本轮结果                                                                 | 证据                                                |
| ------------------ | ------------------------------------------------------------------------ | --------------------------------------------------- |
| 原件与私有副本     | 大小与 SHA-256 一致，原件未改写                                          | `input.json`、`validation.json`                     |
| 全页模型           | 16 页通过；冷构建约 1.74 秒 ready                                        | `corpus.json`、`corpus-ready.run.json`              |
| 重启复用           | 16 页摘要一致，重开约 0.025 秒，源解析计数 0                             | `reopen.json`、`reopen.run.json`、`restart.json`    |
| Web 首/中/末页     | 第 1、9、16 页及放映进入/翻页/退出通过；页面、HTTP 与字体替代提示均为零  | `browser/report.json`、`browser/*.png`              |
| 自动媒体准备与解码 | 13 项通过：11 复用、2 重封装；全部 Range 206 / 32 字节，播放与 seek 成功 | `media/browser-original.json`                       |
| 实际指针交互       | 第 2 页的预览、放映播放均推进且未暂停，无组件事件回退                    | `media/browser-original.json`、`media/screenshots/` |

本轮使用 Node 22.23.4、本机 Chrome、独立真实 MySQL 和仓库源码 Node 服务，媒体为本机 FFmpeg/FFprobe。首轮未重跑 Android、长稳或生产容量矩阵；下文补录 Android 专项，不将单文件结果替代此前三端完整验收。

## Android 在线与下载后断网复验（2026-11-16）

设备：华为 AGS5-W00 / Android 12 / WebView 114.0.5.302。复用并核对已安装的 Debug APK，SHA-256 为 `ab67d74d1f7872a16807a68427fa2cb025750c706d826bedfe9da4458d9ba673`；本轮未修改 Java 或 APK 资源。在线入口通过 USB reverse 访问本机服务；断网阶段移除本轮转发、关闭 Wi-Fi 和移动数据，确认系统 `Active default network: none`，再强制停止并冷启动 App，打开已缓存包。未清空应用数据。

| 检查       | 结果                                                                                                   | 证据                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 完整下载   | 153,909,550 字节，约 146.78 MiB；sourceVerified、媒体准备和离线范围均完整                              | `device-transcode-fixed/*-manifest.json`                             |
| 在线阅读   | 16 页实际触控翻页通过，首/中/末页截图，无页面 JS 异常                                                  | `extended-online.json`、`online-page-*.png`                          |
| 在线媒体   | 13 个已准备资源的播放、中段 seek、Range 206 / 32 字节通过；第 2 页音频、第 11 页视频预览与放映触控通过 | `device-transcode-fixed/device-results.json`、`extended-online.json` |
| 断网冷启动 | Wi-Fi=0、移动数据=0，无默认外部网络，后端不可达；16 页实际触控翻页通过                                 | `extended-offline.json`、`offline-page-*.png`                        |
| 断网媒体   | 13 个资源播放、seek、Range 通过；第 11 页视频预览/放映触控通过，无需重试                               | `extended-offline.json`、`offline-video11-*.png`                     |
| 外部依赖   | 冷启动离线阶段外部资源为 0，JS 异常为 0                                                                | `extended-offline.json`                                              |
| 代码回归   | 真实 MySQL/FFmpeg 媒体回归 7 项、Viewer 133 项、服务端类型与定向 lint 通过                             | 各 `*.run.json` 和日志                                               |

证据目录为 `/tmp/genoffice-nanning-android-20261116/`，汇总为 `android-validation.json`；每个被采用阶段的实际命令、耗时与退出状态单独保存。在线 13 项检查使用与下载包摘要一致的已准备资源，第 11 页实际 UI 另验证默认在线资源无需点击重试即可播放。原生下载前能力检查与 WebView 播放能力不同，不能将下载前检查拒绝直接等同于在线播放失败。

### 本轮发现与修复

- ADB 启动时空令牌参数曾被设备 shell 丢弃，文件 ID 因而错位；[共享设备辅助代码](../../apps/viewer/scripts/android-test-device.mjs)现对 shell 操作数逐个转义。空值、空格、单引号、元字符和换行分别经过同步及异步真实 ADB 探针验证。原始启动与中止记录保留。
- `ppt/media/media11.mp4` 是 H.264 High Level 5.1、`yuvj420p` 全范围源。Android 下载前原生解码能力检查要求强制转码；原服务即使指定 `-pix_fmt yuv420p`，仍继承全范围 metadata，输出 `yuvj420p` 并被 `media_output_invalid` 拒绝。
- [服务端转码](../../apps/parse-server/src/media-service.ts)现使用 `out_range=tv` 和 `-color_range tv`，仍严格校验 `yuv420p`、Level、尺寸、音轨与时长；[媒体 profile](../../apps/parse-server/src/media-policy.ts)升级为 v3，使新转换身份与旧缓存区分。原件、公共 API、数据库结构与离线包格式均未改变。
- [现有真实媒体回归](../../apps/parse-server/tests/media-mysql.test.ts)加入全范围 BT.709 源的强制转码场景，检查输入 `yuvj420p/pc`，输出 `yuv420p/tv`、H.264、尺寸和 AAC 音轨。没有放宽校验以绕过失败。

本轮只验单台设备、短时静音播放与定位播放，不认证可听音质、完整媒体时长、全部动画时序、所有安卓机型或逐帧无闪。设备网络设置、USB 转发和临时验证服务的恢复/清理结果记录在汇总中。

## 放映视频封面透出修复（2026-11-16）

用户在第 4 页指出“视频有两层”。实机 DOM 只有一个 `<video>`：视频原尺寸为 568×320，显示框约 952×440 CSS 像素，`object-fit: contain` 产生左右空白；原播放器背景透明，露出了 Canvas 中宽度不同的静态封面。先前播放时间推进检查没有覆盖这个视觉问题。

[共享放映媒体层](../../packages/viewer-renderers/src/slides/renderer/components/ShowMediaLayer.tsx)现明确保持原视频比例，并用不透明黑色填满播放器空白区，避免封面透出；预览、缩略图和音频封面保持各自原有逻辑。这里只修改渲染，不修改业务 PPT、转码内容或离线包格式。

新增[像素回归脚本](../../apps/viewer/scripts/media-letterbox-smoke.mts)，以实际 ShowMediaLayer 叠加不同颜色的 Canvas 封面，分别验证左右/上下留黑区域、视频帧和外部画布；透明背景负对照须确实露出封面，从而避免仅断言样式或把全黑空视频记为通过。复跑命令：

```sh
MEDIA_LETTERBOX_EVIDENCE=/tmp/genoffice-media-letterbox \
  node --import tsx apps/viewer/scripts/media-letterbox-smoke.mts
```

该检查复用现有 Vite、Playwright 和 PNG 工具，需要本机 FFmpeg 与 Chrome，不需要 MySQL 或业务二进制。新 APK 与实机复验的命令、截图、像素采样和原始失败记录保存在 `/tmp/genoffice-nanning-video-layer-20261116/`，结论见该目录的 `validation.json`。

本轮实际结果：宽框/高框 2 组像素回归通过，透明背景负对照均重现封面透出；新 APK 已安装并核对 SHA-256。第 4、11 页暂停、播放和中段定位共 6 组实机截图通过，两侧各 121 个采样点均为黑色，DOM 均只有一个视频。另用原离线包完成断网冷启动、16 页触控翻页、13 个音视频资源解码/seek 和第 4 页媒体预览/放映触控，外部资源请求为零。Viewer 133 项、类型、定向 lint、生产打包及 APK 构建通过。

先前两次收尾探针分别遇到放映层覆盖预览导航、系统音量浮层遮挡右侧像素采样，失败记录与截图保留；退出放映后重跑完整离线检查，并在浮层消失后重采 6 组截图。业务包未被改写或重新下载，设备网络设置与转发已恢复。
