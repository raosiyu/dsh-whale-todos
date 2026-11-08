# WP6 最终独立复审 · 逐条实证

> 审查对象：commit `a59f287`，只读快照 `/tmp/wp6-freeze-a59f287`
> 快照完整性：`find . -type f | sort | xargs shasum | shasum` = `fa35208bad1d3da94cbafcd1f4b831cad9debff5` ✅ 与声明一致
> 全部探针 `import` 冻结副本，写入只在 `mkdtemp` 临时目录，仓库工作树**零改动**
> 运行环境：Node v22.23.2 / macOS（Apple Silicon）

复跑方式：`cd evidence/wp6/final-review && node probe-0X-*.mjs`

| 探针 | 覆盖 | 结果 |
|---|---|---|
| `probe-01-ai-surface` | AI 工具面清单、危险 op、伪造 token、同会话越权 | 12 PASS / 1 FAIL |
| `probe-02-cross-session-and-complete` | AI 完成/回退、真实 Host 跨会话 vs 裸 service 对照 | 6 PASS / 8 FAIL |
| `probe-03-binding-scope-undo` | 绑定/scope/撤销/规划引擎 | 16 PASS / 7 FAIL |
| `probe-04-untrusted-text` | pickPayload 白名单、注入、控制流 | 27 PASS / 0 FAIL |
| `probe-05-scope-and-undo-exact` | scope 隔离（Host 层）、撤销精确性 | 9 PASS / 4 FAIL |
| `probe-06-default-undo-and-rollback` | 默认 limit 大提案、失败回滚 | 6 PASS / 2 FAIL |
| `probe-07-undo-trigger-condition` | 撤销失效的精确触发条件 | 2 PASS / 3 FAIL |
| `probe-08-topology-truth` | 同会话 / 跨会话分别是否可用 | 5 PASS / 4 FAIL |
| `probe-09-final-gaps` | AI 撤销、幂等、事件删除 | 8 PASS / 1 FAIL |

---

## 问题 1 · 提案两阶段是否真的不可绕过

### 1.1 危险 op 确实不在 AI 工具面 —— 成立 ✅

```
$ node probe-01-ai-surface.mjs
AI 工具清单 (27):
  - workbench_event_list ... workbench_request_completion
PASS  T1.1 危险 op 未注册为 AI 工具 — 意外出现：无
PASS  T1.2 工具声明的 op 无一命中 DANGEROUS_OPS — 命中：无
FAIL  T2.2 AI 无法用 workbench_task_upsert 直接完成任务 — 实际 done=true
PASS  T3.1 AI 无法用 workbench_task_upsert 软删待办 — deleted=undefined
PASS  T4.1 AI 工具面没有"落地提案"的工具
PASS  T4.2 proposal.apply 不接受 payload.confirmed
PASS  T4.3 伪造 approvalToken 被拒
PASS  T4.4 Host Service 没暴露可写的 store/gate/events — 无
```

`proposal.apply` 走 `requireConfirmation('proposal.apply', ...)`（`proposal-ops.js:245`），
只认 `gate.verify()` 的 token；`confirmed` 字段在 `requireConfirmation`
（`service.js:143-152`）里根本不读。契约 §3.1「`payload.confirmed` 一律不采信」**成立**。

> ⚠️ 但 **`proposal.apply` 不可绕过 ≠ AI 不能完成任务**，见问题 1.2。

### 1.2 【P0】AI 可绕过人工验收直接完成任务 / 回退已验收任务 —— 指控成立 ❌

`workbench_task_upsert` 的 schema 暴露 `done`（`host-tools.js:227`），且 payload
构造器**全量透传**任意字段（`host-tools.js:237-243`）。`task.upsert` 只在**软删**时
要求审批（`service.js:1009`），`done` 走普通写路径。

**实测（三处独立复现：probe-01 同会话、probe-02 同会话、probe-09 AI 撤销）**：

