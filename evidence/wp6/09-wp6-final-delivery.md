# WP6 最终交付报告 — AI 智能规划与 Agent 会话协作

> 冻结 commit：`27c4298d9e21a8a9f5db33e49d02508d1bc8db4d`
> 整改 commit：`269a035`（复审 3 P0 + 4 P1 闭环）
> 当前 HEAD：`cadf4b1`（用户可见性修复 + 证据探针）
> 已推送：`6f6dbe7..cadf4b1` → `origin/main`（快进，非 force，`git rev-parse` 双向一致）
> 基线：`d81e99a96f12f15269c21b998def43c284d6e5be`
> 范围：WP6 完成即停，未进入 WP7

## 交付后审计发现并修复的真实缺陷（`1455fc7` / `cadf4b1`）

真机走 WP6-C 主链路（用户建任务 → 关联 Agent 会话 → Agent 回写进度 →
申请完成 → 用户验收）时发现：**Agent 干完了，用户在界面上看不见**。

| 项 | 事实 |
| --- | --- |
| 现象 | 用户 `task.list` 里 `progress = undefined`、`completionRequest = null` |
| 根因 | `task.writeProgress` / `task.requestCompletion` 写的是 scope 级 `shared assignments`，**不在**用户工作区的 `tasks` 行上；而 UI 唯一数据源是 `task.list`，从不合并 assignments |
| 影响 | WP6-C「进度回写」与 WP6-D「人工验收入口」的价值链断开——数据在库里，但用户看不到 |
| 修复 | `task.list` 对已关联任务做**只读投影**合并执行态；不写回、不进 undo、不改分片 |
| 回归 | 首次修复把本地 `completion` **对象**覆盖成 assignment 的**状态字符串**，导致 `completion.decidedBy` 读不到（e2e E1.19 / E2.3 变红）→ `cadf4b1` 改为「本地对象优先，共享分配只补缺」 |
| 验证 | 单测 516 pass / 0 fail / 6 skipped；e2e 45 pass / 0 fail；杀手测试废掉合并逻辑即红（515/1 实测） |

## 复审结论与整改状态（这一节先于功能描述）

独立复审对 `a59f287` 给出 **REQUEST CHANGES**：3 个 P0 + 4 个 P1，
附可复现探针，全部保留在 `evidence/wp6/final-review/`。`11e4c8c` 声称
修复了这 7 项。

**但复审的修复并未全部生效。** 以 `11e4c8c` 快照重跑探针后，3 个 P0
里有 2 个仍可复现（F1 凭证不绑内容、F1b Agent 无审批覆盖既有待办），
另有 2 个 P1（F4 服务层可直置完成态、弹窗文案可被调用方改写）同样未闭。
原因不是漏写代码，而是**守卫写在了错的判据上**：`meta.actor === 'agent'`
永不成立 —— 工具面实际发的是 `'agent-tool'`（`host-tools.js:120`），
所以按 actor 的守卫从未触发过。这也是上一轮「自检通过」的成因。

`269a035` 逐条闭环，每条都补了**杀手测试**（删掉守卫即变红，已实测）：

| 编号 | 问题 | 整改 |
| --- | --- | --- |
| P0-1 F1/F2 | 内容类凭证只绑 `(op,target)`，确认删除的凭证可拿去改写内容；提案确认 1 条后可换成 50 条全量落地 | 签发侧单一推导 `approvalDigestFor`，两条签发路径与执行侧摘要逐字节一致；`proposal.apply` 绑 `proposalContentDigest`；签发读盘走 `readCollectionFresh` |
| P0-2 F1b | Agent 无审批直接覆盖既有待办 | 按用户裁定保留守卫，Agent 改走 `plan.preview → 确认 → proposal.apply`；测试 144/437 重写为该路径而非删除 |
| P0-3 F4 | 服务层可直置完成态 | `isAgentActor()` 收口 `agent/agent-tool/agent_tool/ai`；`viaProposal` 标记只由可信落地层设置 |
| P1 F1c | 无凭证指向不存在 id 得 `not-found` 而非 `confirmation-required`，等于白送存在性探测口 | `assertTokenUsable` 两段式：先拒凭证，再读内容比摘要 |
| P1 F7 | 弹窗文案可被调用方改写；申请者身份可冒充 | `op` 限 `DANGEROUS_OPS`；`summary` 由本层按 op 生成中文；身份只取 `invocation.agent` |

### 当前实测

