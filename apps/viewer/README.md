# GenOffice Web Viewer

独立的 Node.js + React 预览应用，提供 `.pptx`、`.pdf`、`.docx` 只读展示和 PPT 放映。当前已可运行；复杂文档的完整视觉还原仍在验收中。

改动范围仅为 `apps/viewer` 和新增的 `packages/viewer-renderers`、`packages/viewer-services`。现有 app、package、根配置及根锁文件不修改。

## 开发运行

要求 Node ≥22.12.0，以及已有仓库开发依赖。本阶段源码构建复用现有 monorepo 依赖，尚未提供仅安装 Viewer 源码依赖的 staging 安装器。以下命令在 `repo` 下执行，均不会调用其他 app 的启动或构建：

```sh
npm run dev -w @genoffice/viewer
```

打开 http://127.0.0.1:5180。Node API 默认端口为 3001；服务端源码通过 esbuild watch 重建并重启，前端通过 Vite 更新。

生产方式运行：

```sh
npm run build -w @genoffice/viewer
npm run start -w @genoffice/viewer
```

打开 http://127.0.0.1:3001。构建只写入本目录的 `dist`。

PPT 普通预览中点击音视频封面可打开原生播放器，提供播放/暂停和进度控制；按 Esc 或点击关闭退出，翻页会停止当前媒体。放映中点击媒体可播放/暂停。资源不存在或编码不被浏览器支持时会显示错误。

PPT 普通预览提供元素/文字链接、幻灯片跳转、页码输入和缩放/适配，私有字体失败后自动重试并重新测量。PDF 提供缩略图、书签/标题目录、逐项搜索高亮、只读批注正文/回复、页码追踪和文档信息。Word 提供只读搜索/复制/链接、标题和书签导航、修订显示模式、页色、缩放和密码重试；混合分栏及跨节布局在原测量算法收敛后生成可见页面，大图使用原占位符与会话内 HTTP 资源链路。

`Ctrl/Cmd+F` 聚焦 PDF/Word 搜索，`Ctrl/Cmd+ +/-` 缩放，非输入区域的 PageUp/PageDown 翻页。Word 可见快照与可访问正文保持一份辅助阅读树，键盘链接焦点会映射到可见页面。

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

| 配置                      | 默认/用途                                                     |
| ------------------------- | ------------------------------------------------------------- |
| `VIEWER_HOST`             | `127.0.0.1`                                                   |
| `VIEWER_PORT`             | `3001`                                                        |
| `VIEWER_DATA_DIR`         | 构建目录下 `.viewer-data`                                     |
| `VIEWER_MAX_UPLOAD_BYTES` | 64 MiB                                                        |
| `VIEWER_SESSION_TTL_MS`   | 30 分钟                                                       |
| `VIEWER_FONT_DIR`         | PPT 服务端附加字体目录                                        |
| `VIEWER_CHROME_PATH`      | Chrome/Chromium 可执行文件；默认探测系统安装                  |
| `VIEWER_ALLOWED_ORIGINS`  | 额外允许的 Origin，以逗号分隔；默认包含本地 Vite 的 5180 端口 |

`GET /api/health` 返回格式列表、`altChunkAvailable` 和活动会话续期间隔。Host 自动续期，失效时显示重新打开入口。上传文件使用随机 ID，接口不接受客户端任意文件路径。会话按 Cookie 隔离；切换文件关闭旧会话和 iframe；会话超时清理文件及 Worker。无编辑、保存写回和 AI 接口。

## 验证

先构建，然后执行：

```sh
npm run typecheck -w @genoffice/viewer
npm run test -w @genoffice/viewer
npm run test:browser -w @genoffice/viewer
npm run test:reading -w @genoffice/viewer
npm run test:media -w @genoffice/viewer
npm run test:standalone -w @genoffice/viewer
```

浏览器测试需要本机 Chrome/Chromium，可通过 `VIEWER_CHROME_PATH` 指定。截图与生成的测试文件位于忽略提交的 `test-results`。独立运行测试在仓库外的临时目录执行运行时 `npm ci` 并启动服务。

核心内容组件保留原源码，PPT 没有整份转成图片/PDF，Word 没有改用其他文档渲染器。构建检查拒绝其他 app、Electron、AI provider/agent 运行时；原 `zip-gate` 使用的纯脱敏 helper 可继续复用。

[开发计划](DEVELOPMENT_PLAN.zh-CN.md) · [交付状态与剩余验收](IMPLEMENTATION_STATUS.md) · [逐项功能审查](FEATURE_AUDIT.zh-CN.md)
