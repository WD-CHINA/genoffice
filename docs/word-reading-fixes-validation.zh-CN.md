# Word 阅读与 Android 离线修复验收

日期：2026-11-11。接续 [阅读上下文修复](parse-viewer-fixes-validation.zh-CN.md) 和
[Android 媒体验收](android-media-validation.zh-CN.md)，本轮处理远程 Word 阅读的五项缺口。

## 修复结果

| 问题 | 当前行为 |
| --- | --- |
| 只有脚注标记，没有正文 | 使用已有编号、字体和富文本规则测量注释；脚注在页面预留空间，长脚注生成续页，尾注在相应节或文档末尾显示 |
| 长段落撑高纸张 | 按实际行边界分页，保留孤行控制、段中分页符、keepLines 和 keep-with-next；阅读锚点跟随原文位置 |
| 表格按段落数估算切分 | 按各单元格实际行带寻找切点，保留原表格并裁剪展示，包含合并单元格、嵌套表格及重复表头；不再按段落数比例重建业务表格 |
| 未加载完正文时总页数误导 | NUMPAGES 暂显 `…`，全部正文分块加载后显示实际分页总数 |
| Android 拒绝 Word 离线下载 | 导出并校验 DOCX 权威清单，本机回放正文、样式、注释、页眉页脚、图片及嵌入字体 |

真机检查还修复了深色界面下 Word 纸张变黑的问题，以及 WebView 亚像素浮点误差引起的重复测量。
页面使用白色纸张，原文文字颜色仍按文档样式展示。相同几何的细微浮点误差不会触发新一轮排版。

分页索引只保存数值和源块引用，源模型保持不变，可见窗口以外的正文模型继续按原机制淘汰。
续页展示原始块的连续裁剪区间，避免在拆分中删除合并关系或嵌套内容；重复表头另留实际测量高度。

## 离线包与缓存

DOCX 使用现有不可变 artifact、派生包、租约和共享 catalog。权威清单包含 `document.json`、
`styles.json`、`units/<n>.json`、嵌入字体，以及全部 `word/media`、`word/embeddings`，
每个资源带大小及 SHA-256。资源在读取时按当前部署提供鉴权地址，模型不保存短期签名。

Android 复用断点续传、完整性封存、配额和原子版本切换；失败时保留旧包。
本机 HTTP 服务按会话契约回放 styles / units / fonts / parts，并将内部资源地址映射为同源地址。
旧服务缺少 DOCX 权威清单时要求升级。外部图片会标记部分离线，外部超链接不属于离线保证范围。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Docker 服务端完整测试，真实 MySQL / Redis | 564 通过，0 失败、0 跳过 |
| Viewer 单元测试 | 118 通过 |
| 共享契约测试 | 13 通过 |
| Android 仪器测试 | 41 通过，包含 DOCX 本地协议、资源篡改及缺失样式拒绝 |
| 桌面浏览器 | 11 个案例通过，深色界面下检查纸张、分页、注释、页眉图片与页面字段 |
| Android 12 / Chromium 114 真机 | 7 个案例在线与离线均通过，图片解码成功、离线资源无外部请求 |
| PPT 音视频回归 | WMV / WMA 诊断课件的兼容 MP4 在线与离线播放、拖动及放映检查通过 |
| 跨服务实例读取业务 DOCX | artifactKey 相同，document / styles / unit 的 3 次 Range 读取通过，接收实例未启动源解析 |
| 构建与静态检查 | Viewer / 服务端类型检查、定向 ESLint、Viewer 发布包及 debug APK 构建通过 |

浏览器案例为 1 份真实教案、6 份现有分页夹具、七节图片页眉夹具，以及 3 份专用诊断文件。
真实教案来自用户指定的「06-课件与教案」目录，本轮输出为 5 页；原文件 SHA-256 保持不变。
诊断案例分别覆盖长段落 / 合并嵌套表格（12 页）、长脚注 / 尾注（10 页）、420 段及三分块正文（14 页）。
这些页数是当前渲染器的实测输出，不是独立 Word 对照页数。