| 检查 | 结果 |
| --- | --- |
| 全量测试 | 521 pass / 0 fail / 0 cancelled / 0 skipped |
| 变异测试 | 176 CAUGHT / 0 VACUUM / 0 SKIP |
| 端到端验收 | 45 pass / 0 fail |
| lead-verify p1–p3 | 7 + 11 + 10 全过 |
| Agent 身份探针 p4b | 全部闭环（含用户反向路径仍放行） |
| 真实攻击面自测 | PASS 10 / FAIL 0（`p5-real-attack-surface`） |
| 综合自测 | PASS 26 / FAIL 0（`p6-broad`） |
| 凭证绑定自测 | 篡改被拒 + 对照成功（`p7-credential-binding`） |
| 独立方单不变量 | **PASS**（`independent-review/`） |
| 真实 Host 审批 | 2 pass / 0 fail（真实 asar） |

### 独立复审：**未达成全面裁决**（必须如实披露）

本轮共 9 次委派独立复审（1 个 teammate + 4 个不同后端 subagent +
3 个窄切片 + 1 个极窄单不变量任务）。前 8 次全部在无结论状态失败；
第 9 次**成功**，但它只覆盖**一条**不变量：

| 独立裁决 | 范围 | 结果 |
| --- | --- | --- |
| `0136e4bc-…` | 同一凭证不得跨内容复用（`task.upsert`） | **PASS** |

证据：`evidence/wp6/independent-review/`（脚本由其本人编写，实施方未改一行）。
它自己声明**未**覆盖：其他危险 op、并发抢 token、指纹字段集合、
非 deny 模式的审批行为、整体代码审查。

因此「WP6 已通过独立复审」**不成立**；完整 APPROVE **没有拿到**。
`269a035` 的性质是「整改完成 + 自测证据齐全 + 单不变量已独立确认 + 全面复验缺失」。

第 7 次失败的根因已查明并修复：`/tmp` 快照被系统清理，复审方进入不存在的
目录。改用仓库外持久 worktree（`/Users/sylas/Developer/wp6-review-freeze`，
基线 515/0/6）后环境可用，但后续切片仍在无结论状态结束。记录见
`evidence/wp6/lead-verify/01-review-worktree.md`。复审方明确未覆盖的范围逐条保留在
`evidence/wp6/lead-verify/00-README.md`：无真实浏览器 E2E；真实 DSH
`ApprovalService` 的回合约束用 stub 模拟；F2 在生产环境的可达性未定；
`store.js`/`validate.js`/`event.js` 与三个测试文件未逐行通读；未复现
`agentStorage` 并发隔离；无第二方交叉核对。

## 功能交付（A→E 五阶段）

| 阶段 | commit | 内容 |
| --- | --- | --- |
| A | `c2c5840` | 自然语言建/查/改待办，从对话与笔记抽取，自动判优先级/截止/项目，批量预览+确认，模糊时间与目标追问 |
| B | `7eabf55` | 按优先级/截止/预估/空档出规划建议；复杂任务拆解；日/周计划；冲突、超期、超载检测；每条建议带理由 |
| C | `d87845a` | Agent 会话关联、进度回写、申请完成、用户验收；Agent 不可绕过审批 |
| D | `e9ceab5` | UI：AI 规划入口、拆解/建议预览、今日与本周计划、会话关联与进度、确认/拒绝/修改、执行记录与验收入口 |
| E | `a59f287` | 端到端真实验收 + 提案确认语义修正 |
| 修复 | `11e4c8c` | 复审 3 P0 + 4 P1；变异真空打到 0 |
| 取证 | `9b18a12` | 审批/完成语义/绑定撤销三段自测 + 如实记录复审未完成 |
| 冻结 | `27c4298` | 在最终 commit 上重跑变异 176 条 |

核心链路（用户语言 → 落库 → 执行 → 验收）：
`proposal.preview` 建待审提案（**零业务数据改动**）→ 用户确认 → Host 签发
一次性 token → `proposal.apply` 校验绑定（baseVersion/baseDigest/scope/
逐条 targetDigest）→ 备份 → 逐条落地 → 收敛为一次 undo → 标记 applied。

## 验证数字（全部本轮复跑，可重新执行）

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 单元/集成测试 | **515 pass / 0 fail / 6 skip** | `cd workbench-core && npm test` |
| 变异测试 | **CAUGHT 176 / VACUUM 0 / SKIP 0** | `evidence/wp6/01-mutation-final2.log` |
| 真实 Host 端到端探针 | **PASS 45 / FAIL 0** | `evidence/wp6/probe-wp6-e2e.{mjs,log}` |
| 审批攻击自测 | PASS 7 / FAIL 0 | `lead-verify/p1-approval.log` |
| 完成语义自测 | PASS 11 / FAIL 0 | `lead-verify/p2-completion.log` |
| 绑定/拒绝/undo 自测 | PASS 10 / FAIL 0 | `lead-verify/p3-binding.log` |

