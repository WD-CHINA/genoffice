# DOCX 服务端流式切 block + 前端虚拟分页 Spike 报告

> 日期：2026-11-04
> 范围：只验证可行性，不接入生产 Viewer，不承诺 1GB。
> 结论：服务端流式切 block 通过；Tiptap 按页挂载的内存信号通过，但行为 parity 和真实 DOM 分页尚未验证，因此暂不启动 1GB DOCX。

## 1. 目标

在投入 1GB DOCX 之前，先回答两个问题：

1. 服务端能否在不把 `word/document.xml` 整份读入内存的情况下，按顶层 block 流式切分？
2. 前端能否按“页描述 + 可见页挂载”虚拟化，而不是整篇 Tiptap + 全量分页？

## 2. 已实现

### 2.1 服务端流式 block 切分

文件：`apps/parse-server/src/docx-stream.ts`

- 输入 `AsyncIterable<string | Uint8Array>`
- 输出 `{ docxIndex, tag, xml }` 的异步生成器
- 只保留当前 block + 小块读前缓冲，不保留完整 `document.xml`
- 支持跨 chunk 的标签、属性、注释、CDATA、自闭合标签
- 识别 `<w:body>` 顶层子元素：`w:p`、`w:tbl`、`w:sectPr` 等

测试：`apps/parse-server/tests/docx-stream.test.ts`

- 对 3 个 docx fixture，把 `document.xml` 按 **3 字节**切片喂入
- 流式切分的 `docxIndex` 序列与 `parseDocx(...).blocks` 完全一致
- 覆盖跨 chunk 的段落

### 2.2 前端分页/虚拟列表数学

文件：`apps/viewer/src/web/docx-pagination.ts`

- `paginateBlocks(blocks, pageHeight)`：按测量高度生成页描述
- 支持 `breakBefore`、`keepWithNext`、超高 block 独占一页
- `visiblePages(...)`：二分查找可见页 + overscan
- `pageTops(...)`：累计页面偏移

测试：`apps/viewer/tests/docx-pagination.test.ts`

- 基础分页、强制分页、keep-with-next、超高 block、可见范围

### 2.3 可视化 spike

页面：`http://localhost:11001/docx-spike.html`

- 5000 个合成 block
- 分页结果：228 页
- 首屏只挂载 3 页
- 滚动到 `scrollTop=50000` 后只挂载 6 页（55–60）

这证明“页描述 + 虚拟列表”的数学和渲染路径可行。

### 2.4 Gate B：Tiptap 按页挂载 spike

文件：

- `apps/viewer/src/web/docx-page-spike.tsx`
- `apps/viewer/src/web/docx-page-spike.html`
- `apps/viewer/src/web/public/docx-spike-large.docx`

做法：

- 用真实 DOCX（合成 50k blocks / 2700 页）在浏览器 `parseDocx`
- 按估算 block 高度分页
- 每页一个只读 Tiptap editor
- 只挂载可见页 ±2
- 每 500ms 采样 DOM 节点数和 `performance.memory.usedJSHeapSize`

实测：

| 位置                  | mounted pages | DOM nodes | JS heap   |
| --------------------- | ------------- | --------- | --------- |
| 第一页                | 3             | 115       | 157.5 MiB |
| 中间页（约 1348）     | 6             | 205       | 137.8 MiB |
| 最后一页（2697–2700） | 4             | 155       | 142.5 MiB |

结论：

- 页面数从 1 到 2700，DOM 节点和 JS heap 没有随页数线性增长
- 表格和标题在按页 editor 中正常渲染
- 跳页可用

但这是**估算高度分页**，不是真实 DOM 分页；也还没有验证修订、脚注、浮动对象和整篇渲染 parity。

## 3. 实测结果

### 服务端扫描吞吐

```bash
node --import tsx apps/parse-server/scripts/docx-stream-bench.mts 100000
```

```json
{
  "blocks": 100000,
  "xmlMiB": 15.53,
  "seconds": 0.108,
  "blocksPerSecond": 929967,
  "rssDeltaMiB": 65.2,
  "heapDeltaMiB": 54.9
}
```

