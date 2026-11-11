# Office Viewer Android demo

把 `apps/viewer` 的 Web Viewer 嵌进 WebView，支持 PPTX / DOCX 在线预览和下载后断网阅读。

## 工作方式

1. **下载**：设置页填写解析服务地址和文件 ID（sha256）。创建 v2 异步会话并等待 ready，
   仅 404/405 回退 v1。优先读取 `/v2/sessions/<id>/bundle` 权威清单，按声明的大小和
   SHA-256 下载模型、嵌入字体及全部文档媒体（PPTX 的 `ppt/media`，DOCX 的 `word/media` / `word/embeddings`），逐文件验证后
   原子发布到按 artifactKey 区分的版本目录（见「版本目录与缓存配额」）。现代包保留模型内部路径，字体按 `resourcePath`
   定位；PPTX 仅清单接口 404/405 时使用旧版资源发现及 URL 改写流程，DOCX 要求新版权威清单。
2. **离线排版**：PPTX 走 `pptx-model-session` + `pptx-model-worker`：排版引擎在 Worker 里
   把解析模型排成渲染树，字宽由浏览器 canvas 实测回填。宽度回传只重建**依赖这些 key 的页**；
   离屏页（保留当前页 ±1 和可见缩略图）连同模型一起淘汰，回访时按需重新拉取。
   Web 端同样默认走这条路径，`?layout=server` 可回退到服务端渲染树。
3. **离线渲染**：`LocalAssetServer` 在 `127.0.0.1` 上同时提供
   - `/viewer/*`：打进 APK assets 的 Web Viewer 静态资源；
   - `/v1/*`：按解析服务契约回放本地离线包（sessions / layout / fonts / parts）。媒体分片
     支持 Range，`<video>` 可以直接拖动进度条。

   页面与 API 同源，因此不涉及 CORS、canvas 也不会被跨域像素污染；音视频播放使用的
   是本地缓存文件。

## 在线和离线音视频

设置页可选择「在线打开」或「下载离线包并打开」。在线地址指向部署的 Viewer，解析服务地址
指向已启用自动媒体准备的 parse-server。文件 ID 留空时，在线页面可选本机文件上传。
在线端复用现有媒体准备状态、转换进度和重试入口；Android 不运行 FFmpeg。

下载离线包时，先验证服务端权威清单及原始资源，再调用媒体准备接口。兼容媒体优先复用，
容器不兼容时 remux，编码不兼容时转换。准备结果提供 `sha256`、`sourceSha256` 和 `profile`，
安卓核对来源哈希、结果哈希、大小、类型，并检查系统视频解码器。缺少视频解码器时自动请求一次强制转码；
仍不支持则下载失败，保留原来的可用包。MP3 由 WebView 音频链路解码；原生 MediaExtractor
会误拒绝部分有效的极短音效，因此不作为 MP3 下载门禁。

原始模型及媒体不覆盖；兼容 MP4 / MP3 存在 `prepared-media/<sha256>.*`，清单记录来源、转换配置和映射。
原 artifactKey 与转换结果、配置共同派生本地版本身份，完整性校验覆盖两类文件。
本地 HTTP 回放模型时才替换媒体引用，视频通过同源 `/v1/files/<id>/prepared/<hash>.*` 支持 Range。
资源清单内未引用的已知音视频也会准备；这不会新增原渲染器未实现的转场声音行为。

原媒体和兼容媒体均占用缓存配额，下载时需预留额外空间。转换排队、处理、取消和失败均在设置页显示。
旧服务未启用媒体准备时仍可下载原始包，但会提示音视频兼容性尚未保证；服务启用了媒体准备却没有
完整性元数据时要求升级服务，不降级为未经验证的兼容媒体下载。外链媒体仍标记「部分离线」。

APK 开启硬件加速、视频全屏支持，并修复重复打开和返回页面时的 WebView 生命周期。
前端为 Chromium 114 补充 `AbortSignal.any` 兼容实现。该版本实机报告见
[Android 在线与离线媒体验收](../../../docs/android-media-validation.zh-CN.md)。

## Word 离线包

DOCX 使用同一套权威清单、哈希校验、断点续传、版本目录和失败保留旧包逻辑。
服务端导出 `document.json`（含分节、页眉页脚、脚注 / 尾注上下文）、`styles.json`、
`units/<n>.json`、嵌入字体，以及全部 `word/media` / `word/embeddings` 原始资源。
模型保存稳定内部路径；回放时本地服务移除部署域名和签名参数，图片及字体均从本机读取。
外部图片引用仍会标记部分离线；外部超链接不属于保证可离线访问的内容。