```
$ node probe-01-ai-surface.mjs
PASS  T2.1 requestCompletion 后 done 仍为 false
  workbench_task_upsert(done:true) => {"ok":true,...,"done":true,"completion":{"status":"pending",...}}
FAIL  T2.2 AI 无法用 workbench_task_upsert 直接完成任务 — 实际 done=true
PASS  T2.3 任务完成未经 completion 验收流程 — completion={"status":"pending",...}
PASS  T3.1 AI 无法用 workbench_task_upsert 软删待办 — deleted=undefined
```
（注意 T2.3 与 T2.2 同时成立：任务已 `done=true`，`completion` 却是 `pending` ——
正是「已完成」与「待验收」并存的矛盾状态。）

```
$ node probe-02-cross-session-and-complete.mjs
A · AI 能否绕过人工验收（真实 Host 层，同一会话）
PASS  A1 requestCompletion 后 done 仍为 false
FAIL  A2 AI 无法用 workbench_task_upsert 直接置 done — 工具返回 done=true，库中 done=true
PASS  A3 完成未经过用户验收 — completion.status=pending
FAIL  A4 AI 无法把用户已验收的任务改回未完成 — 验收后 done=true，AI 改后 done=false
FAIL  A6 AI 能直接改用户任务标题（无需审批） — 实际 title=被 AI 改名
```

```
$ node probe-09-final-gaps.mjs
A · AI 能否撤销用户的操作
  用户操作后任务： u1
  workbench_undo(AI 调用) => {"ok":true,"op":"history.undo","result":{"undone":{"label":"task.upsert",...},"tasks":[]}}
FAIL  A1 AI 无法撤销用户的操作 — 撤销后任务=空（用户建的任务被 AI 撤掉=true）
PASS  A2 AI 工具面同时暴露 workbench_redo
```

**直接后果**
1. AI 先 `requestCompletion`（造出 `completion.status='pending'` 的假象），
   再 `task.upsert({done:true})` —— 任务变完成，**用户从未点过验收**。
   `completion` 仍是 `pending`，UI 会同时显示「待验收」和「已完成」。
2. AI 可把用户**已验收**的任务改回未完成。
3. AI 可调 `workbench_undo` **撤销用户自己的操作**（上例把用户刚建的任务整个撤掉）。

**这直接违反**
- 契约 §3.5「禁止自行完成/删除/批量覆盖：AI 工具面无 delete/complete/apply」
- `docs/wp6/00-contract.md:52`「AI 只能提交完成验收申请，不能自行完成任务」
- `workbench_help` 自述（`host-tools.js:371`）：
  「AI can NEVER complete, delete, bulk-overwrite, or apply a proposal by itself」
- WP6-E 验收项 E1.16「任务未被 AI 自行完成」

**为什么现有测试没抓到（测试假绿）**
- `collaboration-wp6.test.mjs` 只断言**不存在的工具名**（`workbench_complete_task` 等）
  和 `task.writeProgress(100)` 被拒，从未真的用 `workbench_task_upsert` 传 `done:true`。
- 更糟：两条既有测试**反向锁死了这个越权行为**：
  ```
  workbench-core/test/host-tools.test.mjs:379
    facade.execute('task.upsert', { task: {..., done: true } }, { actor: 'agent-tool' })
    assert.equal(out.task.done, true)          ← 断言 AI 可以置 done
  workbench-core/test/workbench-ui-bridge.test.mjs:827  同上
  ```
  也就是说：谁想修这个问题，现有测试会先红。这是**测试把缺陷固化成契约**。

**注**：工作树里已有未提交修复（`evidence/wp6/08-wp6-E-p0-fixes.md`），
但它**不在冻结对象 `a59f287` 内**，本次裁决不采信。

---

## 问题 2 · AI 内容不可信

### 2.1 【通过 ✅】`pickPayload` 白名单确实裁掉了私有字段

```
$ node probe-04-untrusted-text.mjs
PASS  A1 丢弃 done / deleted / deletedAt / confirmed / approvalToken / id
PASS  A1 丢弃 sessionLinks / completion / executionLog / order / archived
PASS  A2 保留 title
PASS  A3 event.create 丢弃 id/confirmed/approvalToken/deleted
PASS  A4 buildProposalItem 裁掉 payload 私有字段
PASS  A5 不允许的 op 被拒
PASS  A6 空 title 被拒
```

