# 证据与问题记录格式

## 建议运行目录

```text
run-id/
  run.json                 # 模式、授权、版本、环境、入口、执行记录
  inventory.json           # 全文件与可读取的逻辑单元；不是完整规则索引
  protection.json          # 基线与课件快照，含排除项
  rules.json               # 每文件/页面/规则及四端覆盖
  findings.json            # 各端差异、接受设计与修复状态
  coverage.json            # 实际验证与未覆盖项
  integrity.json           # 最新核验；只证明所保护文件集是否变化
  integrity-history.jsonl   # 保留各次核验历史
  evidence/                # 原截图/录屏/请求/控制台/几何/构建与安装记录
  report.md
```

报告和证据不要覆盖；接续运行可追加 retest 子目录并记录关联。敏感口令、token、cookie 与个人数据按需脱敏；命令中的秘密只保留参数名/来源，不写明文。

## 版本、环境与状态

`run.json` 至少记录：requested_version、Release URL/asset/SHA、tag_commit及核实依据、源码包/运行应用版本、runtime、project HEAD/已有改动、启动/构建命令与 cwd/退出码、ports/profile/data dir、安装权限依据、已接受设计的用户依据、各端实际 viewport/DPR/zoom/language/theme/mode/network。

清点助手初始写入的 `pending` 不是已确认事实；实际证据补齐后再更新。输入 URL 或手填 commit 不由脚本认证。产物状态与代码状态分开。

## 规则记录

```json
{
  "rule_id": "R0001",
  "file_id": "F0001",
  "location": { "kind": "slide", "number": 1, "source": "ppt/slides/slide1.xml" },
  "display_item": "标题与正文区域",
  "requirement_basis": "pending",
  "electron_evidence": [],
  "targets": { "web": "untested", "server": "untested", "android": "untested" }
}
```

`requirement_basis` 实际填“课件明确规定 / Electron实际基线 / 课件未定义 / 证据不足”，并附原文件/页或 XML 位置及代码路径/行。上例是空结构，不是演示性通过结果。Word 的 body-block、PDF 页和 PPT slide 不混为同一种页。

## 每条差异必填

| 字段                           | 要求                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| id / target / item             | 稳定 W/S/A 编号、端、页面区域/组件/状态；接续不重编号                                 |
| electron / actual / difference | 分别描述实测基线、目标表现及差异，不只写“不同”                                        |
| type                           | 缺失 / 多出 / 文案 / 布局 / 样式 / 交互反馈，可多选                                   |
| basis                          | 课件路径/页/规则ID，代码路径与行；指向对应版本                                        |
| reproduce                      | 启动入口、输入、页面、模式/状态、关键操作和等待条件                                   |
| evidence                       | 原截图/录屏、控制台/资源/几何等文件，采样环境、时间、构建身份                         |
| severity                       | 阻塞 / 高 / 中 / 低；严重程度与是否阻塞验收分别记录                                   |
| acceptance_blocking            | 是 / 否 / 待确定，以及当前标准/依据                                                   |
| recommendation                 | 具体原实现、适配方向、限制或剩余冲突                                                  |
| status                         | 未修复 / 修复中 / 部分修复 / 已修复待复测 / 已关闭 / 用户接受设计 / 无法确认 / 不适用 |
| retest                         | 三端各自实际入口、结果、证据及未跑项；保留原结论和修复后结论                          |

严重程度沿用用户定义。无另行定义时：阻塞=验收不通过或主要功能不可用；高=核心页面明显受影响；中=可见但主流程可用；低=细节偏差。低严重程度不自动等于非阻塞。无法运行或量化标准不明时如实记录，不能为了填表臆定。

只把有事实依据的问题放入确认差异清单。无法确认、课件未定义和不适用分列；不可把三者当通过。用户接受设计保留原差异和授权位置，统计独立于修复关闭。

## 统计与覆盖

- 同一根因跨端保留各端问题；同端影响多个文件不机械地按截图增殖问题。
- 文件总数、唯一内容数、解析支持数、实际验证数、页面/逻辑块数分别统计；同 SHA 别名保留。
- 每端给原范围、已关闭、当前差异、阻塞/非阻塞、接受设计、无法确认、课件未定义，并说明按问题、类别还是文件计数。
- 全量覆盖和针对性修复复测不可互换。保留 skipped/untested，不能沿用旧版本测试数为本轮通过证据。
- 模型一致性、像素比较、实际画面和端到端各证明不同层次。记录差异度量、坐标换算与透明合成背景；不把 PNG 压缩编码差异当作显示缺陷。
