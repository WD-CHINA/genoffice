---
name: genoffice-electron-alignment
description: 针对 GenOffice 或其 Viewer 移植项目，以用户指定 Release 的 Electron 为唯一显示基线，对照课件审计 Web、Server、Android 的显示差异，按授权修复并逐端复测，输出可追溯证据与验收报告。适用于跨端显示对齐和既有差异清单复核。
---

# Electron 显示对齐工作流

将指定 Release、输入课件、四端入口和证据固定在一次独立运行中。以真实 Electron 显示为基线，保留原解析、排版、绘制、字体和资源逻辑，通过宿主适配修复目标端。

## 确定本次范围

先读当前仓库 `AGENTS.md` 和适用的移植规则。输入参数为：项目、Release URL/版本、课件目录、输出目录、运行模式、依赖安装权限，以及用户明确接受的设计。缺失项先从当前会话和仓库确定；仅对影响执行的缺项提问，同时继续独立的只读准备。

- **audit**：只读审计；报告和证据写入独立目录，源文件不修改。
- **repair**：仅在已有修复授权下处理指定差异；保留此前接受的设计、已有未提交修改和问题 ID。
- **retest**：不新增实现修改，复核指定实现/产物/安装包及既有差异。
- 安装依赖是独立授权维度；已获授权直接执行并记录。没有授权时记录缺失项与受影响验证，不自行安装。不从“运行”推定可修改源代码。
- 历史接受的设计与旧编号在同项目、同问题及有效授权范围内沿用，无需重复确认；跨版本先核对仍是同一设计，不扩大成其他问题或项目的默认排除。

## 执行入口

按 [详细工作流](references/workflow.zh-CN.md) 完成准备、索引、入口定位、对照、修复和复测。按 [证据与问题记录格式](references/evidence.zh-CN.md) 保存结果；输出时使用 [报告模板](assets/report-template.zh-CN.md)。

新运行可先调用清点助手（Python 3.10+，仅标准库）：

```sh
python3 scripts/audit_run.py init \
  --project /path/to/genoffice \
  --baseline /path/to/genoffice-vX.Y.Z \
  --corpus /path/to/courseware \
  --out /path/to/audit-runs/run-unique-id \
  --version vX.Y.Z \
  --release-url https://github.com/genspark-ai/genoffice/releases/tag/vX.Y.Z \
  --mode audit --install-policy forbid

python3 scripts/audit_run.py verify --run /path/to/audit-runs/run-unique-id
```

将参数替换成当前实际值。脚本相对路径以技能目录为起点；在其他工作目录调用时使用实际技能路径。接续已有运行时使用原索引/ID，不以新清点覆盖旧证据。

助手要求输出目录位于项目、基线、课件之外。它清点文件、SHA256、可直接读取的 OOXML 逻辑单元与保护快照；audit/retest 还保护目标项目源码，repair 允许目标项目改动。核验历史保留在 integrity-history.jsonl，integrity.json 为最新摘要。它不下载或认证 Release、不解析加密容器、不计算 Word/PDF 实际排版页数、不读取全部显示规则，也不运行应用或作出验收结论。助手输出的 `run.json` 中待核实项应由实际调查补齐，不把输入版本号当作已确认版本。

## 不可互相替代的证据

- 分别验证 Web 本地解析、真实 HTTP 上传/会话/资源链路，以及项目实际支持的 Server 排版路径；Node 适配层或共享函数单测不能替代 HTTP。
- Android 使用明确设备/模拟器的真实应用和 WebView。桌面移动视口不能替代真机；在线不能替代下载后断开后端的离线回放。
- 记录实际视口、DPR、缩放、语言、显示模式、滚动和字体就绪状态。请求参数与实际渲染参数分开。
- 校验输入一致、字体/媒体稳定、目标构建资源与已安装 APK 一致；分别覆盖冷启动和热缓存。
- PNG 字节不同不等于显示不同；共享代码一致也不等于显示通过。保留原图，核对解码像素、几何和实际可见表现，不自行设置容差或掩盖已确认差异。

## 修复与结束

先定位主包对应实现及传递依赖/资源，再决定直接复用、抽取或薄适配。逐项登记来源提交与适配边界，保留未修改核心的一致性守卫。不修改基线来迁就目标端，不以缩图、隐藏失败或改预期换取通过。

一条问题仅在相关目标端实际入口复测、原触发状态及证据齐全时关闭；仍有残余时记录“部分修复”，不能改成完成。无法运行标记“无法确认”；仅有客观范围理由时标记“不适用”。是否阻塞验收与严重程度分列。

最终报告列出各端差异/关闭/接受设计/阻塞/非阻塞数量、无法确认项和课件未定义项，以及实际覆盖与未覆盖范围。未解决兼容项说明冲突、影响、可选方案和限制。未获明确提交、推送、发布指令时不执行这些动作。结束时核验保护快照，记录保留服务与本轮自建进程/端口的清理或交接。

维护该技能的脚本后，运行 `python3 -m unittest discover -s scripts -p "test_*.py"` 验证索引与保护行为；用 skill-creator 的 quick_validate.py 验证技能结构。脚本测试不代表业务显示复测。