旧服务没有 DOCX 权威清单时明确要求升级，不回退到缺少样式、注释或资源清单的下载方式。
DOCX 的 unitCount 是正文分块数，应用不把它显示为排版页数。前端仍在设备上测量并虚拟分页，
支持脚注正文、尾注、长段落和表格续页；未读完全部分块时，NUMPAGES 显示待计算标记。

真机复现：`ANDROID_SERIAL=... ANDROID_WORD_INPUTS=/tmp/word-inputs.json PARSE_SERVER_TOKEN=...`
运行 `node apps/viewer/scripts/android-docx-smoke.mjs`。输入为 `[{"name":"business","fileId":"64位sha256"}]`。
脚本验证在线和下载后断开服务端口映射时的本地重放，保留应用数据并恢复原 USB reverse 映射。
详细结果见 [Word 阅读修复验收](../../../docs/word-reading-fixes-validation.zh-CN.md)。

## 构建

```bash
# 1. 构建 Web Viewer 发布目录（Gradle 会把它同步进 assets）
cd apps/viewer
npm run package

# 2. 构建 APK
cd android-demo
JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`settings.gradle.kts` 使用 AGP 8.10.1、compileSdk 35；需要本机 `ANDROID_HOME` 指向 SDK。

## 联调

```bash
# 解析服务（仓库根目录）
cd apps/parse-server && PARSE_SERVER_PORT=8790 PARSE_SERVER_DATA_DIR=/tmp/parse-demo-data node --import tsx src/bin.ts

# 上传文件，拿到 fileId
curl -X POST --data-binary @deck.pptx http://127.0.0.1:8790/v1/files

# 设备通过 USB 访问电脑上的服务
adb reverse tcp:8790 tcp:8790
adb reverse tcp:11019 tcp:11019

# 在线预览（本地 Viewer 需先启动；正式部署填写 HTTPS 地址）
adb shell am start -n com.genoffice.viewerdemo/.MainActivity \
  --es viewer http://127.0.0.1:11019/ --es server http://127.0.0.1:8790 \
  --es fileId <sha256> --ez online true

# 启动即下载并打开；已有缓存时可只打开
adb shell am start -n com.genoffice.viewerdemo/.MainActivity \
  --es server http://127.0.0.1:8790 --es fileId <sha256> --ez download true
adb shell am start -n com.genoffice.viewerdemo/.MainActivity \
  --es server http://127.0.0.1:8790 --es fileId <sha256> --ez open true
```

## 已知限制

- 放映按当前放映页保留相邻页，淘汰离屏模型、渲染树和无引用的文字测量缓存；高清图片也按当前页窗口回收。
- 在线会话每分钟续期，下载大媒体期间也会续期；媒体签名默认有效期为 12 小时，超时需要重新打开。
- 淘汰后回访需要重新拉取该页模型（本地/局域网很快，公网有明显延迟）。
- 离线包按 artifactKey 分版本保存、以 `current.json` 指向当前包；缓存有 2 GiB 配额、
  自动回收与清理入口。Android 本地没有读租约，回收非当前版本时正在回放的旧包需重新打开。
  断点续传的部分文件另有 512 MiB 上界（见下节）。
- 演示用途：允许对 `127.0.0.1` 的明文 HTTP；正式产品应使用 HTTPS 服务端。

## 稳定性回归

完整步骤和验收边界见 [resilience-validation.md](../docs/resilience-validation.md)。

```bash
# 仓库根目录：50 页、40 次快速跳页、动画执行期间下一页返回
npm run test:resilience -w @genoffice/viewer
# 125 分钟真实运行（不是模拟时钟）
npm run test:soak -w @genoffice/viewer
# Android 真机：1 GiB 媒体数据流式下载、截断响应、更新失败保留旧包
cd apps/viewer/android-demo
ANDROID_HOME=/path/to/android-sdk ./gradlew assembleDebug assembleDebugAndroidTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -e class com.genoffice.viewerdemo.BundleDownloaderTest \
  com.genoffice.viewerdemo.test/com.genoffice.viewerdemo.BundleTestRunner
