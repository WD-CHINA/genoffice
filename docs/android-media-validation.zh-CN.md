# Android 在线与下载后断网媒体验收

> 本文保留原设计或当时验证条件；当前三端职责、已知边界与测试入口请参阅[架构主文档](runtime-workflows.zh-CN.md)、[运行边界](runtime-boundaries.zh-CN.md)和[测试指南](testing-guide.zh-CN.md)。历史数字不自动代表当前结果。

日期：2026-11-11。环境为本机 Docker 解析服务、USB 连接的 Android 12 平板，
实际 WebView 内核为 Chromium 114.0.5735.196。APK 为 debug 构建，覆盖安装时保留应用数据。
本文不代表外部线上部署或其他型号设备验收。

后续 Word 在线与下载后离线阅读见 [Word 阅读修复验收](word-reading-fixes-validation.zh-CN.md)。

## 接入方式

- 在线入口使用部署的 Viewer 和解析服务，复用自动媒体准备、进度、错误和重试逻辑。
  为 Chromium 114 增加 `AbortSignal.any` 兼容实现，并在任务完成时释放监听器。
- 下载优先使用权威离线清单，校验原始资源后准备兼容媒体；页面引用和资源清单内的已知
  未引用音视频均纳入准备。原始媒体保持不变，兼容媒体另存为 MP4 / MP3。
- 下载检查输出大小、SHA-256、来源 SHA-256、媒体类型和转换配置身份，
  并为视频探测设备解码器；必要时自动强制转码一次。
  本地版本由原 artifactKey、转换结果和配置派生，避免混用新旧媒体。
- 离线包封存后，本地服务在回放模型时替换媒体引用；原模型文件和来源校验记录保留。
  兼容媒体使用同源 URL，支持 GET / HEAD / Range。
- 原始资源和兼容资源都计入缓存及磁盘检查。准备失败、来源哈希不符、排队取消时不切换当前包。
- 极短 MP3 使用 WebView 自身音频链路。业务样本中约 78ms 的兼容 MP3 可在 WebView 播放，
  而原生 MediaExtractor 探测拒绝；因此原生音频探测不作为下载门禁。
- 补充硬件加速、视频全屏、返回键处理，修正 WebView 重复挂载、销毁，以及下载切换的取消顺序。

## 验证方法

业务来源为用户指定的「06-课件与教案」目录，原文件仅供读取。
离线验证移除平板到本机 Viewer、解析服务的 USB reverse 映射，确认解析服务请求失败，
再测试本地播放及拖动；监测到的资源请求不得依赖外部 HTTP 地址。完成后恢复原端口映射。
本轮没有切换设备 Wi-Fi 或飞行模式，验证的是本应用依赖的全部远端服务不可达时的本地重放。

每个兼容媒体验证 Range 206、分片字节数、metadata、40% 位置拖动和播放进度；
视频同时检查实际尺寸。页面组件验证预览和放映中的媒体播放。
测试采用静音自动化，没有人工听音或 Office 动画时序对照。

私有业务文件、清单、逐项结果、日志和截图位于 `/tmp/genoffice-android-media/`，不进入 Git。
Android WebView 的 CDP 截图会遗漏部分硬件 canvas / video 图层，不能用于判断空白页；
复现脚本使用设备 screencap 保存真实屏幕，视觉检查以设备截图为准。

## 实测结果

| 业务 PPTX                             | 兼容媒体数 | 在线 / 离线 |
| ------------------------------------- | ---------: | ----------- |
| 47e66b31f89d4b33b14c5010b92296c5.pptx |          6 | 通过        |
| 4a2c58f80c544adc9f6113ed5932610d.pptx |          1 | 通过        |
| 4b00a85c247c47bdaeb01aeec562c90f.pptx |          0 | 通过        |
| 69de6af04fad40b09cacd47e8d64c421.pptx |         15 | 通过        |
| 83f822650ce0499c835780f673faed2b.pptx |          0 | 通过        |
| dcbc94bc3f7a4084b7f4edb9d558d04e.pptx |          0 | 通过        |
| 【跑圈】限时跑&摄像头升级.pptx        |          0 | 通过        |
| 展会课件1.pptx                        |          2 | 通过        |
| 武术正踢腿课件.pptx                   |          2 | 通过        |

共 9 份业务 PPTX、26 个媒体，原文件 SHA-256 全部保持不变。另有 WMV/WMA、MPEG-4/MP3 AVI、
HEVC 10-bit、奇数尺寸无音轨视频、独立 WMA 和 FLAC 六类样本，各 1 个媒体，在线及离线检查均通过。
合计 15 份文件、32 个媒体；离线检查中远端服务不可达，未发现外部资源请求。

「武术正踢腿课件」的两个 WAV 后缀文件实际为含 H.264/AAC 的视频；模型标记为 video，
离线按 MP4 准备并通过视频播放检查。转场 WAV 及未引用视频也纳入了资源清单准备。

回归结果：服务端 561 项、前端 111 项、契约 13 项、安卓 39 项全部通过；
前后端类型检查、定向 ESLint、Git diff 空白检查及 debug APK 构建通过。
安卓测试包含 1 GiB 流式下载、断点续传、旧包保护、媒体失败、来源哈希不符、排队取消、
映射完整性和清理按钮验证。清理按钮测试使用隔离缓存，不清理用户已有课件。

真实设备截图确认最大课件（约 181 MB / 173 MiB）的首页插图正常；
同一 Activity 重新打开不同缓存文件通过。普通视频进入原生全屏后，返回键退出全屏且播放器保留，
再次返回可回到设置页。验收结束后平板停留在最大课件的本地缓存首页，USB 在线端口映射已恢复。

## 复现

先构建并安装 [Android demo](../apps/viewer/android-demo/README.md)，启动在线 Viewer 和启用
媒体准备的解析服务。将已上传 PPTX 的文件 ID 写入私有 JSON：

```json
[{ "name": "业务课件.pptx", "fileId": "64位sha256" }]
```

```bash
ANDROID_SERIAL=<目标设备> PARSE_SERVER_TOKEN=<本地令牌> \
ANDROID_MEDIA_INPUTS=/tmp/private-inputs.json \
ANDROID_MEDIA_EVIDENCE_DIR=/tmp/genoffice-android-media \
npm run test:android-media -w @genoffice/viewer
```

默认本机端口为 Viewer 11019、parse-server 18787；可通过 `ANDROID_VIEWER_URL`、
`PARSE_SERVER_URL` 和 `ANDROID_MEDIA_CDP_PORT` 调整。此断连脚本仅接受带明确端口的
`http://127.0.0.1` 服务，通过指定设备的 USB reverse 访问，结束后恢复原 reverse 映射。
脚本不清理应用数据，不改写业务源文件。

## 仍有边界

- `4a2c58…pptx` 的音频对象位于画布外。音频及组件可播放，但触摸入口不可达；
  验证记录 `pointerReachable=false`，使用程序触发单独验证组件，保留交互警告。
- 「展会课件1」中指向 `NULL` 的媒体没有源字节，转码无法补回。离线范围仅覆盖实际资源。
- 转场音效即使已准备、可独立播放，也不代表新增了原渲染器未实现的转场声音触发逻辑。
- 缺失字体继续使用替代字体；本轮没有重做 Office 排版、动画和字体一致性验收。
- 只覆盖此 Android 12 / Chromium 114 设备及这批样本，不外推其他内核和硬件的播放能力。