### 诚实边界（必须一起读）

- 「176/176 CAUGHT」只证明**已定义的守卫点都有测试约束**，不等于功能完整正确。
- 第一轮 176 条曾出现 **VACUUM=5**：新加的修复当时**没有**任何测试能杀死，
  是补写测试后才变 0。三轮演进 170/5/1 → 173/3/0 → 176/0/0，记录在
  `evidence/wp6/08-wp6-E-p0-fixes.md`。
- 变异真空可以靠删测试刷出来，我没有删任何一条。

## 修复的 3 P0 + 4 P1

| 编号 | 问题 | 处置 |
| --- | --- | --- |
| P0-1 | `workbench_task_upsert(done:true)` 可绕过验收直接置完成 | schema 与 payload 白名单双双移除 `done`/`status`；两条编码该缺陷的测试重写 |
| P0-2 | 真实 Host 跨会话协作完全失效（业务按 sessionId 分片） | 引入 scope 级 `.collab` 目录只放 proposals/assignments；业务数据仍按会话隔离 |
| P0-3 | 旧探针用裸 service，44/44 假绿 | 重建在 `createWorkbenchHostService` 上，跨工作区路径才真正可达 |
| P1-1 | undo 栈 20 条打满后 collapse 被短路 | 加 anchorId + `undo:false` 落审计 |
| P1-2 | apply 失败后 undo 深度 4→0、canUndo=false | 改为定向 `store.mutate` 回滚 |
| P1-3 | `targetVersion` 存了但从不比对 | 改为逐条 `targetDigest`，空摘要硬拒绝 |
| P1-4 | `bySession`/`linkSession` 不校验调用者 | 判定为设计如此，已在文档说明 |

## 数据隔离（额外核查，未回归）

`.collab/workbench.json` 里 `events`/`tasks`/`audit`/`undo`/`redo` 全是
**空数组**（schema 骨架），仅 `assignments` 有真实数据。
Agent 的 `task.list` 看不到用户任务（0 条），`task.context` 只看到被指派的 1 条。
业务数据没有搬进共享层。

## 安全

| 检查 | 结果 |
| --- | --- |
| `proposal.apply` 是否只能靠 Host token | 是。无 token / `confirmed:true` / 伪造 token / 复用 / 跨会话 / 换目标，全部被拒 |
| AI 工具面是否含危险操作 | 27 个工具，不含 `event.delete`/`snapshot.replace`/`store.rollback`/`proposal.apply` |
| AI 能否自封完成 | 否。强塞 `done`/`status`/`completion` 被白名单丢弃；`writeProgress(100)` 拒；`requestCompletion` 后仍非 done；只有用户 `acceptCompletion` 才 done |
| 硬编码密钥 | 无 |
| `eval`/`new Function`/`innerHTML` | 无 |
| 依赖变更 | 无（未改任何 package.json / lockfile） |

Dependabot 报告远端默认分支有 9 个漏洞（5 high / 4 moderate）。**不是 WP6 引入的**
—— 本次提交未触碰任何依赖清单，这些是仓库既有问题，需单独处理。

## 未验证（如实披露，未伪装通过）

真实 macOS 休眠、通知横幅、VoiceOver、拖拽排序、原生文件选择器、窄视口视觉、
重启后会话重开、**GUI 会话跳转（插件层无此契约）**。
复审者也不是活的 DSH 进程，它只能用 `createWorkbenchHostService`，
不能声称 GUI 级验证。

## 残留风险

1. **最大风险：无独立签字。** 3 P0 的修复没有被第三方复验过，只经过实施方自测。
2. 变异真空 0 不等于无缺陷，只等于「守卫点都被测到」。
3. 跨工作区 apply 故意跳过全局 baseDigest（否则必冲突），改用逐条 targetDigest
   承担防替换职责 —— 这是权衡，不是零风险。
4. `.collab` 共享层设计是新增面，未来若有人把业务数据搬进去会破坏隔离。

## 建议下一步

对快照 `/tmp/wp6-freeze-11e4c8c`（或直接用 `27c4298`）在能正常运行的环境里
重跑独立复审，三份自测探针可直接复用。拿到 APPROVE 再宣告 WP6 关闭。

**WP6 到此停手，不进入 WP7。**
