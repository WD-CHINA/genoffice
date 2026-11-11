# Android PDF 原文件离线阅读验收

日期：2026-11-11。本轮把 PDF 接入现有 Android 下载、完整性校验和版本缓存，
复用 Web PDF.js 阅读器。环境为本机 Docker 解析服务、Web 预览及 Android 12 / Chromium 114 平板。

## 加载与缓存

1. 下载器读取鉴权的 `GET /v1/files/<fileId>`，验证 `format=pdf`、正整数大小和 SHA-256；
   内容寻址的 `fileId` 必须与哈希一致。
2. 从 `GET /v1/files/<fileId>/content` 流式下载原文件，复用现有 Range 续传、ETag / Content-Range
   核对、空间预检及增量 SHA-256。PDF 不创建解析会话或媒体任务。
3. 原件保存为 `document.pdf`，来源元数据与资源校验记录写入清单。
   本地版本身份由 `genoffice-pdf-original-v1` 和原件哈希派生；封存验证完成后原子切换当前版本。
   下载失败或取消时保留当前可用文件，离线文件纳入现有 2 GiB 缓存配额。
4. 打开时重新验证本地完整性。本机 HTTP 服务提供文件元数据和同源 content 地址，支持
   GET / HEAD、Range 206、无效范围 416、ETag 及 If-Range。
5. PDF.js 直接解析原件，并按可见页面绘制。Worker、CMap、标准字体及 WASM 已随 APK 打包。
   PDF 清单不含服务端分页模型，`unitCount=0` 不代表 PDF 页数；实际页数由 PDF.js 读取。

加密 PDF 的密码处理继续沿用现有阅读器。本轮业务样本没有加密，未新增密码存储。

## 真机发现与修复

- 当前锁定的 PDF.js 使用 ReadableStream 异步迭代提取文字，Chromium 114 缺少该接口，
  实际打开曾报 `readableStream is not async iterable`。兼容层仅在接口缺失时安装，
  使用 reader 逐块读取，覆盖读完、失败、提前返回、取消及 preventCancel 时的锁释放语义。
  现代内核保留原生实现，行为参考 [Streams 标准](https://streams.spec.whatwg.org/#rs-asynciterator)。
- 横纵混排文档按当前页自适应缩放时，所有页面尺寸变化会使阅读位置跳走。
  当前在缩放前记录源页与页内偏移，布局更新后恢复位置，并关闭浏览器重复滚动锚定。
  24 页混排样本可连续遍历至末页。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Viewer 测试 | 122 通过，包括旧内核流迭代、异常与取消时释放锁 |
| Android 仪器测试 | 45 通过，包括原 PDF 下载、本地协议、续传、坏哈希保护旧包、空间不足及取消 |
| 浏览器本地 PDF | 真实教案 4 页、横纵混排诊断文件 24 页全部遍历，阻断解析服务请求后仍可通过 Blob URL 阅读 |
| 真机在线与离线 PDF | 同两份文件共 28 页，在线与冷启动离线均逐页绘制和文字层检查通过 |
| 离线完整性 | 设备上的原件大小及 SHA-256 与来源一致，本地 Range 32 字节与原件完全相同 |
| 离线依赖 | 冷启动后远程服务不可达，未发现外部资源请求；本地 CMap / 标准字体 / WASM 可读取 |
| 既有功能回归 | 真实 Word 教案在线 / 离线 5 页通过；WMV / WMA 课件兼容 MP4 在线 / 离线播放、拖动和放映通过 |
| 静态检查与构建 | Viewer 类型检查、定向 ESLint、Git 空白检查、Web 发布包和 debug APK 构建通过 |

真实 PDF 来自用户指定的「06-课件与教案」目录，原件只读，SHA-256 保持不变。
业务样本包含中文、合并表格和插图；将设备实际截图与 Poppler 渲染的原件首屏对照，未发现本轮引入的明显缺失。
24 页诊断文件为自行生成的横纵混排与标准字体样本，不作为生产容量结论。

断连方法为移除设备到 Viewer 和解析服务的 USB reverse 映射，强制停止应用并重新从离线缓存打开，
遍历页面后确认远程请求失败。未更改 Wi-Fi 或飞行模式；验证范围是本应用依赖的远端服务不可达。
测试保留用户应用数据，仪器测试使用隔离缓存，结束后恢复原端口映射。
最终 APK 再次断开远端服务冷启动，业务 PDF 的本地元数据、Range 及首页绘制通过；
设备停留在业务 PDF 的本地缓存首页。

## 复现

构建和安装见 [Android demo](../apps/viewer/android-demo/README.md)。启动本机 Viewer 和解析服务，
上传 PDF 后，把返回的文件 ID 写入私有 JSON：

```json
[{ "name": "business", "fileId": "64位sha256", "expectedPages": 4 }]
```

`name` 使用字母、数字、下划线、点或短横线，`expectedPages` 可省略。

```bash
ANDROID_SERIAL=<目标设备> PARSE_SERVER_TOKEN=<令牌> \
ANDROID_PDF_INPUTS=/tmp/private-pdf-inputs.json \
ANDROID_PDF_EVIDENCE_DIR=/tmp/genoffice-pdf-offline/device \
npm run test:android-pdf -w @genoffice/viewer
```

脚本通过指定设备的 USB reverse 访问默认 Viewer 11019、解析服务 18787，可通过
`ANDROID_VIEWER_URL` / `PARSE_SERVER_URL` 调整；此断连验证只接受带端口的 loopback HTTP 地址。
脚本验证原件、冷启动回放及本地 Range，遍历的样本应包含可提取文字。

本机私有证据位于 `/tmp/genoffice-pdf-offline/`，业务原件和派生截图不提交到 Git：

- `android-tests.log`、`viewer-tests.log`：测试结果。
- `device/results.json`、同目录清单与屏幕截图：真机在线 / 离线结果。
- `web-results.json`：浏览器本地加载结果。
- `business-reference.png`：Poppler 渲染参考首屏。
- `source-integrity.json`：业务原件校验。
- `final-device-state.json`、`business-device-final.png`：最终 APK 的断连冷启动和设备首页。
- `word-regression/`、`ppt-regression/`：原有功能回归。

## 验收边界

本轮覆盖一份业务 PDF 和一份 24 页诊断文件，尚未覆盖扫描件 OCR、复杂加密文档及极大页数容量。
PDF 首屏仍会扫描全部页面尺寸和表单，首屏优先加载的优化留待后续。
普通浏览器断网重启网站所需的站点缓存尚未接入；本轮新增的是 Android 原文件离线下载与本地回放。