`pickPayload`（`proposal.js:153-170`）按 op 给字段白名单，`task.create` 只留
`title/dueAt/priority/status/project/subtasks/estimatedMinutes`；`apply` 时
`buildProposalItem(item)` 再过一遍（`proposal-ops.js:269`）—— 双保险，实测有效。

### 2.2 【通过 ✅】不可信文本不影响控制流

```
PASS  B1 sourceText 原样存但不执行
PASS  B2 reasoning 原样存但不执行
PASS  B3 item.payload.done 已被裁掉
PASS  B4 注入文本未改变提案条数/op
PASS  B5 控制字符被剥离 — "abc"
PASS  B6 超长文本被截断（2000）
PASS  B7 落地后任务未因注入被置 done — done=undefined
PASS  B8 标题关键词只影响 priority 字段
```

全仓 grep 确认：`sourceText`/`reasoning` 只出现在存储与 UI 展示
（`client.js:1382-1383`），不进工具描述、不进 `eval`、不进分支；
全仓无 `innerHTML` / `eval(` / `new Function`（`client.js` 用 `h()` 虚拟节点）。

**一处需要说明但不算缺陷**：`pickPayload` 保留了 `status`，因此提案可写出
`status:'done'`（`probe-04` C3：`status=done`）。UI 判定完成只看 `done` 布尔
（`client.js:883`），所以不构成完成语义；但会在数据里留下「status=done 且 done=false」
的矛盾行 — 属 **P2 数据洁净度**，不是安全缺陷。

---

## 问题 3 · 绑定与防替换

### 3.1 【通过 ✅】`baseDigest` 真实生效

```
$ node probe-03-binding-scope-undo.mjs
PASS  A2 提案生成后数据变化 → apply 被拒（baseDigest 生效）
        — conflict: 提案绑定校验失败：base-digest-mismatch
PASS  A3 数据未变时可正常落地
```

`verifyProposalBinding`（`proposal.js:262-267`）比对 `baseVersion` + `baseDigest`，
digest 是 `{version, events, tasks}` 的 SHA-256（`store.js:290`）。防替换**成立**。

### 3.2 【P2】`baseVersion` 名不副实

```
PASS  A1 baseVersion 恒为 schema 常量（不是数据版本） — baseVersion=1
```

`store.read().version` 是 **store schema 版本**（`store.js:30`，常量 1，永不递增），
不是数据版本。契约 §1.2 把它描述为「提案生成时的 store.version（防确认后数据被替换）」，
实际防替换**只靠 `baseDigest`**。字段名误导，但 `baseDigest` 已覆盖该职能 → P2。

### 3.3 【P1】`targetVersion` 被保存但**从未参与校验** —— 契约未兑现

```
$ node probe-03-binding-scope-undo.mjs
PASS  A4 提案保存了 targetVersion — targetVersion=0
FAIL  A5 targetVersion 参与 apply 校验（契约 §1.2 声称）
        — 落地成功：title 原标题 → 提案标题
```

```
$ grep -rn "targetVersion" workbench-core/src/
proposal.js:100   （JSDoc）
proposal.js:132-136 （只在构造时做「非负整数」格式校验）
```
`proposal-ops.js` 在 `task.update` 分支只校验 `targetId` 存在（`:309-312`），
**不读 `item.targetVersion`**。契约 §1.2「`targetVersion`：update 时绑定该实体版本」
与 §3.2「重算比对，不匹配整份拒绝」**未实现**。

影响：同一任务的两次并发提案，后确认者会静默覆盖前者修改（无「目标已被改动」拒绝）。
`baseDigest` 能挡住**任意**数据变化，所以在单用户场景下多数情况仍会被拦；
但它在提案生成**之后**任何无关写入都会误伤，而 `targetVersion` 本应提供精确到目标的判定。
→ **P1（契约未兑现 + 乐观锁缺位）**，非 P0。

---

