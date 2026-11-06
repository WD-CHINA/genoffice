# Office Viewer Android demo

把 `apps/viewer` 的 Web Viewer 嵌进 WebView，并从解析服务下载「已解析」的结果离线渲染。

## 工作方式

1. **下载**：设置页填写解析服务地址和文件 ID（sha256）。`BundleDownloader` 调用解析服务
   的会话接口，把**每页的解析模型**（`/v1/sessions/<id>/layout/slides/<i>`：Slide JSON +
   播放信息 + 媒体引用）、模型引用的媒体分片（图片 / 音频 / 视频）和嵌入字体拉取到
   `files/bundles/<fileId>/`，并把模型里的绝对 `.../v1/files/<id>/parts/...` URL 改写为
   同源相对路径；最后写 `manifest.json` 和 `complete` 标记。
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
VIEWER_BASE=/viewer/ node scripts/build.mjs
rm -rf releases/genoffice-viewer && mkdir -p releases/genoffice-viewer
cp -R dist/web/. releases/genoffice-viewer/

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
  com.genoffice.viewerdemo.test/android.test.InstrumentationTestRunner
```