说明：

- 扫描器本身是线性吞吐，100k 段落/15.5MB XML 约 0.1s
- RSS/heap 数字包含生成 benchmark XML 的开销，不能直接当作扫描器常驻内存
- 真实 DOCX 的表格/修订/嵌套会显著降低吞吐，需要 fixture 扩展

### 前端虚拟分页

| 指标                      | 结果       |
| ------------------------- | ---------- |
| blocks                    | 5000       |
| pages                     | 228        |
| 首屏挂载页                | 3          |
| scrollTop=50000 挂载页    | 6（55–60） |
| 页面总数与 block 总数解耦 | 是         |

### 2.5 Gate B.2：真实 DOM 测量分页

在 `docx-page-spike` 上增加“DOM 测量分页”：

- 用隐藏 Tiptap editor 分块渲染 blocks（100 blocks/块）
- `getBoundingClientRect()` 读取真实 block 高度
- 用测量高度重新 `paginateBlocks`
- 目前只测前 500 个 block，剩余 block 仍用估算高度（50k 全量测量在浏览器里太慢）

实测：

| 指标            | 估算分页 | 测量分页    |
| --------------- | -------- | ----------- |
| pages           | 2700     | 2698        |
| 首屏 mounted    | 3        | 4           |
| DOM nodes       | 119      | 169         |
| JS heap         | ~150 MiB | 137.9 MiB   |
| measured blocks | —        | 500 / 50201 |

500 个 block 的测量耗时约 5 秒（后台 tab，含 100-block 分块和布局）。

结论：

- 真实 DOM 高度可以增量测量，不需要整篇 editor
- 测量后页数会变化，说明估算高度不能替代真实分页
- 但只测了前 500 块，不能证明全量 2700 页的分页正确性

### 2.6 Gate B.3：行为 fixture 与 parity

新增 behavior fixture：`apps/viewer/src/web/public/docx-spike-behavior.docx`

内容：

- 修订：`w:ins` + `w:del`
- 脚注：`word/footnotes.xml` + `footnoteReference`
- 60 行长表格（跨页场景）

页面 fixture 选择器可切换 `large` / `behavior`。

实测：

| 检查        | 结果                                                   |
| ----------- | ------------------------------------------------------ |
| 修订渲染    | 通过（inserted / deleted 可见）                        |
| 脚注引用    | 通过（上标 1）                                         |
| 长表格渲染  | 通过，但整张表作为一个 block                           |
| 文本 parity | `ok`（1514/1514 字符）                                 |
| 长表格分页  | **失败**：表格被当成超高 block，独占一页并溢出页面高度 |

这是 Gate B.3 的关键发现：

- 文本层面，按页 editor 与整篇 editor 一致
- 但当前分页只按 block 边界切，**不会在表格内部断页**
- 60 行表格在页面里被裁切，不能直接用于生产

### 2.7 Gate B.4：表格行级分页

新增：

- `apps/viewer/src/web/docx-table-pagination.ts`
- `apps/viewer/src/web/docx-table-spike.tsx`
- 页面：`http://localhost:11001/docx-table-spike.html`

实现：

- 用隐藏 Tiptap editor 测量每个 `<tr>` 的真实高度
- 读取 `w:tblHeader` / `w:cantSplit`
- 行级分页：
  - 前导 header 行每页重复
  - `cantSplit` 行不拆，放不下就换页；超高则标记 overflow
  - 可拆分行按段落边界拆成 `part { start, end }`
- 每页把表格 block 切成子表格，交给独立 Tiptap editor 渲染

实测 behavior fixture：

| 指标        | 结果                    |
| ----------- | ----------------------- |
| rows        | 60                      |
| headerRows  | 1                       |
| cantSplit   | 1                       |
| pages       | 2                       |
| overflow    | 0                       |
| page 1 rows | 0–48（含 header）       |
| page 2 rows | 0（重复 header）, 49–59 |

