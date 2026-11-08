REQUEST CHANGES

# WP6 最终独立复审裁决

> 审查对象：`a59f287`｜只读快照 `/tmp/wp6-freeze-a59f287`（digest `fa35208bad1d3da94cbafcd1f4b831cad9debff5` ✅）
> 审查方式：9 个独立探针，全部 `import` 冻结副本，真 service / 真 Host 装配层 / 真磁盘
> 详细实证：`findings.md`｜探针与日志：本目录 `probe-0*.mjs` / `probe-0*.log`

## 结论

**REQUEST CHANGES** —— 3 个 P0，不接受关闭 WP6。

WP6 的**基础安全设计是扎实的**：危险 op 不在 AI 工具面、审批 token 一次性且指纹绑定、
`pickPayload` 白名单真实有效、不可信文本不进控制流、跨 scope 越权被拒、
规划引擎真实复用 `freeSlots`/`conflicts`、UNVERIFIED 诚实保留。
这些我都逐条实测通过，不是恭维话。

但**验收口径与生产路径不一致**，导致两个核心承诺在真实部署下不成立，
第三个承诺被既有测试反向锁死。这些问题不是边角，恰好打在 WP6 的全部主张上：
「AI 不能自行完成任务」「Agent 生成 → 用户确认」「一次 undo 整体撤销」。

---

## Blockers（3 个 P0）

### P0-1 · AI 可绕过人工验收直接完成任务，并可撤销用户操作

**severity: P0**

`workbench_task_upsert` schema 暴露 `done`（`host-tools.js:227`），payload 构造器
**全量透传任意字段**（`host-tools.js:237-243`）；`task.upsert` 只在软删时要求审批
（`service.js:1009`），`done` 走普通写路径。

实测（`probe-01`、`probe-02`、`probe-09` 三处独立复现，真实 Host 装配层）：
```
$ node probe-01-ai-surface.mjs
PASS  T2.1 requestCompletion 后 done 仍为 false
FAIL  T2.2 AI 无法用 workbench_task_upsert 直接完成任务 — 实际 done=true
PASS  T2.3 任务完成未经 completion 验收流程 — completion={"status":"pending",...}

$ node probe-02-cross-session-and-complete.mjs
FAIL  A2 AI 无法用 workbench_task_upsert 直接置 done — 工具返回 done=true，库中 done=true
FAIL  A4 AI 无法把用户已验收的任务改回未完成 — 验收后 done=true，AI 改后 done=false
FAIL  A1 AI 无法撤销用户的操作 — 撤销后任务=空（用户建的任务被 AI 撤掉=true）
```

具体可复现的攻击：`requestCompletion` → `task.upsert({done:true})`，
任务变成「已完成」，`completion` 仍是 `pending`，**用户从未点过验收**。

直接违反契约 §3.5、`00-contract.md:52`、`workbench_help` 自述
（"AI can NEVER complete..."），以及 WP6-E 验收项 E1.16。

**加重情节**：`host-tools.test.mjs:379` 与 `workbench-ui-bridge.test.mjs:827`
**断言** `actor:'agent-tool'` 可以 `done:true` —— 修这个缺陷会先让既有测试变红。

**须修**：工具 schema 移除 `done`/`status`；payload 构造器改显式白名单；
把上述两条测试改为「应被拒」；补变异项。

---

### P0-2 · 真实 Host 下跨会话协作完全断裂（WP6-C 主路径不可达）

**severity: P0**

`forSession(sessionId, scope)` 的 dataDir = `rootDir/s-<sha256(sessionId)[:24]>[-scope]`
（`host-service.js:151-160`）—— **按 sessionId 分目录**。
Agent 与用户是两个 sessionId → 两个独立 store。

实测（`probe-08`、`probe-02`，两处独立复现）：
```
FAIL  B1 用户会话 A 能看到会话 B 的提案 — A 侧 list=0 条；get=not-found
FAIL  B2 用户会话 A 能确认落地会话 B 的提案 — not-found: 提案不存在
FAIL  B3 会话 B 的 Agent 能读到 A 关联给它的任务 — B 侧 tasks=0 条
FAIL  B4 task.bySession 在 B 侧命中 — 0 条
FAIL  B5 Agent 能对关联任务回写进度 — not-found: 待办不存在
```

**根因**：WP6-C/E 全部跨会话结论都在**裸 service + 单一 dataDir** 下验证
（`probe-wp6-e2e.mjs:39`），只用不同 sessionId 标签打同一个 store。
生产路径根本不会这样。

→ 契约 §4-B/E 的「Agent 生成 → UI 预览 → 用户确认 → 一次 undo 整体撤销」
在真实部署下不可达。用户看不到 Agent 的提案，`task.context`/`bySession`/
`writeProgress` 跨会话全部失效。

**须修**：为协作数据引入 scope 级共享存储（提案 + assignment），业务数据保持
session 分片；并补一条**真实 Host 双 session** 的回归测试。

---

### P0-3 · WP6-E「44/44」是假绿：验收探针的桩比真宿主宽松

**severity: P0**（与 P0-2 同源，单列以明确「验收证据不可信」）

`probe-wp6-e2e.mjs` 用单一 dataDir 的裸 service，我复跑确认仍 44/44：
```
$ node evidence/wp6/probe-wp6-e2e.mjs
WP6-E 端到端验收汇总: PASS=44 FAIL=0
```
它测的是「同一 store 内换 sessionId 标签互相可见」，不是生产拓扑。
E1.11/E1.12/E3.1/E3.2/E3.3 这五条跨会话断言**结构上不可能**发现 P0-2。

同样，`01-mutation-E.log` 的 165/165 CAUGHT 只证明「已定义的保护点有测试」，
变异集未覆盖：`task_upsert(done:true)`、栈满折叠短路、失败回滚清空 undo、
真实 Host 跨会话。

