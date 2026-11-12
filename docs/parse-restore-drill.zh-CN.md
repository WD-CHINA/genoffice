# 独立目录/异机式恢复演练（本机模拟）

> 本文保留原设计或当时验证条件；当前三端职责、已知边界与测试入口请参阅[架构主文档](runtime-workflows.zh-CN.md)、[运行边界](runtime-boundaries.zh-CN.md)和[测试指南](testing-guide.zh-CN.md)。历史数字不自动代表当前结果。

日期：2026-11-10。脚本：`apps/parse-server/scripts/restore-drill.mts`（`npm run restore:drill -w @genoffice/parse-server`）。

方案 P4/§9 要求“恢复演练可复查”。现有测试已覆盖同一 dataDir 的清单校验，本演练补上**第二个独立 dataDir（模拟另一台机器/另一块介质上的冷拷贝）**：源端构建文件、历史库与 ready 产物 → 生成备份清单 → 整目录拷贝到 machine B → 独立校验并带 restore 门禁启动 → 缓存重开必须零重解析；同时对拷贝做 source/artifact 篡改，验证失败关闭语义。

> 边界：machine B 是同一主机上的另一个目录，未使用第二台物理机/外接介质，也未恢复 MySQL catalog 库本身；catalog 跨节点清单校验由 `backup-manifest-cross-node-mysql` 测试覆盖。

## 结果（本次运行）

| 项目                       | 结果                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 源端 machine A             | 2 个文件（30 页/12 页 PPTX）、2 个 ready 产物、2 条历史库记录                                                                     |
| 备份清单                   | 9 个条目（2 source、4 artifact、3 metadata）、digest `cbc9b2cf…`、列出 2 条 library 行                                            |
| machine B 只读校验         | `ok=true`、`readyAllowed=true`、verifiedBytes 68,549                                                                              |
| restore 门禁启动           | `health.restore.ok=true`、`readyAllowed=true`、digest 与清单一致                                                                  |
| 恢复后缓存重开             | session `ready`，`sourceParsesStarted` 增量 **0**，unit 与源端逐字节一致（JSON 相等），历史库 2 条                                |
| machine C（篡改 source）   | `ok=false`、`readyAllowed=false`，错误码 `source_size_mismatch`（失败关闭）                                                       |
| machine D（篡改 artifact） | `ok=true`、`readyAllowed=true`，警告 `artifact_size_mismatch`；派生 generation 本就可重建，filesystem 后端无 SQL ready 指针可撤下 |

原始 JSON（本次运行）：

```json
{
  "manifest": {
    "digest": "cbc9b2cf50fd736b4ccb65eb824ad9d75d2254a71443fdd2f7bd54781914cf55",
    "entries": 9,
    "sourceFiles": 2,
    "artifactFiles": 4,
    "libraryRows": 2,
    "artifactRows": 0
  },
  "restore": {
    "readOnly": { "ok": true, "readyAllowed": true, "verifiedBytes": 68549, "readyPointers": 0 },
    "gate": { "ok": true, "readyAllowed": true },
    "cachedReopen": {
      "state": "ready",
      "sourceParsesDelta": 0,
      "unitMatches": true,
      "libraryEntries": 2
    }
  },
  "tamperedSource": { "ok": false, "readyAllowed": false, "errorCodes": ["source_size_mismatch"] },
  "tamperedArtifact": {
    "ok": true,
    "readyAllowed": true,
    "warnings": ["artifact_size_mismatch"],
    "blockedReady": 0
  }
}
```

## 结论与后续

- 独立目录冷恢复后，文件内容、历史库与 ready 产物均可直接复用，缓存重开不触发重解析；损坏 source 会阻止启动（fail-closed），损坏派生 artifact 只告警并可在请求时重建。
- 仍未做：真实第二台机器/外接介质、MySQL catalog 库的导出/导入式恢复、备份保留/调度策略、恢复后跨节点租约与运营 on-call 流程。