页面 2 正确重复了 header 行；60 行表格不再被裁切。

单元测试覆盖：

- header 每页重复
- cantSplit 行整体换页
- 可拆分行按段落拆成 part
- 超高 cantSplit 行标记 overflow

仍未验证：

- 拆分行的**单元格段落渲染**只做了模型切片，没有在真实浏览器里看到跨页拆分效果
- 合并单元格、嵌套表格、行修订在拆分行里的行为
- 表头重复与 Word 的“仅首行/多行表头”细节

### 2.8 Gate B.5：拆分行渲染 + 合并单元格/嵌套表格

新增 fixture：`apps/viewer/src/web/public/docx-spike-table.docx`

表格包含：

- 1 行 `tblHeader`
- 3 行普通行
- 1 行 80 段的超高可拆分行
- 1 行 `gridSpan=2` 合并单元格
- 1 行嵌套表格
- 1 行 `cantSplit`

表格 spike 结果：

| 指标       | 结果 |
| ---------- | ---- |
| rows       | 8    |
| headerRows | 1    |
| cantSplit  | 1    |
| pages      | 3    |
| overflow   | 0    |

分页结果：

- page 1：header + 普通行 0–3
- page 2：重复 header + 超高行上半段（tall line 0–49）
- page 3：重复 header + 超高行下半段（tall line 50–79）+ 合并单元格 + 嵌套表格 + cantSplit 行

浏览器验证：

- 拆分行的上下两页内容连续，`tall line 0–49` / `50–79` 无丢失
- 合并单元格文本 `merged across both columns` 正常
- 嵌套表格 `nested cell` 正常
- cantSplit 行完整出现在 page 3
- header 在 page 2/3 重复

### 2.9 接回主 docx-page-spike

`docx-page-spike` 现在会把 table block 替换成行级分页后的子表格，再交给主分页模型：

- behavior fixture：3 blocks → 3 页（原先 1 页）
- 表格子页与普通 block 一起参与 `paginateBlocks`
- table 页使用重复 header 和拆分后的行片段

仍未验证：

- 拆分行里的**合并单元格/嵌套表格**跨页行为（当前 fixture 把合并/嵌套放在未拆分页）
- 跨页拆分后的单元格边框/底纹像素级一致性
- 按行高比例拆段 vs 按真实段落边界拆段
- 主页面里表格页与后续段落的精确 page-break 规则

### 2.10 Gate A：流式 Block 语义

新增：

- `apps/parse-server/src/docx-block-parse.ts`
- `apps/parse-server/tests/docx-block-parse.test.ts`

做法：

- 用 `streamDocxBlocks` 得到原始 XML 切片
- 把每个切片放回原 docx 包（保留 styles/rels/media/numbering/sectPr）
- 调用现有 `parseDocx`，取第一个 block
- 与完整 `parseDocx` 的同位置 block 对比

实测 fixture：

- `table-style-ppr-spacing`
- `render-hf-inline-picture`
- `docx-spike-table`（修订 + 脚注 + 合并单元格 + 嵌套表格）

对比项：

- block type
- 纯文本
- 表格行数

结果：**全部一致**。

限制：

- 每个 block 都重新生成一次 docx 包，不是真正的流式上下文
- 还没有复用 `docx-engine` 内部的 `buildBlock`/styles/rels 上下文
- 大文档上这个做法不可用，只证明“切片可以语义解析”

### 2.11 Gate A.2：可复用 block parser context

新增：

- `packages/docx-engine/src/parse.ts` 导出 `createDocxBlockParser(bytes)`
- `apps/parse-server/src/docx-block-parse.ts` 改为使用该 parser

做法：

- 包级上下文只构建一次：styles、numbering、rels、theme、notes、sections、media
- 每个流式 block 切片直接 `parser.parseBlock(xml, index)`
- 不再为每个 block 重新生成 docx 包

测试：

- `table-style-ppr-spacing`
- `render-hf-inline-picture`
- `docx-spike-table`（修订/脚注/合并单元格/嵌套表格）

