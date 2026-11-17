# PPT 字体接入与符号兼容

PPT Viewer 现在接入 v0.13.18 已迁移的全部 66 个字体文件，并增加 6 个符号替代字体。
生成清单包含 76 个 CSS 字体族、651 条字体声明；声明数包含粗斜体和字符范围分段，不代表 651 套独立字体。

## 符号字体

完整覆盖现有引擎码表：Symbol 189、Wingdings 221、Wingdings 2 216、Wingdings 3 207、Webdings 222，共 1055 个映射。
字形使用 Noto 开放字体及现有引擎的 Unicode 对应关系，保留单色显示；这些是替代字形，不是微软原厂字体。
另提供 Unicode 符号及数学字符后备字体。

Wingdings/Webdings 同时支持普通字节与 `F0xx` 私用编码。布局先转换字节槽位，避免 `0xA0` 被当成不换行空格、字母槽位被大小写转换。
Symbol 保留原来的 Adobe Symbol → Unicode 解析路径，并覆盖未转换的私用槽位。PPTX 原文与文件不被修改。

## 字体、度量和别名

- 从私有 Word 字体 CSS、共享字体测量清单生成 PPT 清单，不另维护一份字号调整数字。
- 保留字体的字符范围、字号比例、上升/下降和行间度量；按 CSS 顺序处理重叠范围。
- 接入 Aptos、Calibri Light、Bookman、Century Gothic、Segoe UI、Montserrat、Nunito Sans、Poppins、DM Sans，以及已有中日韩、阿拉伯文、希伯来文、泰文、孟加拉文、泰米尔文字体。
- 保留 Cambria 的西里尔字符后备、Simplified Arabic / Traditional Arabic 的字体比例和专用脚本后备规则。
- WOFF2 使用从原文件生成的字形覆盖、字宽和垂直度量数据。复杂文字的连写、字距及各平台仿粗体差异，由浏览器反馈测量校正。
- 同一字体源只解析一次；浏览器只加载当前测量涉及的字体族。范围声明按清单顺序注册，文档关闭时清理自己创建的字体和别名。
- 文档嵌入字体优先于内置别名。字体缺失提示继续保留，例如 Palatino Linotype 仍使用衬线后备。

仅有系统 `local()` 来源的上游字体无法直接放进静态包，未伪装成内置原厂字体。CJK 子集之外的生僻字仍可能需要系统或嵌入字体。
这不是对任意 Office 字体、任意字符的完整覆盖承诺。

## 生成与维护

```bash
# 按 symbol-sources.json 的 URL 下载源码字体到同一目录，脚本验证 SHA-256
uv run --with fonttools python tools/build-viewer-symbol-fonts.py SOURCE_DIRECTORY
uv run --with fonttools --with brotli python tools/build-viewer-font-catalog.py
```

清单位于 `apps/viewer/src/web/metric-fonts.generated.ts`。
`fonts/catalog.json` 记录源文件、别名和声明；`catalog-provenance.json` 记录生成器、CSS 和测量清单的哈希。
`fonts/metrics/` 的 WOFF2 度量文件也记录原字体哈希；测试会阻止更新源文件后遗漏重新生成。
符号字体的许可文件随静态发布包一起复制。

## 验证

```bash
pnpm --filter @genoffice/viewer typecheck
pnpm --filter @genoffice/viewer test
pnpm --filter @genoffice/pptx-render test
pnpm --filter @genoffice/viewer package
pnpm --filter @genoffice/viewer test:ui

# 启动 Viewer 开发服务后；默认地址为 http://127.0.0.1:11042/
pnpm --filter @genoffice/viewer test:pptx-fonts
```

本轮结果：Viewer 153 项、PPT 渲染 433 项测试通过，类型和格式检查通过。
三格式 UI 回归覆盖明暗主题、320/375/768/1440 像素、短视口、触摸与嵌入模式。
Chrome 字体矩阵包含 30 组样例；西文字体的初始度量与真实 Canvas 一致。
服务端模型路径使用真实解析模型、实际 Worker 和字体文件验证，HTTP 传输为模拟；未据此声称真实后端联调通过。

Android 调试 APK 已重建并安装，以 WebView 114 从 APK 静态资源打开字体矩阵：30 组字体加载成功，浏览器校正后的 24 段西文宽度与绘制尺寸一致，外网资源请求为零。
该测试使用已有离线文件启动 APK 的本地资源服务，再通过本地文件输入验证字体，不清理设备缓存或应用数据；结束后恢复 USB 转发。
旧 WebView 的部分仿粗体初始字宽与桌面不同，因此 Android 断言最终校正宽度，不要求两个浏览器的初始估算相等。

设备回归命令（先运行桌面字体矩阵，生成测试文件与基准）：

```bash
ANDROID_SERIAL=DEVICE \
ANDROID_FONT_BOOTSTRAP_FILE_ID=EXISTING_CACHED_PPTX_SHA256 \
pnpm --filter @genoffice/viewer test:android-pptx-fonts
```

证据默认输出 `/tmp/genoffice-pptx-fonts/`，包含桌面/Android 截图及结构化报告。
