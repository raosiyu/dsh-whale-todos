# WP1 计划 vs 实际交付差账（WP2 前置检查产出）

| 计划项（Phase 0 / WP1 计划） | 实际交付 | 差异性质 | 处置 |
| --- | --- | --- | --- |
| `ctx.storageDomain`（DSH Host 存储域） | **未使用**：改用零依赖原子 JSON 文件存储（`store.js`） | **计划偏离**，出于「隔离环境零安装可跑」的取舍 | 已在 `01-WP1-core-domain.md` 声明；Host 接线留待后续 |
| DSH Host 服务接线（`ctx.tools`/`ctx.schedule`/`ctx.approval`） | **未接线**：`workbench-core` 是纯领域内核，不引用任何 ctx | **未完成**，属计划内后续工作包 | WP2 开始接入（ScheduleAdapter + ApprovalGate） |
| UI / Agent Tool 一致性测试（`ui-tool-parity.test.mjs`） | **未实现**：`service.execute` 已是唯一入口，但无真实 UI 与 tool 双路径对照 | **未完成**，UI 尚未存在（完整 UI 留 WP4） | WP2 用「同入口 + 审批门」保证一致性；UI 出现后再补对照测试 |
| RRULE 遵循 RFC 5545 | **部分偏离**：月末按 clamp 处理（1/31 → 2/28），RFC §3.3.10 要求非法日期 **MUST be ignored** | **语义偏差**，WP2 修正 | 见 `04-rrule-monthend.md` |

## 结论

WP1 交付的是**可独立验证的领域内核**，不是已接入 DSH 的插件。三项差账均为主动取舍或后续工作包范围，不属「声称完成但没做」。