**须修**：验收探针必须跑真实 `createWorkbenchHostService` 双 session；
至少 4 条新变异项覆盖上述缺陷。

---

## 非阻塞问题（不阻碍关闭，但须在报告里列出）

| # | 问题 | severity | 证据 |
|---|---|---|---|
| 1 | undo 栈**已满**时 `collapseUndo` 首行 `if (current.length <= undoDepth) return` 短路，折叠完全不执行 → 一次 undo 只撤一条，20 条规模需按 20 次 Cmd+Z | **P1** | `probe-07`：`limit=20｜前置 20 条｜落地 20 条 → 回到原位需 20 次撤销`；根因 `store.js:304` |
| 2 | `proposal.apply` 失败回滚调 `store.rollback`，**清空用户既有 undo 历史** → 一次被拒的确认操作让之前所有操作不可撤销 | **P1** | `probe-06`：`失败后 undoDepth 4 → 0，canUndo=false` |
| 3 | `item.targetVersion` 被保存但 `apply` **从不比对**，契约 §1.2/§3.2 未兑现；`grep -rn targetVersion src/` 只在构造时做格式校验 | **P1** | `probe-03` A5：`targetVersion=0` 仍落地成功 |
| 4 | `task.bySession` / `linkSession` / `unlinkSession` 不校验调用方身份（`task.context` 校验了）→ 同模块安全策略不一致；当前被目录隔离兜住，一旦引入 collab 共享目录即失效 | **P1** | `probe-03` B4/B5/B6 |
| 5 | `baseVersion` 恒为 store **schema 常量** 1（不是数据版本），命名误导；防替换实际只靠 `baseDigest` | P2 | `probe-03` A1：`baseVersion=1`；`store.js:30` |
| 6 | `pickPayload` 保留 `status`，可写出 `status:'done'` 与 `done:false` 并存的矛盾行（UI 判定只看 `done`，无完成语义） | P2 | `probe-04` C3 |
| 7 | 撤销回归测试名写「接近 historyLimit」，实际用前置 19 + 落地 3，栈从未打满 → 测的是远离边界 | P2 | `planning-wp6.test.mjs:271` |

---

## 已确认通过的部分（实测，不是推断）

| 项 | 证据 |
|---|---|
| 危险 op 不在 AI 工具面（27 工具，无一命中 DANGEROUS_OPS） | `probe-01` T1.1/T1.2 |
| `proposal.apply` 只认 Host token；伪造 token / `confirmed:true` 均被拒 | `probe-01` T4.2/T4.3 |
| Host Service 未暴露可写 store/gate/events | `probe-01` T4.4 |
| `pickPayload` 裁掉 done/deleted/confirmed/approvalToken/id/sessionLinks/completion/executionLog/order/archived | `probe-04` A1 全部 27/27 PASS |
| `sourceText`/`reasoning`/`item.reason` 不参与控制流、不执行、不拼工具描述；控制字符剥离、2000 截断 | `probe-04` B1–B8 |
| `baseDigest` 真实防替换（数据变化 → `base-digest-mismatch`） | `probe-03` A2 |
| 跨 scope 读/写提案均被拒（目录级 + 逻辑级双隔离） | `probe-05` A1–A3 |
| `task.context` 严格拒跨会话（`conflict`） | `probe-05` A5 |
| 正常规模下一次 undo 精确整体回滚（含 25 条大提案、默认 limit） | `probe-06` A1–A3 |
| 提案元操作 `undo:false` 不污染撤销栈 | `probe-05` C5 |
| 规划引擎真实消费 `{free:[{startMs,endMs}]}`，无空闲时不造 | `probe-03` D1–D6 |
| 同一提案重复 apply 被拒、token 一次性、只建 1 条 | `probe-09` B1–B4 |
| 事件删除/批量删除需 token | `probe-09` C1–C3 |
| UNVERIFIED（GUI 会话跳转/系统通知/睡眠/VoiceOver/拖拽）诚实保留，未伪报 PASS | `findings.md` 问题 8 |

---

## 对「是否可关闭 WP6」的直接回答

**不能关闭。** 理由不是「还有优化空间」，而是：

1. WP6 的核心承诺之一（AI 不能自行完成任务）被 `workbench_task_upsert` 直接穿透，
   且既有测试在**保护**这个穿透行为；
2. WP6 的另一核心承诺（Agent 生成提案、用户跨会话确认）在真实 Host 拓扑下
   **完全不工作**，而验收证据 44/44 恰好绕开了这个拓扑；
3. 上述两点叠加后，「AI 智能规划 + Agent 会话协作」这条主线在生产环境里
   只剩「同会话自娱自乐」，达不到契约 §4-B/E 的验收信号。

P1 里第 1、2 条（撤销栈满失效、失败回滚清空历史）建议与 P0 同批修，
因为它们同样直接打在「一次 undo 整体撤销」这条验收项上。

修复后请重新冻结新 commit，我按同一套探针复验。

---

## 环境与边界声明

- 探针跑在冻结副本，**未**接入真实 DSH Host 进程（无 `ctx.tools.register` /
  `ctx.approval.request` 的真 Web GUI 会话）；「真实 Host 层」指
  `createWorkbenchHostService` 生产装配层（sessionId×scope 分片 + 真审批门）。
- 真机 UI 证据复用 `evidence/wp6/06-wp6-D-real-ui.log`，本次未重跑。
- 工作树内存在未提交修复（`evidence/wp6/08-wp6-E-p0-fixes.md`），
  **不在** `a59f287` 内，本次未采信、未审查。若以新 commit 重新冻结，请附新 digest。
- 仓库工作树**零改动**：所有写入落在 `mkdtemp` 临时目录，跑完即删。
