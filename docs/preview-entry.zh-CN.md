# Web 与 Android 统一预览入口

## 地址约定

已上传或已下载的 PPTX、DOCX、PDF 共用 `preview.html?fileId=<文件ID>`。入口是静态 HTML，可部署在根目录或 `/viewer/` 等子目录，无需额外的服务端路由重写。

| 场景         | 地址                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| 同源 Web     | `/viewer/preview.html?fileId=<文件ID>`                                       |
| 独立解析服务 | `/viewer/preview.html?fileId=<文件ID>&server=<编码后的服务地址>`             |
| Android 离线 | `http://127.0.0.1:<动态端口>/viewer/preview.html?fileId=<文件ID>&theme=light` |
| 本地文件     | `preview.html?src=<编码后的blob地址>&format=pptx`                            |

`server` 仅在不同源或使用独立 API 路径前缀时传入。`token` 仅在非空时携带。`name` 只用于友好文件名；与文件 ID 相同的占位名称省略。客户端布局为默认值，仅显式要求服务端排版时携带 `layout=server`。界面开关只写与默认值不同的配置，隐藏大多数控件时使用 `embed=1` 加必要覆盖值。

Android 默认传入 `theme=light`；设置页支持持久选择跟随系统或深色，在线与离线共用相同主题解析。跟随系统在打开预览时转换为明确的 light/dark，不在地址中增加系统模式参数。

## 打开过程

- Web 上传结果、本机记录和历史库直接链接预览页；Android 在线与已缓存文档也直接加载预览页。页面不经过首页及其 iframe。
- 预览页按同源地址或指定 server 请求一次 `/v1/files/:id`，识别文件格式。远端预览不接受 format 提示，统一以文件信息为准。
- PPTX/DOCX 打开模型会话，继续原有媒体转换、签名刷新、缓存与布局流程；无需用 `src` 重复携带原文件地址。
- 受鉴权 PDF 在入口内部获取一次 `content-url`，PDF.js 仍读取原文件；签名地址不再嵌套到新生成的预览 URL 中。
- Android 离线由 LocalAssetServer 返回相同文件信息与资源。回放不请求外部服务，不修改离线包格式；在线与离线只在服务来源上不同。
- 无文件的 Android 在线打开仍进入可选文件的首页。Web 交互首页保留本地选择、URL 导入与解析位置切换，内部嵌入预览页以隔离文档生命周期。

旧长链接、`url`/`contentUrl` 参数、远端 `src/format` 组合、`src=bundle` 和首页 `fileId/url` 自动打开链接不再支持，直接显示错误，不重定向或请求文件。远端仅使用 fileId；本地源须同时提供 src 和 format。当前参数仍使用 URLSearchParams/Uri 编码，文件签名和令牌中的 `&`、`+` 不会成为额外参数。元信息、鉴权或签名请求失败时显示明确错误并提供重试；关闭页面取消未完成的入口请求。

## 验证入口

```sh
npm test -w @genoffice/viewer
npm run typecheck -w @genoffice/viewer
npm run package -w @genoffice/viewer
npm run test:preview-entry -w @genoffice/viewer
npm run test:library -w @genoffice/viewer
npm run test:ui -w @genoffice/viewer
```

`test:preview-entry` 使用已打包的生产页面和隔离解析服务，覆盖三格式的同源短链接、独立服务短链接，共六个正常场景，并验证十二个旧链接被拒绝及鉴权失败。检查每次只有一次文档导航、没有嵌套 iframe、元信息只读取一次、受鉴权 PDF 只获取一次签名；PPTX/DOCX 不预先下载原文件。

本轮命令、日志、截图与设备结果位于 `/tmp/genoffice-preview-entry-20261116/`，业务原文件只读。业务 PPT 继续使用 SHA-256 核对一致的《南宁天桃实验.pptx》私有副本，测试产物不进入仓库。

## 本轮结果与边界

- Viewer 单元测试 141 项通过；新增短链接解析、签名请求、错误/取消及界面开关组合覆盖。类型检查、ESLint、格式与差异检查通过。
- 生产页面六个新入口场景和十二个旧入口拒绝场景通过；上传/历史库直达预览、DOCX 缓存与会话恢复、三格式主题/视口/触摸控件回归通过。
- Android 应用和测试 APK 构建通过，Instrumentation 46 项通过。业务 PPT 在线与物理断网冷启动均验证 16 页、13 个媒体的播放及播放中定位，预览/放映按钮实际触控通过；断网时外部请求为 0。
- 业务 DOCX 与 PDF 样本在设备上分别完成在线、下载打开、物理断网后冷启动，共六个场景。检查顶层预览、无 iframe、精简参数与正文/页面可见。PDF 为一页生成样本，不代表复杂 PDF 视觉验收。
- 设备网络设置和 USB 映射在验证后恢复；业务文件只读，不改变原文件、离线包格式或转码策略。

**未通过项单独保留：** 当前 Android WebView 对该 PPT 的 `ppt/media/media5.mp4` 在首次播放前进行暂停定位时可停留在 seeking，原有媒体探针因此超时；开始播放后定位完成且继续推进。`android-business.log`、`android-business-ready.log` 和 `seek-probe.json` 保留失败及阶段记录。原有暂停定位断言未删除；`extended-online.json` / `extended-offline.json` 明确使用“播放中定位”验证，不能当作暂停定位也已通过。这项行为需要单独排查，不能据此宣称所有播放边界均已解决。

## 不保留旧预览链接

旧地址不自动转换，不回退到首页导入，也不使用 URL 中的 format 或签名地址绕过元信息读取。上传、历史库、像素、长稳和阅读演练均改用新入口；历史结果只反映各自执行时的代码。本轮收口证据位于 `/tmp/genoffice-preview-strict-20261116/`，上轮兼容成功场景不再作为当前功能要求。

移除旧链接支持后的收口复验：141 项 Web 单元测试、六个生产页面新入口场景、十二个旧入口拒绝场景通过；资源库/连续 DOCX 回归、PPT 像素等价与五秒短时放映演练通过。Android 已重新构建并安装，PPTX/DOCX/PDF 的三个缓存短链接正常打开，六个旧入口均在请求文件前被拒绝。本次未重复全量媒体和长稳演练，前述暂停定位限制仍保留。