对比 block type、纯文本、表格行数，全部一致；测试耗时从“每块重新打包”的 ~236ms 降到 ~82ms（fixture 级别，非大文件基准）。

限制：

- `createDocxBlockParser` 仍然读取完整 `word/document.xml` 来建立 sections/comments/firstPageBreak 等文档级元数据
- 真正 1GB 还需要把这些元数据也流式化
- 还没有接服务端 DOCX session / chunk 存储

### 2.12 Gate A.3：元数据流式化 + 服务端 DOCX session

新增：

- `apps/parse-server/src/docx-metadata.ts`：流式收集 block/section/comment/page-break 元数据
- `apps/parse-server/src/docx-session.ts`：DOCX `block-chunk` session
- `POST /v1/sessions` 接受 DOCX
- `GET /v1/sessions/:id/units` / `units/:id` 返回 `block-chunk`

session 行为：

- 用 `createDocxBlockParser` 解析切片
- 每 200 个 block 一个 chunk
- `DocModel.unitKind = 'block-chunk'`
- 会话记录持久化到 `sessions.json`
- 重启后第一次访问懒重建 session

实测（HTTP 测试）：

- 上传 DOCX → 201，format=docx
- 创建 session → 201，model.format=docx，unitKind=block-chunk
- units 列表 kind=block-chunk
- unit 0 返回非空 blocks
- 重启后 session/units 仍可访问
- parse-server tests：35 项通过

限制：

- `DocxSession` 仍然读取完整 package + document.xml，并跑在主线程
- 还没有 chunk 落盘/落库、worker 隔离、取消
- Viewer 还没有 remote DOCX provider，仍走本地 DOCX
- `maxParseBytes` 256MiB 保护，不是 1GB 路径
- `createDocxBlockParser` 的 context 仍读完整 document.xml；`docx-metadata` 目前只是独立流式 pass

### 2.13 Gate A.4：Viewer 远程 DOCX provider（第一版）

新增：

- `apps/viewer/src/web/docs-remote.tsx`
- `preview.tsx` 在 `format=docx && server && fileId` 时走远程 provider
- `host.tsx` 允许 DOCX 上传到服务端 / 服务端模式；自动模式大于 64 MiB 走服务端

行为：

- 创建 DOCX session
- 拉取 `block-chunk` units
- 用 Tiptap 渲染 blocks
- 卸载时 DELETE session

实测：

- 通过 `?parse=server&fileId=...` 打开 `docx-spike-table.docx`
- 修订、脚注、表格、合并单元格、嵌套表格都显示
- 没有报错

限制：

- 当前一次性拉取所有 chunk，不是懒加载
- 用一个 Tiptap editor 渲染全部 blocks，没有接按页/表格行级分页
- 表格会作为一个长 block 溢出页面
- 没有字体/媒体懒加载、搜索、缩略图、放映
- 远程 DOCX 只是“能打开”，不是生产级排版

### 2.14 Gate A.5：远程 DOCX 分页/懒加载

`DocsRemote` 改为：

- 初始只加载 1 个 chunk
- 滚动接近底部时按 cursor 加载下一个 chunk
- 用 `docx-pagination` 做按页虚拟化，只挂载可见页 ±2
- 用 `docx-table-measure` + `docx-table-pagination` 处理表格行级分页
- 表格页重复 header，拆分行的上下页连续

浏览器实测 `docx-spike-table.docx`：

| 指标                | 结果                                              |
| ------------------- | ------------------------------------------------- |
| pages               | 4                                                 |
| 可见页挂载          | 1–3 / 滚动后变化                                  |
| 表格拆分            | page 2 `tall line 0–49`，page 3 `tall line 50–79` |
| header 重复         | page 2/3 都有                                     |
| 合并单元格/嵌套表格 | page 3 显示                                       |
| 修订/脚注           | page 1 显示                                       |