```


## 本地包完整性

下载后生成版本为 1 的本地资源清单，记录模型、媒体和字体的大小及 SHA-256，
`complete` 标记绑定 manifest 哈希。发布前验证必需模型/字体，打开前在后台线程
逐资源校验；损坏包显示重新下载提示。旧版无清单的包需要重新下载。
本地服务拒绝未完成包，发布中断使目标目录缺失时可恢复已封存的 `.previous`。

服务端清单包含 artifactKey、modelArtifactKey、解析指纹、模型 schema 和资源源哈希。
现代包全部资源验证成功后标记 `sourceVerified=true`；兼容旧服务端的包为 false。
清单版本不支持、哈希错误或非 404/405 错误不会静默回退。清单中的 href 不作为下载地址，
客户端根据已配置服务地址和受校验的资源路径构造请求。包含外部媒体时不再直接拒绝，
而是把包标记为 `offlineScope=partial` 并明确提示「未保证完整离线」（见下节）。
断点续传、版本目录、缓存配额及清理界面均已接入。

`BundleDownloaderTest` 最新 **33 项**已在
**华为 AGS5-W00 真机（Android 12 / API 31 / arm64-v8a）** 全套通过，包含 1 GiB 下载、
故障恢复、5 项续传用例，以及 9 项版本目录/配额/清理/部分离线用例（含真实 Activity
清理按钮交互）；此前 19 项仅在 Android 36.1 只读模拟器执行。

运行本轮测试（需明确指定测试模拟器，避免操作其他设备）：

```bash
adb -s <test-emulator> install -r app/build/outputs/apk/debug/app-debug.apk
adb -s <test-emulator> install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s <test-emulator> shell am instrument -w -e class com.genoffice.viewerdemo.BundleDownloaderTest com.genoffice.viewerdemo.test/com.genoffice.viewerdemo.BundleTestRunner
```


## 取消下载

设置页提供取消按钮；排队、网络传输和本地哈希校验期间可取消。取消会中断等待、
断开活动连接、关闭本次服务端阅读会话并清理 `.download`，已有完整包保留。
Activity 销毁时也会取消正在进行的下载，迟到的进度回调不会覆盖新下载。
进入最终发布步骤后取消不再撤销该次原子替换；共享服务端解析任务仍遵循后端的
缓存构建策略，不因单个下载者取消而被终止。

本轮验证：全套 11 项 instrumentation 测试通过（包含 1 GiB 回归和排队/媒体取消），
随后新增发布前取消、真实 Activity 按钮交互两项定向测试通过。模拟器为只读运行，
测试按钮交互会恢复其修改的测试偏好，真机验证仍待进行。


## 下载空间检查

下载开始先检查存储余量；媒体和字体有 Content-Length 时在写入前检查是否放得下，
无长度时逐 64 KiB 写入前检查。模型 JSON、manifest 和 complete 标记写入也受检查，
保留 64 MiB 空间用于元数据、替换和其他文件系统活动。空间不足显示明确错误并
清理本次 staging，已有完整包保留；空间检查不会阻止读取已有离线包。

现代清单在下载资源前执行整包预检（资源总量、清单及元数据余量），并继续逐写入检查。
兼容旧服务端时只能逐资源预检。这不是磁盘空间锁，其他进程仍可能同时占用空间；
另有一层按版本的缓存配额与清理入口，见下节。

本轮空间故障验证使用可注入的空闲探针，不填满设备磁盘：完整 15 项测试通过，
已知大小资源在预检失败时保留旧包；未知长度媒体在实际写入部分数据后模拟空间耗尽，
确认临时数据清理、会话关闭和旧包哈希仍有效。

## 断点续传（严格 ETag / Content-Range）

现代清单资源支持跨「下载运行」的断点续传：取消、断网或进程中止后，已接收字节保存在
应用私有 `bundle-cache/<fileId>/resume/`（版本化缓存）；兼容旧服务端的 flat 路径仍是
`bundles/<fileId>.resume/`。二者都**不在 staging 内**，staging 仍按既有语义整体清理。

- 每个部分文件配套一份身份记录 `path / size / sha256 / artifactKey`。下次下载只有四者与
  当前清单完全一致才复用；解析换代、资源哈希或大小变化一律丢弃重下。
- 复用时发送 `Range: bytes=<已接收>-` 与 `If-Range: "<清单 sha256>"`。服务端 ETag 正是
  `"<sha256>"`，`If-Range` 不匹配时服务端忽略 Range 返回整包，旧代字节不可能拼到新资源上。
- `206` 必须带与清单一致的 ETag、精确的 `Content-Range: bytes <offset>-<size-1>/<size>`
  及相等的剩余 Content-Length；`200` 视为不续传并从头下载；`416` 仅在 `bytes */<size>`
  且已收满时视为完成。其他状态/范围/长度一律失败闭合，最终仍对**完整文件**做 SHA-256 校验。
- 部分文件按最老优先裁剪，总量上限 512 MiB；发布成功后清空整个 resume 目录。兼容旧服务端
  （无权威清单）及模型/字体旧流程仍用 staging `.tmp`，不支持续传。整包空间预检仍按清单总量
  执行，续传节省的是传输量与时间，不降低首次预检的空间要求。
- **服务端既有约束**：`openFilePart` 只对 STORE（未压缩）ZIP part 支持 `206`；DEFLATE 媒体
  通过 inflate 流式返回，Range 请求回退整包 `200`。客户端按上述 `200` 规则丢弃重下。

真机验证：5 项 instrumentation 用例覆盖截断后续传、`200` 回退、ETag / Content-Range 拒绝、
身份变更丢弃与配额裁剪。`test:android-backend` 在真机上预置两个媒体各一半字节，真实解析
服务端对 STORE 媒体返回 `206`、对 DEFLATE 媒体返回 `200`，探针确认 `rangeResponses=1`
且两个资源最终都完整。

## 版本目录、缓存配额与部分离线

现代清单的包发布到 `files/bundle-cache/<fileId>/versions/<artifactKey>/`，
`<fileId>/current.json` 是原子写入的当前包引用，记录 artifactKey、offlineScope、
externalCount、sizeBytes 与 publishedAt。同一文件换代会保留旧版本目录；更新失败不切换
指针，旧包继续可用。指针损坏时明确提示重新下载，不静默降级到旧代。旧 flat 包
`files/bundles/<fileId>/` 仍按原布局读取且不改写；无权威清单的旧服务端继续写 flat
布局，也不更新版本指针。

缓存默认 2 GiB（`BundleCache.DEFAULT_MAX_BYTES`，可构造注入）。单个包超过配额时在下载
资源之前拒绝；发布成功后按最老优先回收非当前版本、staging、resume 与中断备份，当前版本
和旧 flat 包永不自动删除。设置页显示缓存大小与历史版本数，并提供
「清理离线缓存（保留当前包）」按钮；下载进行中不可触发清理。Android 本地没有读租约，
若旧版本正在回放，回收后需要重新打开当前包。

含外部媒体的清单不再直接拒绝：本地声明资源仍全部逐文件校验并发布，manifest 写入
`offlineScope=partial` 与 `externalResources`，`complete` 标记只表示**本地资源**完整。
设置页、下载完成提示和打开离线包时都明确说明「N 个外部资源需联网，未保证完整离线」；
`offlineScope` 与外链数量不一致的包会被校验拒绝，不能伪装成完整离线。
在线回源取未缓存资源尚未实现：断网时这些资源不可用，本项不等于完整离线闭环。

## 真实服务端联调回归

先构建主 APK 和测试 APK，再明确指定专用测试设备：

```bash
ANDROID_SERIAL=<test-emulator> npm run test:android-backend -w @genoffice/viewer
```

脚本启动临时解析服务、上传含嵌入字体及未引用媒体的 PPTX，安装测试 APK，下载两次，
验证源哈希与本地模型/字体回放，并检查源解析仅一次；结束清理反向端口和临时服务数据。
离线清单按需构建为独立辅助产物，正常在线预览不会提前遍历媒体计算哈希。
脚本额外断言 `versionedCache=true`、`cleanupBytes>0`、`resumeVerified=true` 与
`rangeResponses>=1`：确认两次缓存打开只产生一个 generation 目录、清理入口只删非当前版本，
并在真机上预置半个媒体文件验证对真实服务端的 `If-Range` / `206` 链路确实续传。

本轮在华为 AGS5-W00 真机（Android 12 / API 31 / arm64-v8a）执行，输出
`ok / sourceHashesVerified / cachedSecondDownload / versionedCacheAndCleanup /
realBackendRangeResume` 均为 true，`sourceParses=1`；探针报告 `cacheBytes=962057`、
`cleanupBytes=4096`、`resumedPrefixBytes=163840`、`rangeResponses=1`，
服务端日志对 STORE 媒体记录 `206`、对 DEFLATE 媒体记录 `200`。
Gradle 构建需把 `JAVA_HOME` 指向 JDK 17（默认 GraalVM 21 的 jlink 会令
AGP 8.10.1 的 `androidJdkImage` 变换失败）。