## 问题 4 · 跨会话 / 跨 scope 权限

### 4.1 【通过 ✅】跨 scope 确实被拒（真实 Host 层）

```
$ node probe-05-scope-and-undo-exact.mjs
  数据目录： s-3767b3af892024cba4dfc226 , s-3767b3af892024cba4dfc226-d9298a10d1b0
PASS  A1 两个 scope 数据目录隔离 — 默认=d1｜other=o1
PASS  A2 跨 scope 读提案被拒（not-found）
PASS  A3 跨 scope 落地提案被拒
PASS  A5 task.context 拒绝读取他人会话上下文（conflict）
```

scope 进目录路径（`host-service.js:157-160`），`proposal.list/get/reject` 按 scope 过滤，
`task.context` 强制 `payload.sessionId === meta.sessionId`（`proposal-ops.js:430`）。
**跨 scope 无越权**。

### 4.2 【P0】真实 Host 下「同 scope 跨会话可见可确认」**完全不成立** —— 主路径断裂

契约 §7.1 与 WP6-E 修正记录声称：改为按 scope 隔离后，Agent 生成提案、用户可确认。
但 `createWorkbenchHostService.forSession(sessionId, scope)` 的 dataDir 是
`rootDir/s-<sha256(sessionId)[:24]>[-scope]`（`host-service.js:151-160`）——
**按 sessionId 分目录**。Agent 与用户是两个不同 sessionId → 两个完全独立的 store。

```
$ node probe-08-topology-truth.mjs
A · 同会话（Agent 工具与 UI 面板同一 sessionId）
PASS  A1 Agent 在同会话生成提案
PASS  A2 同会话用户面板能看到该提案 — 1 条
PASS  A3 同会话用户能确认落地 — created=2
PASS  A4 同会话 Agent 能读 task.context — 1 条

B · 跨会话（Agent 在会话 B 跑，用户在会话 A 的面板确认）
  B 会话生成提案 id = 9457f19e-...
FAIL  B1 用户会话 A 能看到会话 B 的提案 — A 侧 list=0 条；get=not-found
FAIL  B2 用户会话 A 能确认落地会话 B 的提案 — not-found: 提案不存在
FAIL  B3 会话 B 的 Agent 能读到 A 关联给它的任务 — B 侧 tasks=0 条
FAIL  B4 task.bySession 在 B 侧命中 — 0 条
  实际数据目录： s-3148a..., s-d181b..., s-fc7ea...

C · WP6-E 探针口径（单一 dataDir）
PASS  C1 裸 service（单一 dataDir）下跨会话可见 — 可见（这正是 E2E 44/44 的口径）
```

**同一现象在探针 2 独立复现**：
```
FAIL  B1 用户会话能看到 Agent 生成的提案 — 用户侧 list=0 条；get=not-found
FAIL  B2 用户能确认落地 Agent 的提案 — not-found: 提案不存在
FAIL  B3 Agent 用 task.context 读到自己被关联的任务 — Agent 侧 tasks=0 条
FAIL  B4 task.bySession 反查命中 — 0 条
FAIL  B5 Agent 能对关联任务回写进度 — not-found: 待办不存在
```

**根因**：WP6-C/E 的所有跨会话结论都是在**裸 `createWorkbenchService` + 单一 dataDir**
下验证的（`probe-wp6-e2e.mjs:39`：`createWorkbenchService({ dataDir: dir, ... })`，
然后 `ex(USER,...)` / `ex(AGENT,...)` 用不同 sessionId 打**同一个 store**）。
真实 Host 每个 session 一个目录，这套口径**结构上不可能**覆盖跨会话。

**WP6-E「44/44 PASS」因此是假绿**：它证明的是「同一个 store 里两个 sessionId 标签
互相可见」，而生产路径根本不会这样。契约 §4-B/E 的
「Agent 生成 → UI 预览 → 用户确认 → 一次 undo 整体撤销」在真实部署下**不可达**。

**影响**
- 用户看不到 Agent 生成的提案 → 无法确认落地 → 主路径不可用。
- 用户无法把任务关联到 Agent 会话让 Agent 读到 → `task.context` / `task.bySession` /
  `task.writeProgress` 全部在跨会话时失效。
