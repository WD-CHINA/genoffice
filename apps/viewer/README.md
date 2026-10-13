# GenOffice Web Viewer

独立的 Node.js + React 预览应用，提供 `.pptx`、`.pdf`、`.docx` 只读展示和 PPT 放映。当前已可运行；复杂文档的完整视觉还原仍在验收中。

改动范围仅为 `apps/viewer` 和新增的 `packages/viewer-renderers`、`packages/viewer-services`。现有 app、package、根配置及根锁文件不修改。

最新产品范围、三格式能力、界面约束及文件保留规则见 [需求文档](REQUIREMENTS.zh-CN.md)。

## 开发运行

要求 Node ≥22.12.0，以及已有仓库开发依赖。本阶段源码构建复用现有 monorepo 依赖，尚未提供仅安装 Viewer 源码依赖的 staging 安装器。以下命令在 `repo` 下执行，均不会调用其他 app 的启动或构建：

```sh
npm run dev -w @genoffice/viewer
```

打开 http://127.0.0.1:5180。同一局域网的设备使用 Vite 启动日志里的 Network 地址。Node API 默认端口为 3001，并监听所有网卡；服务端源码通过 esbuild watch 重建并重启，前端通过 Vite 更新。

生产方式运行：

```sh
npm run build -w @genoffice/viewer
npm run start -w @genoffice/viewer
```

打开 http://127.0.0.1:3001，或启动日志里打印的局域网地址。构建只写入本目录的 `dist`。设 `VIEWER_HOST=127.0.0.1` 可恢复为仅本机访问。

PPT 普通预览中点击音视频封面可打开原生播放器，提供播放/暂停和进度控制；按 Esc 或点击关闭退出，翻页会停止当前媒体。放映中点击媒体可播放/暂停。资源不存在或编码不被浏览器支持时会显示错误。

PPT 普通预览提供元素/文字链接、幻灯片跳转、原生下拉页码选择和缩放/适配，私有字体失败后自动重试并重新测量。PDF 提供缩略图、书签/标题目录、只读批注正文/回复、原生下拉页码选择、页码追踪和文档信息。Word 提供只读复制/链接、标题和书签导航、修订显示模式、页色、缩放和密码重试；混合分栏及跨节布局在原测量算法收敛后生成可见页面，大图使用原占位符与会话内 HTTP 资源链路。PDF/Word 搜索控件默认隐藏，搜索与高亮实现保留。

搜索控件隐藏时，`Ctrl/Cmd+F` 使用浏览器查找；`Ctrl/Cmd+ +/-` 缩放，非输入区域的 PageUp/PageDown 翻页。Word 可见快照与可访问正文保持一份辅助阅读树，键盘链接焦点会映射到可见页面。

## URL 导入

在顶部粘贴文件链接，点击“导入 URL”。Node 下载文件后，自动进入原有 PPTX、DOCX、PDF 预览/解析流程；PPT 可继续放映。支持带签名参数的链接、最多 5 次重定向、UTF-8 下载文件名，以及没有扩展名的下载地址（通过文件内容识别格式）。普通网页、需要浏览器登录的分享页不作为文档导入；此类文件请使用可直接下载的授权/签名链接。

下载流式写入 Viewer 文件目录，遵循现有大小限制和 Cookie 所有者隔离。超时、超限、无效内容或客户端取消时删除临时文件；会话失效后“重新打开”会使用原 URL 再次下载。HTTP 压缩响应会解码后校验，内容类型/名称与真实文件不符时拒绝导入。

程序调用继续使用现有两步接口（先通过 `/api/health` 初始化并保留 Cookie）：

```http
POST /api/files/import-url
Content-Type: application/json

{"url":"https://example.com/download?signature=..."}
```

成功返回 `201` 和 `{id,name,format,hash}`，再将 `id` 作为 `fileId` 调用 `POST /api/view-sessions`。URL 不会替代上传文件的随机 ID 或写入解析数据。

默认仅允许公网 HTTP/HTTPS 地址，每次重定向重新校验地址，DNS 解析后固定连接到已校验的 IP。需要读取内网文件服务（例如内部对象存储）时，在可信部署中设置 `VIEWER_URL_ALLOW_PRIVATE_NETWORK=true`；该配置同时允许本机/内网地址。不会转发 Viewer Cookie 或浏览器登录凭据，也不接受 URL 中内嵌的账号密码。

