# 8 核 / 16 GiB 目标负载样本（本机 10 核 / 16 GiB）

日期：2026-11-10。脚本：`apps/parse-server/scripts/load-profile.mts`（`npm run load:profile -w @genoffice/parse-server`）。

本文件记录方案 §6.1/§11 的初始负载样本：2 个冷解析并发 + 20 个排队任务 + 50 个并发缓存阅读，随后 500 个轻量阅读会话；记录 p50/p95 首屏、单元读取、排队、解析用时、RSS 峰值、CPU 与存储规模。它是**单机本机样本**，不是生产容量承诺；目标硬件为 8 核/16 GiB，本次在 10 核/16 GiB Apple Silicon（macOS 27.2.1、Node 22.23.4）上运行，未在精确 8 核机型复跑。

## 场景

- 每份 PPTX 60 页；22 个不同的冷文件（2 个立即解析 + 20 个排队，队列上限 20）。
- 1 个已 ready 的热文件：先在隔离窗口做 50 次并发缓存阅读，再在冷解析/排队期间做 50 次并发缓存阅读。
- 冷任务全部 ready 后创建 500 个轻量阅读会话（同一热文件）。
- 服务端为进程内 local 后端（未接 MySQL/Redis），maxParseJobs=2、maxQueuedParseJobs=20、maxSessions=800。

## 结果

| 指标 | 结果 |
| --- | --- |
| 冷任务队列峰值 | running 2 / queued 20 |
| 冷任务就绪 | p50 **3541 ms**、p95 **6662 ms**（22 个任务、60 页/份） |
| 冷阶段总耗时 | 8123 ms |
| 缓存阅读（隔离，热） | p50 17.99 ms、p95 **20.64 ms**，`sourceParsesStarted` 增量 **0** |
| 缓存阅读（冷解析/排队期间） | p50 6.41 ms、p95 **10.83 ms**（50/50 全部 200） |
| 健康探针（全程 396 次） | p50 5.37 ms、p95 8.70 ms、最大 **62.3 ms**，无失败 |
| 500 轻量会话创建 | p50 61.67 ms、p95 **73.28 ms**；活动会话 523 |
| RSS 峰值（父+子进程采样） | **0.41 GiB**（父 0.195 + 子 0.225），远低于 12 GiB 目标 |
| CPU（父进程累计） | user 7.97 s + system 8.68 s |
| 上传源文件总量 | 1,161,142 B |

原始 JSON（本次运行）：

```json
{
  "host": { "platform": "darwin", "arch": "arm64", "cores": 10, "totalMemoryGb": 16, "node": "v22.23.4" },
  "scenario": { "slidesPerDeck": 60, "coldTasks": 22, "queuedTasks": 20, "cacheReaders": 50, "lightSessions": 500 },
  "cold": { "wallMs": 8123, "medianReadyMs": 3541, "p95ReadyMs": 6662,
    "peak": { "running": 2, "queued": 20 }, "sourceParsesDeltaDuringReads": 2 },
  "warmCachedReads": { "count": 50, "p50Ms": 17.99, "p95Ms": 20.64, "sourceParsesDelta": 0 },
  "cachedReads": { "count": 50, "wallMs": 738, "p50Ms": 6.41, "p95Ms": 10.83 },
  "health": { "probes": 396, "p50Ms": 5.37, "p95Ms": 8.7, "maxMs": 62.3 },
  "lightSessions": { "count": 500, "p50Ms": 61.67, "p95Ms": 73.28, "active": 523 },
  "memory": { "peakTotalGb": 0.41, "peakParentGb": 0.195, "peakChildGb": 0.225, "samples": 396 },
  "cpu": { "userSeconds": 7.971756, "systemSeconds": 8.675421 },
  "storage": { "sourceBytes": 1161142, "artifactBytes": null, "parseWallMs": 8123 }
}
```

## 对照方案目标

- 整体 RSS ≤12 GiB：本次峰值 **0.41 GiB**，远低于目标（60 页 PPTX 样本偏小，不能外推到 GB 级正文）。
- 缓存命中无解析启动：隔离热阅读 50 次，解析启动增量为 0；冷阶段期间解析增量 2，对应 2 个真正启动的冷解析，缓存阅读没有额外触发解析。
- 冷解析不导致健康接口超时：全程 396 次 health 探针 p95 8.70 ms、最大 62.3 ms，无失败。
- 排队与阅读解耦：队列峰值正好 2 running + 20 queued 时，50 个并发缓存阅读仍全部 200，p95 10.83 ms。

## 边界与后续

- 未在精确 8 核/16 GiB 机型复跑；未接真实 MySQL/Redis；未包含 GB 级正文、弱网、真实磁盘吞吐与 500 会话压测的长时稳定性。
- RSS 为健康接口采样的父进程 + 子进程近似值，不是 cgroup 内核计量；解析完成后子进程退出，采样可能低估短时峰值。
- 延迟目标仍需由代表性生产样本基线确定，不能把本表当在线人数承诺。