- 反过来：**同会话**（用户在同一个会话里用工具+面板）一切正常，
  所以这不是「完全不能用」，而是「契约承诺的跨会话协作不可用」。

### 4.3 【P1】`task.bySession` / `task.linkSession` / `task.unlinkSession` 不校验调用方

```
$ node probe-03-binding-scope-undo.mjs
PASS  B4 任意会话可用 task.bySession 反查他人关联任务（无调用方校验）
        （裸 service 单一 dataDir 口径；真实 Host 因目录隔离实际查不到）
PASS  B5 未关联的会话不能给任务写进度 — 陌生会话写入成功   ← 裸口径
PASS  B6 陌生会话不能解除他人会话关联 — 解除成功 removed=1  ← 裸口径
```

真实 Host 下（`probe-05` A6/A7/A8）因目录隔离这三项都 `not-found`，
**不会越权**。所以这是「裸 service 口径下的缺失校验」，在生产拓扑被目录隔离兜住。
但 `task.context` 做了严格校验、`task.bySession` 却没做 —— **同一模块内安全策略不一致**。
若将来引入 collab 共享目录（工作树里的修复正是这么做的），这层兜底就没了。
→ **P1（前瞻性防御缺失 + 内部不一致）**。

---

## 问题 5 · 撤销正确性

### 5.1 【通过 ✅】正常情况 anchorId 生效、一次 undo 整体回滚

```
$ node probe-05-scope-and-undo-exact.mjs
PASS  B1 栈未满：栈顶为 proposal.apply
PASS  B2 栈未满：一次撤销精确回滚 — 3 → 5 → 3

$ node probe-06-default-undo-and-rollback.mjs
  落地 25 条；任务 3 → 28；undoDepth 3 → 4；nextUndo=proposal.apply
PASS  A1 落地 25 条应折叠为一条 undo
PASS  A2 一次撤销回到落地前 — 撤销后 3，期望 3
```

### 5.2 【P1】undo 栈**已满**时折叠完全不执行，一次 undo 只撤一条

精确触发条件（`probe-07`）：

```
$ node probe-07-undo-trigger-condition.mjs
默认 limit=20｜前置 3 条｜落地 25 条
  前置栈深=3，落地 25 条 → nextUndo=proposal.apply；回到原位需 1 次撤销   PASS
默认 limit=20｜前置 20 条（栈满）｜落地 20 条
  前置栈深=20，落地 20 条 → nextUndo=task.upsert；一次 undo 后 20→39；回到原位需 20 次撤销   FAIL
默认 limit=20｜前置 20 条（栈满）｜落地 25 条
  → nextUndo=task.upsert；一次 undo 后 20→44；回到原位需 20 次撤销        FAIL
limit=5｜前置 5 条（栈满）｜落地 6 条
  → nextUndo=task.upsert；一次 undo 后 5→10；回到原位需 5 次撤销          FAIL
默认 limit=20｜前置 0 条｜落地 20 条
  → nextUndo=proposal.apply；回到原位需 1 次撤销                        PASS
```

**根因**：`store.collapseUndo` 首行
```js
if (current.length <= undoDepth) return { collapsed: 0 }   // store.js:304
```
落地前栈已满（`undoDepth === historyLimit`）时，落地过程中每次 `commit` 都
`slice(-historyLimit)` 裁剪，栈深**始终不增长**，于是 `current.length === undoDepth`
命中短路，**折叠一行都不执行**。此时 `anchorId` 那条路径根本走不到。

**影响**：用户一旦攒满 20 步历史（长会话里非常常见），此后每次规划落地
都要按 20 次 Cmd+Z 才能撤回，且中间会看到半落地状态 —— 直接违反
契约 §4-B「一次 undo 可整体撤销」与 WP6-D 的「真机缺陷修复」结论。

