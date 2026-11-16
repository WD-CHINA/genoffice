# Viewer 稳定性验证

> 本文接口名称与配置按 [API v1](../../../docs/api-v1.zh-CN.md) 统一整理；历史测量结果保留，不代表新一轮验收。

> 2026-11-12：当前执行时长改为每模式 1 小时；历史实测数字保留原条件。当前架构、边界与本轮完整结果见[架构主文档](../../../docs/runtime-workflows.zh-CN.md)、[运行边界](../../../docs/runtime-boundaries.zh-CN.md)和[测试指南](../../../docs/testing-guide.zh-CN.md)。

## 四组验收场景

| 场景            | 自动检查                                                                                                             | 验收边界                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 连续放映 1 小时 | `test:soak` 默认真实运行 3600 秒；前 20 分钟停留单页，此后每 30 秒跳页；检查 HTTP 错误、浏览器异常与回收后 JS 堆     | 使用 50 页合成文档和桌面 Chromium；移动视口可独立运行。另有真机 WebView 离线脚本；设备温升、完整 GPU/原生内存与音视频长播需另外验证 |
| 快速跳页        | 50 页间连续跳转 40 次，定位最后一页后确认请求停止                                                                    | 使用播放器同一键盘命令入口；不覆盖所有触摸手势或网络条件                                                                            |
| 动画期间预加载  | 当前页执行 2 秒退场动画，在约 600ms 时放行延迟的下一页请求；验证画面变化并按原时间完成，下一次点击能够翻页           | 注入可重复的测试动画，不修改原文件；未穷举所有动画类型                                                                              |
| 大视频离线下载  | Android instrumentation 下载 1 GiB 媒体数据，检查文件大小与首尾内容；随后模拟响应截断、HTTP 失败，验证旧包与会话清理 | 合成 `.mp4` 数据用于下载链路测试，不验证视频解码；需要设备至少 2 GiB 可用空间                                                       |

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
MOBILE_VIEWER=1 VIEWER_TEST_PORT=11018 SOAK_SECONDS=3600 \
RESILIENCE_REPORT=/tmp/genoffice-viewer-mobile-soak.json \
node --import tsx apps/viewer/scripts/resilience-smoke.mts
```

脚本启动临时解析服务、Vite 和无界面 Chromium，结束时清理服务和临时文档。
默认报告 `/tmp/genoffice-viewer-resilience.json` 每 30 秒更新。
`status=running` 表示尚未完成，只有 `status=passed` 且 `elapsedSoakSeconds >= 3600`
才代表当前 1 小时验收通过。可用 `TEST_SLIDES` 增加文档页数，`CHROME_PATH` 指定浏览器。
实际持续运行中相邻采样中断超过 90 秒会失败，避免设备休眠被计作连续放映。
脚本强制 GC 后采样 JS 堆，预热后相对基准增长超过 64 MiB 即失败；这不是整个浏览器进程内存上限。

单元测试另有模拟 125 分钟的客户端心跳与服务端会话回收检查。这些测试通过不等于真实持续运行通过。

## 历史实现记录（非当前完成度）

- 在线会话和离线下载增加每分钟续期，模型接口同步更新会话清理时间。
- 媒体签名默认有效期延至 12 小时；超过此期限仍须重新打开文档。
- 放映页独立驱动预加载、图片保留和模型淘汰；回收无引用的文字测量缓存。
- 同页加载复用进行中的请求；Worker 串行处理异步加载、排版与淘汰，忽略已处理或淘汰的测量反馈。
- 动画初始化只跟随当前页及其动画数据变化，预加载其他页面不再重置动画。
- Android 媒体与字体以 64 KiB 缓冲流式写盘；截断响应不发布；新包完成后替换旧包，失败清理会话与暂存目录。

早期记录：尚未增加断点续传、离线包自动回收、外链媒体离线化及断网后在线会话自动重建。此句保留当时状态，后续已实现的下载、续传及缓存处理以当前架构主文档为准。

## 2026-11-10 签名过期与能力探测（Web）

- 新增 `src/web/capabilities.ts`：打开会话前探测 `/v1/capabilities`（1.5 s 超时、按 origin 缓存 5 分钟、失败回退旧行为）；服务端显式 `asyncSessions=false` 时直接同步创建，`incrementalPreview=false` 时不展示首屏预览。
- 新增 `src/web/signed-url.ts`：解析 part URL 的 `exp`/`sig`，提前 60 s 判定过期并识别部署 origin 变化。DOCX 随机访问/顺序加载命中过期签名的缓存 chunk 时自动重取描述；PPTX 音视频 mediaRef 同样刷新。缓存模型不失效，只替换资源描述，因此不再需要因签名过期重开文档。
- PPTX 模型路径同样接入：worker 缓存的 layout slide/source 若含过期 `exp/sig` 或旧部署 origin，会在复用前 `refresh` 并重取该页描述（图片 `media` 引用与音视频 mediaRef 一并更新）；测试 `pptx-signed-refresh.test.ts` 覆盖“已加载页 → 过期 → refresh → 新签名”。
- 未覆盖：嵌入字体走 Authorization 的 token 轮换、真实浏览器下的 403/换域名端到端验收；上面的 12 小时有效期仍作为缓存上限。

## Android WebView 实际离线渲染

先按 Android README 构建并安装最新 APK，再连接开启 USB 调试的设备：

```bash
# 短回归：下载 50 页包，关停解析服务并撤销转发，重新加载后快速跳页 40 次
node --import tsx apps/viewer/scripts/android-offline-smoke.mts
# 同一路径再真实放映 60 分钟，每 30 秒跳页并记录 JS 堆与主进程 PSS
SOAK_SECONDS=3600 RESILIENCE_REPORT=/tmp/genoffice-android-offline-soak.json \
node --import tsx apps/viewer/scripts/android-offline-smoke.mts
```

此脚本操作演示应用并将测试文档留在应用缓存中；连接设备需保持 USB 在线。
WebView 请求若访问任何非本机 HTTP 域名即失败。关停服务和撤销转发用于验证服务端不可达时的离线渲染，不会修改设备的 Wi-Fi 或蜂窝网络设置。

## 2026-11-06 长测结果

- Web 在线：`passed`，实际运行 7500.057 秒，采样 251 次；最后一次 JS 堆 21539956 字节。
- Android 真机离线：`passed`，实际运行 7500.486 秒，采样 247 次；最后一次 JS 堆 7816700 字节。

两项均超过 125 分钟。该结果验证持续运行与异常检查，不代表已逐帧确认完全无闪屏。
