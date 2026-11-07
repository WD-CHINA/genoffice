# Office Viewer Android demo

把 `apps/viewer` 的 Web Viewer 嵌进 WebView，并从解析服务下载「已解析」的结果离线渲染。

## 工作方式

1. **下载**：设置页填写解析服务地址和文件 ID（sha256）。创建 v2 异步会话并等待 ready，
   仅 404/405 回退 v1。优先读取 `/v2/sessions/<id>/bundle` 权威清单，按声明的大小和
   SHA-256 下载模型、嵌入字体及全部 `ppt/media` 资源（包括未引用媒体），逐文件验证后
   原子发布至 `files/bundles/<fileId>/`。现代包保留模型内部路径，字体按 `resourcePath`
   定位；仅清单接口 404/405 时使用旧版资源发现及 URL 改写流程。
2. **离线排版**：viewer 走 `pptx-model-session` + `pptx-model-worker`：排版引擎在 Worker 里
   把解析模型排成渲染树，字宽由浏览器 canvas 实测回填。宽度回传只重建**依赖这些 key 的页**；
   离屏页（保留当前页 ±1 和可见缩略图）连同模型一起淘汰，回访时按需重新拉取。
   Web 端同样默认走这条路径，`?layout=server` 可回退到服务端渲染树。
3. **离线渲染**：`LocalAssetServer` 在 `127.0.0.1` 上同时提供
   - `/viewer/*`：打进 APK assets 的 Web Viewer 静态资源；
   - `/v1/*`：按解析服务契约回放本地离线包（sessions / layout / fonts / parts）。媒体分片
     支持 Range，`<video>` 可以直接拖动进度条。

   页面与 API 同源，因此不涉及 CORS、canvas 也不会被跨域像素污染；音视频播放使用的
   是本地缓存文件。

## 构建

```bash
# 1. 构建 Web Viewer 发布目录（Gradle 会把它同步进 assets）
cd apps/viewer
npm run package

# 2. 构建 APK
cd android-demo
./gradlew assembleDebug
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
- 会话/离线包按 `fileId` 存放，没有做空间回收与多包管理。
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
客户端根据已配置服务地址和受校验的资源路径构造请求。包含外部媒体时目前拒绝完整离线下载，
部分离线与在线提示仍待实现。当前仍按 fileId 存包；版本目录、续传、缓存配额及清理界面待完成。

已在 Android 36.1 只读 ARM64 模拟器执行 `BundleDownloaderTest`：最新完整 19 项通过，
包含 1 GiB 下载及故障恢复。真机验证尚未完成。

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
缓存配额与清理界面仍待完成。

本轮空间故障验证使用可注入的空闲探针，不填满设备磁盘：完整 15 项测试通过，
已知大小资源在预检失败时保留旧包；未知长度媒体在实际写入部分数据后模拟空间耗尽，
确认临时数据清理、会话关闭和旧包哈希仍有效。

## 真实服务端联调回归

先构建主 APK 和测试 APK，再明确指定专用测试设备：

```bash
ANDROID_SERIAL=<test-emulator> npm run test:android-backend -w @genoffice/viewer
```

脚本启动临时解析服务、上传含嵌入字体及未引用媒体的 PPTX，安装测试 APK，下载两次，
验证源哈希与本地模型/字体回放，并检查源解析仅一次；结束清理反向端口和临时服务数据。
离线清单按需构建为独立辅助产物，正常在线预览不会提前遍历媒体计算哈希。