后续补充：普通 block 也接入隐藏 Tiptap 分块测量（`docx-block-measure`），页面高度使用真实 DOM 高度；实测该 fixture 为 4 页，canvas 高度约 1827px。

限制：

- 测量只针对已加载的 block；新 chunk 到达后会增量测量并重排
- 表格测量是异步的，页面数会随后变化
- chunk 加载没有取消/错误重试 UI
- 媒体/字体/搜索/缩略图仍未接
- 只加载已到达的 chunk，page count 是当前已加载内容的页数

### 2.15 Gate A.6：chunk 取消/重试

`DocsRemote` 增加：

- `AbortController` 覆盖 session 创建与 chunk 请求
- 组件卸载时 abort 未完成请求并 DELETE session
- 请求失败显示错误 + “重试”按钮
- 重试逻辑：
  - 已有 session：从当前 cursor 继续加载
  - 无 session：重新创建 session

浏览器行为：

- 正常打开远程 DOCX 不受影响
- 请求失败不再静默停在 loading
- 重试可继续加载

限制：

- 重试没有指数退避
- 没有区分“可重试/不可重试”错误
- 没有离线/网络切换提示
- 媒体/字体/搜索仍未接

### 2.16 Gate A.7：DOCX 大块压力

新增 `apps/parse-server/scripts/docx-stress.mts` / `stress:docx`：

- 用真实 DOCX 模板生成指定 block 数的 `document.xml`
- 上传、创建 DOCX session、读取 unit 0
- 记录上传/打开耗时和 health 内存

实测（本机，服务端主线程解析）：

| blocks  | XML 规模 | compressed | openMs | heapUsed after | RSS after |
| ------- | -------- | ---------- | ------ | -------------- | --------- |
| 20,000  | ~4MB     | 62KB       | 357    | ~105MB         | ~205MB    |
| 100,000 | ~20MB    | 298KB      | 1,813  | ~366MB         | ~486MB    |
| 300,000 | ~60MB    | 887KB      | 5,761  | ~1.09GB        | ~860MB    |

结论：

- 当前实现可以处理 300k blocks，但 heap 已超过 1GB
- 100MB 级 `document.xml` 会明显超过当前主线程/单进程预算
- 必须做 worker 隔离 + 流式 metadata + chunk 持久化，才能谈 1GB
- compressed 文件大小不能作为解析内存的安全指标（XML 压缩率很高）

## 4. Gate B 结论

内存信号：**通过**。

行为 parity：**部分通过，表格行级分页已补齐**。

具体来说：

- 通过：每页独立 Tiptap editor 可行，2700 页时只挂载 3–6 页，DOM 115–205，heap 138–158 MiB
- 部分通过：真实 DOM 高度可增量测量（前 500 blocks），页数从 2700 变为 2698
- 部分通过：behavior fixture 的修订/脚注/文本 parity 通过（1514/1514 字符）
- **已补齐：表格行级分页**，behavior fixture 60 行表格分成 2 页，header 重复
- **已补齐：拆分行的真实渲染**，tall line 0–49/50–79 连续，合并单元格/嵌套表格/cantSplit 正常
- **已接回主 docx-page-spike**，表格子页参与主分页
- **仍未验证：拆分行里的合并单元格/嵌套表格跨页、边框/底纹像素级一致性**
- **Gate A 语义切片已通过 spike**：3 个 fixture 的 type/text/table rows 与完整 parse 一致
- **Gate A.2 已通过**：`createDocxBlockParser` 复用包级上下文，不再逐块重新打包；但 context 创建仍读完整 document.xml
- **Gate A.3 已通过**：DOCX 服务端 session 可用（block-chunk），元数据流式 pass 与重启恢复测试通过
- **Gate A.4 第一版通过**：Viewer 可远程打开 DOCX
- **Gate A.5 已通过**：远程 DOCX 支持 chunk 懒加载、按页虚拟化、表格行级分页、普通 block 真实高度测量
- **Gate A.6 已通过**：chunk/session 请求支持 abort、卸载清理、错误重试
- **Gate A.7 已做压力基线**：300k blocks / ~60MB XML 可打开，但 heap 1.09GB；100MB 级需要 worker + 流式 metadata
- 未通过/未验证：
  - 全量 2700 页的真实 DOM 分页（只测了前 500 blocks）
  - 拆分行里的合并单元格/嵌套表格跨页
  - 跨页拆分后的边框/底纹像素级一致性
  - 浮动对象
  - 与整篇 editor 的像素级 parity
  - 页高变化后的增量重排
  - 跳页时 editor 创建/销毁的卡顿

