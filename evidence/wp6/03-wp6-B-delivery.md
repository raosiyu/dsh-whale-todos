# WP6-B 交付证据：智能规划 / 任务拆解 / 提案预览 / 确认落地

> 基线 `c2c5840`（WP6-A）。本阶段只做 WP6-B，不做 UI（WP6-D）、
> 不做会话协作验收流程（WP6-C）。

## 1. 定位：AI 智能规划的真实形态

DSH 不内置 NLP（见 WP6-A 契约 §0.1）：自然语言 → 工具参数的语义映射由
模型读 tool schema 完成。所以「智能规划」拆成两步：

```
模型（DSH 内）                     本项目（确定性代码）
自然语言 → 结构化输入        →     planning.js 基于真实数据算优先级/耗时/空闲时段
(goal / 任务 / 时间窗)             → 结构化提案 items（拆解 + 排期 + 冲突 + 原因）
                                  → proposal.preview 存 pending 提案
                                  → 用户 UI 确认 → proposal.apply（审批 token）→ 落库
```

**不写 NLP 解析器**，也不自己造一份冲突检测：
`plan.suggest` 只复用 service 的真实查询 `task.list` / `event.freeSlots` /
`event.conflicts` 作为唯一真相源。

## 2. 新增能力

| 项 | 落点 |
|---|---|
| 确定性规划引擎（纯函数） | `workbench-core/src/planning.js` |
| `plan.suggest` op | `proposal-ops.js`，复用真实查询后调 `proposal.preview` **一次** |
| `workbench_plan_suggest` AI 工具 | `host-tools.js`（第 26 个工具） |
| 拆解 | `normalizeTitles` 净化/去重/截断 → `task.create` items |
| 排期 | `rankTasks`（优先级→截止→耗时）→ `scheduleIntoSlots`（真实 freeSlots + 每日容量） |
| 冲突/过载 | 复用 `event.conflicts`；容量账本 `usedMinutes > capacity` 如实上报 |
| 原因说明 | `reasoning` 聚合给用户看，经净化，不当作指令执行 |
| 每日/每周计划 | 通过 `windowStart/windowEnd` 时间窗表达 |

## 3. 实测发现并修掉的真缺陷（非文档、非模拟）

### B-1：`event.freeSlots` 返回对象而非数组 → 排期恒空（假绿）

真实返回：`{free:[{startMs,endMs}], busy:[]}`。
初版 `listFreeSlots` 把整个对象传给规划引擎，`Array.isArray` 判定失败 →
`freeSlots=[]` → **永远排不出日程**。而「复用真实空闲时段」那条测试只检查
「建议时段不与会议冲突」，循环空转也能过，是**假绿**。

修复：
- `service.js` 的 `listFreeSlots` 取 `r.free`（并判数组）
- `planning.js` 的 `scheduleIntoSlots` 支持真实字段 `startMs/endMs`
- 测试加**反向断言**：`scheduleItems.length > 0`，否则失败

修复后实测：
```
提案 items: 4 | 日程建议: 2 | stats: {"decomposed":2,"scheduled":2,"usedMinutes":60}
2026-11-09T08:00:00 → 08:30:00 | 专注：写方案
2026-11-09T08:30:00 → 09:00:00 | 专注：做评审
```

### B-2：`plan.suggest` 初版把 `proposal.preview` 调了两次

三元表达式里条件与展开各调一次 → 重复建提案。已改为一次调用 + 展开 stats。
并加变异 `WP6B7` 锁死（改回两次调用必须被测试抓到）。

### B-3（承 WP6-A）：折叠顺序

`proposal.apply` 的 `collapseUndo` 必须在标记 applied 的 mutate **之后**，
否则撤销弹到错误 entry。WP6-A 已修，WP6-B 的「一次 undo 整体撤销」测试
再次覆盖确认。

## 4. 安全红线（全部有测试）

- 规划引擎**只读**：产出提案 items，绝不写 events/tasks（`WP6B1` 变异锁死）
- 提案 items 的 op 必须过 `assertPlanItemsSafe` 白名单（`WP6B2`）
- `plan.suggest` 时间窗强校验（`WP6B6`）
- `plan.suggest` 进 `WRITE_OPS`，deny 模式被拦
- 提案两阶段不变：无 token 的 `proposal.apply` 被拒；拒绝提案零数据变化；
  确认后数据被改过 → 绑定校验整份拒绝
- 容量上限、优先级排序、真实 freeSlots 形状均有变异项（WP6B3/4/5）

## 5. 测试与变异

| 项 | 结果 |
|---|---|
| 全量回归 | 481 / 481 pass，0 fail 0 skipped |
| WP6-B 专项（`planning-wp6.test.mjs`） | 15 / 15 |
| 变异验证 | 见 `01-mutation-B.log` |

## 6. 未做（留给后续阶段）

UI 规划入口 / 提案预览 / 今日本周计划展示（WP6-D）；
Agent 会话进度回写与人工验收入口（WP6-C/D）。

## 7. UNVERIFIED（保留）

真实 macOS 睡眠、系统通知横幅、VoiceOver、拖拽排序、原生文件选择器、
窄屏视觉、重启后未被打开的老会话。

## 8. 变异首轮 VACUUM 处置（如实记录）

首轮变异 150 CAUGHT / **3 VACUUM**（WP6B1、WP6B6、WP6B7）。
逐条甄别后**没有靠删变异凑数字**：

| 变异 | 根因 | 处置 |
|---|---|---|
| WP6B1 | 初版变异注入了一个永不触发的 `__write` 分支 → **行为等价**，不是测试缺口 | 改写为真正会绕过两阶段的变异：`plan.suggest` 直接调 `ctx.createTask` 落地任务；补断言「业务数据零变化 + 不得直接落地任务」 |
| WP6B6 | 删掉 `plan.suggest` 自己的时间窗校验后，`event.freeSlots` 的 `requireNumber` **兜底拦住了**，行为等价 | 保留变异，把测试断言改成「错误消息必须含『时间窗』且来自 plan.suggest 自己」，与 freeSlots 的 `windowStart 必须是有限数字` 可区分 |
| WP6B7 | 重复调 `proposal.preview` 建 2 份提案，但初版测试只查 `r.proposal.status` → **真测试缺口** | 补断言 `proposal.list().length === 1` |

三条注入实测：分别 `fail 3 / fail 1 / fail 1`，确认都能被抓到。

**教训**（与 WP5 一致）：「变异全绿」不等于「保护有效」，要先确认变异本身
真的改变了可观察行为；行为等价的变异是探针设计错误，不是产品证明。
