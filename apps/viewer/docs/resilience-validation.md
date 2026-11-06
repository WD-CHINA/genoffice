# Viewer 稳定性验证

## 四组验收场景

| 场景 | 自动检查 | 验收边界 |
| --- | --- | --- |
| 连续放映超过两小时 | `test:soak` 默认真实运行 7500 秒；前 20 分钟停留单页，此后每 30 秒跳页；检查 HTTP 错误、浏览器异常与回收后 JS 堆 | 使用 50 页合成文档和桌面 Chromium；移动视口可独立运行。另有真机 WebView 离线脚本；设备温升、完整 GPU/原生内存与音视频长播需另外验证 |
| 快速跳页 | 50 页间连续跳转 40 次，定位最后一页后确认请求停止 | 使用播放器同一键盘命令入口；不覆盖所有触摸手势或网络条件 |
| 动画期间预加载 | 当前页执行 2 秒退场动画，在约 600ms 时放行延迟的下一页请求；验证画面变化并按原时间完成，下一次点击能够翻页 | 注入可重复的测试动画，不修改原文件；未穷举所有动画类型 |
| 大视频离线下载 | Android instrumentation 下载 1 GiB 媒体数据，检查文件大小与首尾内容；随后模拟响应截断、HTTP 失败，验证旧包与会话清理 | 合成 `.mp4` 数据用于下载链路测试，不验证视频解码；需要设备至少 2 GiB 可用空间 |

## 执行

```bash
npm run typecheck -w @genoffice/viewer
npm run test -w @genoffice/viewer
npm run typecheck -w @genoffice/parse-server
npm run test -w @genoffice/parse-server
npm run test:resilience -w @genoffice/viewer
npm run test:soak -w @genoffice/viewer
```

移动端视口与独立报告：

```bash
MOBILE_VIEWER=1 VIEWER_TEST_PORT=11018 SOAK_SECONDS=7500 \
RESILIENCE_REPORT=/tmp/genoffice-viewer-mobile-soak.json \
node --import tsx apps/viewer/scripts/resilience-smoke.mts
```

脚本启动临时解析服务、Vite 和无界面 Chromium，结束时清理服务和临时文档。
默认报告 `/tmp/genoffice-viewer-resilience.json` 每 30 秒更新。
`status=running` 表示尚未完成，只有 `status=passed` 且 `elapsedSoakSeconds >= 7500`
才代表超过两小时实测通过。可用 `TEST_SLIDES` 增加文档页数，`CHROME_PATH` 指定浏览器。
实际持续运行中相邻采样中断超过 90 秒会失败，避免设备休眠被计作连续放映。
脚本强制 GC 后采样 JS 堆，预热后相对基准增长超过 64 MiB 即失败；这不是整个浏览器进程内存上限。

单元测试另有模拟 125 分钟的客户端心跳与服务端会话回收检查。这些测试通过不等于真实持续运行通过。

## 本次修复

- 在线会话和离线下载增加每分钟续期，模型接口同步更新会话清理时间。
- 媒体签名默认有效期延至 12 小时；超过此期限仍须重新打开文档。
- 放映页独立驱动预加载、图片保留和模型淘汰；回收无引用的文字测量缓存。
- 同页加载复用进行中的请求；Worker 串行处理异步加载、排版与淘汰，忽略已处理或淘汰的测量反馈。
- 动画初始化只跟随当前页及其动画数据变化，预加载其他页面不再重置动画。
- Android 媒体与字体以 64 KiB 缓冲流式写盘；截断响应不发布；新包完成后替换旧包，失败清理会话与暂存目录。

尚未增加断点续传、离线包自动回收、外链媒体离线化及断网后在线会话自动重建。

## Android WebView 实际离线渲染

先按 Android README 构建并安装最新 APK，再连接开启 USB 调试的设备：

```bash
# 短回归：下载 50 页包，关停解析服务并撤销转发，重新加载后快速跳页 40 次
node --import tsx apps/viewer/scripts/android-offline-smoke.mts
# 同一路径再真实放映 125 分钟，每 30 秒跳页并记录 JS 堆与主进程 PSS
SOAK_SECONDS=7500 RESILIENCE_REPORT=/tmp/genoffice-android-offline-soak.json \
node --import tsx apps/viewer/scripts/android-offline-smoke.mts
```

此脚本操作演示应用并将测试文档留在应用缓存中；连接设备需保持 USB 在线。
WebView 请求若访问任何非本机 HTTP 域名即失败。关停服务和撤销转发用于验证服务端不可达时的离线渲染，不会修改设备的 Wi-Fi 或蜂窝网络设置。

## 2026-11-06 长测结果

- Web 在线：`passed`，实际运行 7500.057 秒，采样 251 次；最后一次 JS 堆 21539956 字节。
- Android 真机离线：`passed`，实际运行 7500.486 秒，采样 247 次；最后一次 JS 堆 7816700 字节。

两项均超过 125 分钟。该结果验证持续运行与异常检查，不代表已逐帧确认完全无闪屏。
