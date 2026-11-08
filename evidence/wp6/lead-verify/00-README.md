# Lead 独立验证记录（复审委派失败后的替代取证）

## 为什么有这份文件

按授权要求，最终冻结 commit 必须由**独立 Agent 只读复审**并明确给出
APPROVE / REQUEST CHANGES，不预置结论。

本会话中我先后向 **4 个不同的子代理后端**派出复审任务，全部因**基础设施
product-error** 中断，无一产出 verdict：

| 次序 | 后端 | 失败原因 |
| --- | --- | --- |
| 1 | teammate `wp6-reviewer` | 未留下收尾消息即失败 |
| 2 | `subagent_codex` | `product: Codex; stage: turn; category: product-error` |
| 3 | `subagent`（默认） | 未留下收尾消息即失败 |
| 4 | `subagent_claude_code` | `product: Claude Code; stage: query-run; category: invalid-result; exit code 1` |

每次失败后我都核查了残留：`/tmp/wp6-review-*` 目录为空、无 `*.mutation-backup`、
冻结快照与工作区均无污染（`git status --porcelain` = 0）。

**结论：独立复审未完成。这是一个未达成的验收项，不能当作通过。**
本文件记录的是**实施方自测**，不替代独立复审，也不得被表述为 APPROVE。

## 已实测内容（实施方自测，28 项断言）

| 探针 | 覆盖 | 结果 |
| --- | --- | --- |
| `p1-approval.mjs` | 审批不可绕过 6 种攻击 | PASS 7 / FAIL 0 |
| `p2-completion.mjs` | 完成语义 + AI 工具面 | PASS 11 / FAIL 0 |
| `p3-binding.mjs` | 目标绑定 / 拒绝无副作用 / undo 精确 | PASS 10 / FAIL 0 |

### p1 审批面
无 token 拒 / `confirmed:true` 不采信 / 伪造 token 拒 / token 复用拒 /
跨会话 token 拒（`unknown-token`）/ token 换目标提案拒。

### p2 完成语义
27 个 AI 工具中不含 `event.delete`、`snapshot.replace`、`store.rollback`、
`proposal.apply`；`task.upsert` schema 无 `done`/`status`/`completion`；
强塞这三个字段被 payload 白名单丢弃；`writeProgress(100)` 被拒；
`requestCompletion` 返回 `done:false` 且用户侧任务不变；只有
`task.acceptCompletion` 才置 `done:true`，并记 `decidedBy:'user'`。

### p3 绑定与撤销
preview 后目标被改 → apply 拒且保持用户改动；reject 后任务集逐字节不变且
不能再 apply；apply → `history.undo` 只撤该次提案，不连带撤更早的用户任务；
`targetDigest=''` 被硬拒（`target-digest-missing`）。

### 数据隔离（额外核查）
`.collab/workbench.json` 中 `events`/`tasks`/`audit`/`undo`/`redo` 均为
**空数组**（schema 骨架），仅 `assignments` 有真实数据；Agent 的
`task.list` 看不到用户任务（0 条），`task.context` 只看到被指派的那 1 条。
业务数据未进入共享层，隔离保证成立。

## 仍然缺什么

- **没有独立裁定**：上述全部是实施方自测，存在自证偏差，不构成 APPROVE。
- 未验证边界照旧：真实 GUI 会话跳转、真实 macOS 休眠、通知横幅、VoiceOver、
  拖拽排序、原生文件选择器、窄视口视觉、重启后会话重开。

## 如何补上

在能正常运行的复审环境里，对快照 `/tmp/wp6-freeze-11e4c8c`
（commit `11e4c8c`，digest `1bfc40a2…`）重跑复审，把 verdict 写入
`evidence/wp6/final-review/<新轮次>/verdict.md`。三份探针可直接复用。

## p4b-agent-identity.mjs（复审整改后新增）

**为什么需要它**：早先的 `p4-review-findings` 探针全篇用 `actor:'ui'`，
那测的是「用户本人能否编辑既有待办」—— 答案本来就该是「能」。授权要求
禁止的是 **Agent 绕过审批**，所以必须用 Agent 身份打；用错身份会让探针
变绿却证明不了任何事，上一轮「已修复」正是这样得出的。

**覆盖**：F1b（Agent 工具面覆盖既有待办被拒 + 原数据未改）、F1（删除凭证
不得用于改写内容）、F4（`agent`/`agent-tool` × `done`/`status` 四种组合
全被拒）、反向（用户本人编辑与勾选完成仍放行）。

**结果**：全部闭环，exit 0。日志同目录 `p4b-agent-identity.log`。