因此 Gate B 只能判定“方向可行”，不能判定“1GB 可做”。

## 5. 尚未验证

这是 spike，不是生产实现。以下都还没有答案：

1. **Tiptap 按页挂载**
   - 多实例/按页挂载下，表格、修订、脚注、浮动对象是否与整篇 editor 一致
   - 页高测量是否可增量进行
2. **真实 DOM 分页**
   - 现在用的是合成固定高度，不是浏览器测量高度
   - 字体加载、重排、表格跨页、keep-with-next 需要真实 fixture
3. **流式 tokenizer 的语义**
   - 现在只做“原始 XML 顶层切片”，还没有把每个 block 解析成 `Block`
   - 需要复用/扩展 `docx-engine` 的 block 解析，而不是重新实现一套
4. **chunk 存储与传输**
   - chunk 落盘/落库、游标、压缩、GC
5. **搜索/锚点/跳页**
   - 跨 chunk 搜索、最近 checkpoint 重排
6. **1GB 的真实瓶颈**
   - `document.xml` 可能是 2–5GB
   - 超大表格、图片、修订、`sdt` 的流式处理
   - 前端 10k+ 页滚动稳定性

## 6. 决策门槛

在启动 1GB DOCX 前，至少要通过：

### Gate A：流式 block 语义

- 同一 fixture 的流式 block 序列与现有 `parseDocx` 的文本/属性一致
- 覆盖跨段表格、修订、`sdt`、`sectPr`

### Gate B：Tiptap 按页挂载

- 按页挂载下表格/修订/脚注/浮动对象行为一致
- 1000 页文档内存稳定，无整篇 editor

### Gate C：真实虚拟分页

- 10k+ 页滚动、跳页、搜索、字体重排内存稳定
- 分页结果与整篇分页一致

### Gate D：端到端

- 100MB 级 DOCX：上传 → 流式切 block → chunk 传输 → 虚拟分页
- 1GB 级 DOCX：在 Gate A–C 通过后再做专项

## 7. 建议

**暂不投入 1GB DOCX。**

建议下一步：

1. 把 spike 的“原始 XML 切片”升级为“流式 Block 解析”，先跑 Gate A
2. 用真实 Tiptap 做按页挂载 spike，跑 Gate B
3. 用真实 fixture 做 DOM 测量分页，跑 Gate C
4. Gate A–C 通过后，再评估 1GB 的工期和内存预算

Gate B 的下一步不是直接上 1GB，而是 **Gate B.2**：

- 用包含修订、脚注、浮动对象、跨页表格的真实 fixture
- 与整篇 Tiptap 渲染做 parity 对照
- 用真实 DOM 测量高度分页，而不是估算
- 测跳页/销毁 editor 的卡顿

如果产品需要尽快有 DOCX 服务端能力，可以先做 **≤100–200MB / ≤20k blocks** 的受限版本，复用现有 Tiptap，不做完整 1GB 分页虚拟化。

## 8. 运行方式

```bash
# 服务端流式切 block 测试
npm run test -w @genoffice/parse-server

# 前端分页数学测试
npm run test -w @genoffice/viewer

# 扫描吞吐
node --import tsx apps/parse-server/scripts/docx-stream-bench.mts 100000

# 可视化 spike（需 Viewer dev server）
open http://localhost:11001/docx-spike.html
open http://localhost:11001/docx-page-spike.html
open http://localhost:11001/docx-table-spike.html
open http://localhost:11001/docx-page-spike.html
```