真机选取真实教案、脚注、多纸张分节、长合并表格、长注释、部分加载页数和七节页眉共 7 个案例，
每次从首页开始遍历至末页，在线与离线分别得到相同的 5 / 2 / 2 / 12 / 10 / 14 / 7 页。
断连检查移除设备到 Viewer 和解析服务的 USB reverse 映射，确认服务端请求失败后继续本机阅读，
结束时恢复映射。未切换 Wi-Fi 或飞行模式，验证范围是本应用依赖的远端服务不可达。
测试使用隔离测试缓存，不清理用户已有离线教案和课件。

最终 Docker 镜像更新后，真实教案再次在线 / 离线复测通过；设备清单与跨实例返回的 artifactKey 一致。
验收结束时，平板停留在真实教案的本地缓存首页，在线端口映射已恢复。

## 复现与证据

先启动 [Docker 验证环境](../apps/parse-server/deploy/validation/README.md) 及 Viewer 预览服务。
浏览器脚本复用正在运行的预览，不启动第二个服务：

```bash
PARSE_SERVER_URL=http://127.0.0.1:18787 PARSE_SERVER_TOKEN=<令牌> \
WORD_BUSINESS_FILE=<真实教案绝对路径> WORD_EVIDENCE_DIR=/tmp/genoffice-word-fixes \
npm run test:docx-reading -w @genoffice/viewer
```

省略 `WORD_BUSINESS_FILE` 可仅运行仓库夹具和生成的诊断样本。Android 构建及输入格式见
[Android demo](../apps/viewer/android-demo/README.md)：

```bash
ANDROID_SERIAL=<目标设备> PARSE_SERVER_TOKEN=<令牌> \
ANDROID_WORD_INPUTS=/tmp/private-word-inputs.json \
ANDROID_WORD_EVIDENCE_DIR=/tmp/genoffice-word-fixes/android-final \
npm run test:android-docx -w @genoffice/viewer
```

本机证据目录为 `/tmp/genoffice-word-fixes/`，私有原件、派生文件和屏幕截图不提交到 Git：

- `suite.json`、`viewer-tests-final.log`、`android-tests.log`：测试结果。
- `browser-report.json`：11 个浏览器案例及字段、布局和资源检查。
- `android-final/results.json` 及同目录截图 / 清单：实际设备在线与离线结果。
- `android-deploy/results.json`、`business-device-final.png`：最终镜像复测及设备首页。
- `ppt-regression/device-results.json`：共享 Android CDP 工具及 PPT 媒体播放回归。
- `cross-instance.json`：跨实例复用与 Range 对照。
- `source-integrity.json`：真实教案原件校验。

## 尚未覆盖的边界

本轮业务目录只有一份 DOCX；其余是仓库夹具和诊断文件。当前没有可用的 Word / WPS /
LibreOffice 独立渲染基线，因此不宣称复杂 Word 的全面视觉一致性。

单个超大段落或表格的可见片段仍挂载原完整源块，极端内容在 Android 上的 DOM 和内存上限需单独压测。
本轮未重做 GB 正文前端容量、8 核 / 16 GiB、第二台物理机恢复或外部生产部署验收；
既有服务端大正文结果不能外推为这些条件下的阅读容量。

## 右边框裁切补充验收（2026-11-11）

用户截图显示真实教案表格的右外框缺失。核对原 DOCX 的 `w:tblBorders`，右边框为黑色 single，
浏览器单元格样式也包含 1px 右边框。问题在分页片段：固定表格实际宽 603px，正文列宽约
601.797px，`overflow:hidden` 把最右侧线条裁掉了。列宽取整及合法缩进 / 越过正文边距的表格都可能触发。

分页片段与重复表头改为仅在上下方向裁剪，横向绘制范围延伸至纸张边界；纸张外层继续限制内容。
原表格列宽、文字换行和源文件保持不变。

补充验证：Viewer 122 项通过；浏览器 12 个案例通过，含新增的 16 列合并单元格跨页夹具。
真实教案与新夹具均检查右边缘实际命中区域，并用旧的横向裁剪方式作反例，确认旧方式会裁掉边框。
Android 在线 / 离线复测真实教案、脚注及长合并表格，业务教案仍为 5 页，右边缘可见。
类型检查、定向 ESLint、Web 发布包和 debug APK 构建通过。

本机证据在 `/tmp/genoffice-docx-right-edge/`：`browser-report.json`、`android/results.json`、
`right-edge-fixed.png`、`user-before.png` 及测试 / 构建日志。业务原件 SHA-256 保持不变。
