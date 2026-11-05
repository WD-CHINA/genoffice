# Office Viewer Android demo

把 `apps/viewer` 的 Web Viewer 嵌进 WebView，并从解析服务下载「已解析」的结果离线渲染。

## 工作方式

1. **下载**：设置页填写解析服务地址和文件 ID（sha256）。`BundleDownloader` 调用解析服务
   的会话接口，把**每页的解析模型**（`/v1/sessions/<id>/layout/slides/<i>`：Slide JSON +
   播放信息 + 媒体引用）、模型引用的媒体分片（图片 / 音频 / 视频）和嵌入字体拉取到
   `files/bundles/<fileId>/`，并把模型里的绝对 `.../v1/files/<id>/parts/...` URL 改写为
   同源相对路径；最后写 `manifest.json` 和 `complete` 标记。
2. **离线排版**：viewer 用 `?layout=client` 走 `pptx-model-session`：在 WebView 里调用
   `buildRenderSlide` 把解析模型排成渲染树，字宽由浏览器 canvas 实测回填（`measure` 循环），
   整个排版过程不联网，布局与在线预览一致。
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

- 排版在 WebView 主线程执行（`pptx-model-session`），页数很多的文档翻页时会有一小段布局
  时间；后续可以把 `buildRenderSlide` 挪进 Worker。
- 会话/离线包按 `fileId` 存放，没有做空间回收与多包管理。
- 演示用途：允许对 `127.0.0.1` 的明文 HTTP；正式产品应使用 HTTPS 服务端。