**为什么测试没抓到**：`planning-wp6.test.mjs:271` 那条回归测试用
**前置 19 条 + 落地 3 条**（`targetTitles:['A','B','C']`），栈从未真正打满，
`current.length > undoDepth` 恒成立 → 短路分支永远不进。
测试名写着「接近 historyLimit」，实际测的是**远离** historyLimit。

### 5.3 【P1】apply 失败回滚会**清空用户既有 undo 历史**

```
$ node probe-06-default-undo-and-rollback.mjs
PASS  B0 前置：有可撤销历史 — undoDepth=4
PASS  B1 失败提案被拒（not-found）
PASS  B2 失败后无半落地数据
  失败后 undoDepth 4 → 0，canUndo=false
FAIL  B3 失败回滚不得清空用户既有 undo 历史 — 撤销历史被从 4 清到 0
FAIL  B4 用户仍能撤销此前自己的操作
```

`proposal.apply` 失败时调 `store.rollback(...)`（`proposal-ops.js:316`），
而 `store.rollback` 明确「回滚必须清空撤销/重做栈」（`store.js:282-285`）。
对 `event.import` 这类「整库替换」是合理的；但一次**被拒绝的提案**
（用户什么都没改、数据零变化）不该剥夺用户的撤销历史。
用户视角：点了一次「确认」失败 → 之前 20 步操作再也撤不回来。

### 5.4 【通过 ✅】提案元操作不进 undo 栈

```
PASS  C5 preview/reject 不入 undo 栈 — 4 → 4
```
`undo:false`（`proposal-ops.js:176,226,334`）未破坏既有 undo 语义。

---

## 问题 6 · 规划引擎是否真实复用 `freeSlots` / `conflicts`

### 【通过 ✅】真实消费，无自造

```
$ node probe-03-binding-scope-undo.mjs
PASS  D1 传入 freeSlots 产出排期 item — 1 条
PASS  D2 排期落在传入的空闲时段内 — 2026-11-09T08:00:00 → 2026-11-09T08:30:00
PASS  D3 无空闲时段时不产排期 item（不自己造空闲）
PASS  D4 service 路径产出基于真实 freeSlots 的排期 — 1 条
PASS  D5 排期不与既有事件重叠 — 避开
PASS  D6 提案带 conflicts 字段（来自真实 event.conflicts）
```

关键点：`event.freeSlots` 返回 `{free:[{startMs,endMs}], busy:[]}`（`conflict.js:56-95`），
`service.js:1189-1199` 显式取 `.free` 再传给引擎，并有注释记录
「不取 .free 的话规划引擎恒拿到空数组 → 排期永远为空（实测假绿）」。
`planning.js:255-256` 消费 `startMs/endMs`。`D3` 证明引擎不会自己造空闲。
这一项**质量最高**，且有对应变异项 `WP6B5` 锁死。

---

## 问题 7 · 测试有效性

### 7.1 【P0】E2E 探针与生产拓扑不一致 → 44/44 假绿

见问题 4.2。`probe-wp6-e2e.mjs:38-43`：
```js
const dir = mkdtempSync(...)
let svc = mk()                                    // 单一 dataDir
const ex = (sid, op, payload, meta={}) => svc.execute(op, payload, { sessionId: sid, ... })
```
所有「跨会话」断言（E1.11/E1.12/E3.1/E3.2/E3.3）都是在**同一 store** 里换 sessionId，
而生产代码（`host-service.js`）按 sessionId 分目录。**桩比真宿主宽松**，典型的假绿。

我复跑确认它仍然 44/44：
```
$ node evidence/wp6/probe-wp6-e2e.mjs
WP6-E 端到端验收汇总: PASS=44 FAIL=0
```
→ 44/44 真实，但**测的不是生产路径**。

### 7.2 【P1】测试反向锁死缺陷

`host-tools.test.mjs:379`、`workbench-ui-bridge.test.mjs:827` 断言
`actor:'agent-tool'` 可以 `done:true`。修 P0-1 会先让这两条测试红 ——
缺陷被写成了期望行为。

### 7.3 【通过 ✅】变异证据本身可信