## 独立发布

```sh
npm run package -w @genoffice/viewer
```

生成 `apps/viewer/releases/genoffice-viewer/`。复制该目录到部署机器，在目录内执行：

```sh
npm ci --omit=dev
npm start
```

发布目录包含编译后的服务/Worker、Web 页面、原字体、HarfBuzz WASM、PDF.js 资源、运行时 manifest/lockfile 和许可证。唯一外部 npm 运行依赖为固定版本的 `playwright-core`，其余实现内联；运行不依赖原仓库和其他 app，也不执行根目录的 Electron postinstall。

Word 的 HTML/MHT altChunk 使用原 `html2docx` 转换器及 Playwright 驱动，部署机器需安装 Chrome/Chromium。普通 DOCX、PPTX、PDF 不要求服务端 Chrome。请使用与原程序一致的字体和浏览器环境进行视觉验收。

| 配置                               | 默认/用途                                                     |
| ---------------------------------- | ------------------------------------------------------------- |
| `VIEWER_HOST`                      | `0.0.0.0`；本机与局域网可访问，设为 `127.0.0.1` 则仅本机      |
| `VIEWER_PORT`                      | `3001`                                                        |
| `VIEWER_DATA_DIR`                  | 构建目录下 `.viewer-data`                                     |
| `VIEWER_MAX_UPLOAD_BYTES`          | 1 GiB                                                         |
| `VIEWER_SESSION_TTL_MS`            | 30 分钟                                                       |
| `VIEWER_URL_TIMEOUT_MS`            | 45000；整个 URL 下载流程的超时（毫秒）                        |
| `VIEWER_URL_ALLOW_PRIVATE_NETWORK` | false；可信部署中可设 true 导入内网地址                       |
| `VIEWER_FONT_DIR`                  | PPT 服务端附加字体目录                                        |
| `VIEWER_CHROME_PATH`               | Chrome/Chromium 可执行文件；默认探测系统安装                  |
| `VIEWER_ALLOWED_ORIGINS`           | 额外允许的 Origin，以逗号分隔；默认包含本地 Vite 的 5180 端口 |

`GET /api/health` 返回格式列表、`altChunkAvailable` 和活动会话续期间隔。Host 自动续期，失效时显示重新打开入口。上传文件使用随机 ID，接口不接受客户端任意文件路径。会话按 Cookie 隔离；切换文件关闭旧会话和 iframe；会话超时清理文件及 Worker。无编辑、保存写回和 AI 接口。

data 中的源文件在服务持续运行时，按“无活动会话且超过 TTL 未使用”删除，默认每 30 秒检查一次。服务重启会丢失内存文件/会话索引，但不会扫描清理磁盘残留文件；当前不能保证所有 data 文件在 30 分钟后删除。详细场景及待确认策略见 [需求文档的文件保留规则](REQUIREMENTS.zh-CN.md#6-会话有效期与-data-文件保留)。

## 验证

先构建，然后执行：

```sh
npm run typecheck -w @genoffice/viewer
npm run test -w @genoffice/viewer
npm run test:browser -w @genoffice/viewer
npm run test:reading -w @genoffice/viewer
npm run test:url -w @genoffice/viewer
npm run test:media -w @genoffice/viewer
npm run test:standalone -w @genoffice/viewer
```

浏览器测试需要本机 Chrome/Chromium，可通过 `VIEWER_CHROME_PATH` 指定。截图与生成的测试文件位于忽略提交的 `test-results`。独立运行测试在仓库外的临时目录执行运行时 `npm ci` 并启动服务。

核心内容组件保留原源码，PPT 没有整份转成图片/PDF，Word 没有改用其他文档渲染器。构建检查拒绝其他 app、Electron、AI provider/agent 运行时；原 `zip-gate` 使用的纯脱敏 helper 可继续复用。

[需求文档](REQUIREMENTS.zh-CN.md) · [开发计划](DEVELOPMENT_PLAN.zh-CN.md) · [交付状态与剩余验收](IMPLEMENTATION_STATUS.md) · [逐项功能审查](FEATURE_AUDIT.zh-CN.md)
