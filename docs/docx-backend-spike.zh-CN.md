# DOCX 服务端流式切 block + 前端虚拟分页 Spike 报告

> 日期：2026-11-04
> 范围：只验证可行性，不接入生产 Viewer，不承诺 1GB。
> 结论：两项基础能力通过；Tiptap 按页挂载和真实 DOM 分页尚未验证，因此暂不启动 1GB DOCX。

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

## 4. 尚未验证

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

## 5. 决策门槛

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

## 6. 建议

**暂不投入 1GB DOCX。**

建议下一步：

1. 把 spike 的“原始 XML 切片”升级为“流式 Block 解析”，先跑 Gate A
2. 用真实 Tiptap 做按页挂载 spike，跑 Gate B
3. 用真实 fixture 做 DOM 测量分页，跑 Gate C
4. Gate A–C 通过后，再评估 1GB 的工期和内存预算

如果产品需要尽快有 DOCX 服务端能力，可以先做 **≤100–200MB / ≤20k blocks** 的受限版本，复用现有 Tiptap，不做完整 1GB 分页虚拟化。

## 7. 运行方式

```bash
# 服务端流式切 block 测试
npm run test -w @genoffice/parse-server

# 前端分页数学测试
npm run test -w @genoffice/viewer

# 扫描吞吐
node --import tsx apps/parse-server/scripts/docx-stream-bench.mts 100000

# 可视化 spike（需 Viewer dev server）
open http://localhost:11001/docx-spike.html
```