`01-mutation-E.log` 记录 165/165 CAUGHT、0 VACUUM、0 SKIP，且变异项确实对应真实保护点
（`WP6A5 进度允许 100`、`WP6B5 freeSlots 对象当数组传`、`WP6C1 task.context 不校验` 等）。
但**变异集里没有一条覆盖**：`workbench_task_upsert(done:true)`、
「栈满时折叠短路」、「失败回滚清空 undo」、「跨会话真实 Host 拓扑」——
所以 165/165 的真实结论是「已定义的保护点都有测试」，不是「无缺陷」。

### 7.4 【通过 ✅】`fakeSchedule` / contract-stub 诚实

`workbench-core/test/helpers/contract-stub.mjs:22-27` 明确写出
「这是**行为模拟**，不是真宿主：不复现存储域事务、并发队列、Session 投递」。
隔离性好，无夸大。

---

## 问题 8 · UNVERIFIED 是否被诚实保留

### 【通过 ✅】诚实保留，未伪报 PASS

| 项 | 位置 | 结论 |
|---|---|---|
| GUI 会话跳转 | `docs/wp6/00-contract.md:232`、`evidence/wp6/04-wp6-C-delivery.md:28,82` | 明写「无一手契约，保持 UNVERIFIED」，且**没有**自造 `openSession` |
| macOS 系统通知 / 睡眠 | `docs/wp6/00-contract.md:206,210-213` | 列入「不做」与「承接的 UNVERIFIED」 |
| VoiceOver / 原生拖拽 / 窄屏 | 同上 | 同上 |
| 重启后老会话 | 同上 | 同上 |

`docs/wp0`–`docs/wp5` 的同类章节也保持一致口径。这一项**做得好**：
没有把无契约的能力包装成 PASS。

---

## 附：环境限制说明

- 所有探针在冻结副本上跑，**未**接入真实 DSH Host 进程（`ctx.tools.register` /
  `ctx.approval.request`）。因此「真实 Host 层」指 `createWorkbenchHostService`
  这一生产装配层（含 sessionId×scope 分片、真审批门），**不含**真 Web GUI。
- 真机 UI 证据复用 `evidence/wp6/06-wp6-D-real-ui.log`，本次未重跑。
- 跨会话修复（工作树 `08-wp6-E-p0-fixes.md`）**不在** `a59f287` 内，未采信、未审查。

---

## 判定汇总

| # | 结论 | 级别 |
|---|---|---|
| 1.1 | 危险 op 不在 AI 工具面；token 门有效 | ✅ |
| 1.2 | **AI 可绕过验收直接完成 / 回退已验收任务 / 撤销用户操作** | **P0** |
| 2.1 | `pickPayload` 白名单有效 | ✅ |
| 2.2 | 不可信文本不参与控制流 | ✅ |
| 2.3 | `status:'done'` 可写入但非完成语义 | P2 |
| 3.1 | `baseDigest` 防替换有效 | ✅ |
| 3.2 | `baseVersion` 恒为 schema 常量，命名误导 | P2 |
| 3.3 | `targetVersion` 保存但从不校验，契约未兑现 | P1 |
| 4.1 | 跨 scope 越权被拒 | ✅ |
| 4.2 | **真实 Host 下跨会话协作完全断裂，E2E 假绿** | **P0** |
| 4.3 | `bySession/linkSession/unlinkSession` 无调用方校验 | P1 |
| 5.1 | 正常规模一次 undo 整体回滚 | ✅ |
| 5.2 | undo 栈满时折叠短路，需 N 次撤销 | P1 |
| 5.3 | apply 失败回滚清空用户 undo 历史 | P1 |
| 5.4 | 元操作 `undo:false` 语义正确 | ✅ |
| 6 | 规划引擎真实复用 freeSlots/conflicts | ✅ |
| 7.1 | E2E 探针桩比真宿主宽松 | **P0**（与 4.2 同源） |
| 7.2 | 两条测试反向锁死 AI 越权 | P1 |
| 7.3 | 变异集未覆盖上述缺陷 | P1 |
| 8 | UNVERIFIED 诚实保留 | ✅ |
