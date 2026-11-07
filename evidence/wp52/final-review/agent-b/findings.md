# WP5.2 最终独立 Review · Agent B 逐条发现

**审查范围**：跨 session/scope 隔离 / 真实投递去重 / Host 审批安全
**冻结副本**：`/tmp/wp52-freeze-e9b2b32`（digest `131e8c74…`，只读）
**探针**：`probe-isolation.mjs` → `probe-isolation.log`（PASS=26 FAIL=0）；
`probe-approval-real.log`（真 ApprovalService 专项）
**结果**：26/26 PASS + 2/2 通过（0 skip）

## B1 · 跨 session 隔离

`catalog()` 返回全表（真 Host 行为）。探针让 session-B 先建一条本插件提醒，
再让 session-A 对空数据对账：

```
A 对账: deleted=0 kept=0 observed=0 failed=0
```

`delete` 调用 0 次、`update` 调用 0 次、B 的记录仍在。
**A 根本看不到 B 的记录**（sessionId 过滤在 `ownHostRecords` 最外层），
不存在跨 session 误删/误改。

## B2 · 同一 session 跨 scope 隔离

| 项 | 输出 |
|---|---|
| projA / projB 各建 | `created=1 / created=1`，catalog 2 条 |
| identity | `task:projA:t1` 与 `task:projB:t1` 不同 |
| projB 对空数据 | `deleted=1`（删自己的 f2）；剩 1 条且是 projA 的 f1 |
| projA 记录 | `observed: [{level:'suspect', reason:'scope-mismatch'}]` → 保留 |

**结论**：不互相踩踏，且被排除的记录如实上报。

## B3 · 幂等 → 投递去重前提

```
create 调用次数=1 | r1.created=1 r2.created=0 r3.created=0
r2.unchanged=1 r3.unchanged=1 | catalog 只有 1 条
改期：updated=1 created=0，create 累计仍为 1
```

同一 identity 连续 reconcile 三次只 create 一次；改期走 update 不新建。
与 `02-delivery.md` §1 的真机证据一致：`user/message` 仅 1 次（seq=163），
`agent/inbox/spliced` 是同一消息入队视角。**不存在重复 create → 重复投递**。

## B4 · dataDirFor 与目录一致性

| 项 | 结果 |
|---|---|
| 两个 scope 目录 | 不同且都真实存在 |
| 重复调用 | 幂等 |
| 业务数据落盘 | 确实写在 `dataDirFor` 指向的目录（写 `event.create` 后核对 `workbench.json`） |
| scope 含 `a::b::c` | `openedSessions` 原样返回（P2-7 已修） |

**未发现第二份 hash 实现**：桥接层已改用 `service.dataDirFor()`，
`index.js` 不再自行计算 sha256 前缀。

## B5 · Host 审批安全

```
DANGEROUS_OPS: ["event.delete","event.bulkDelete","event.import",
                "snapshot.replace","store.rollback","event.restore","task.upsert"]
```

| 项 | 结果 |
|---|---|
| 无 token | `confirmation-required` ✅ |
| `payload.confirmed: true` | 仍被拒（不采信）✅ |
| 真 token | `imported=1` ✅ |
| 同一 token 复用 | 被拒（一次性）✅ |
| 换内容用旧 token | 被拒（绑定 `contentDigest`）✅ |
| 同一文件二次导入 | `imported=0 skipped=1`（幂等且审批未破坏）✅ |

## B5-ext · host-approval-real 真 ApprovalService 专项

**发现的真实环境依赖问题**：

首次在冻结副本上直接跑该测试（`/tmp/dsh-asar-full` 已被上一轮清理删除）：

```
# tests 2 / # pass 0 / # fail 0 / # skipped 2
```

测试按自身设计「asar 解包目录不存在时明确 SKIP 并打印原因，**绝不用假实现冒充**」——
这是**正确的降级**，但也意味着 WP5.2 宣称的「437/437 全通过」**依赖外部
`/tmp/dsh-asar-full` 解包目录存在**。目录不在时那 2 个测试静默跳过，
全量数字会变成 435/435（含 2 skip），而报告不会自动察觉。

重建 asar 解包后重跑：

```
# tests 2 / # pass 2 / # fail 0 / # skipped 0
```

并确认 `init` 断言是**真代码、不只是注释**：

```
:171  assert.ok(approval.approvalProjectionHandle !== undefined …
:174  assert.equal(typeof approval.approvalProjectionHandle.stateOf, 'function', …
:180  assert.equal(projected.turnOpen, true, 'turn/start 事件应被折叠进投影')
```

**判定**：这是 **P2 环境依赖 / 可观测性缺口**，不是安全缺陷：
- 测试自身明确 SKIP 并打印原因，没有伪装通过；
- 有 `init` 直接断言，桩不比真宿主宽松；
- 恢复依赖后 2/2 真通过。
- 但它确实让「全量 437/437」这个数字**不可无条件复现**。
  建议列入 WP6 的测试基础设施改进（把 asar 依赖固化或显式前置检查），
  **不构成 WP5.2 关闭的 blocker**。

## 严重度汇总

| 级别 | 数量 | 内容 |
|---|---|---|
| P0 blocker | **0** | 无跨 session/scope 越权、无重复投递、无审批绕过 |
| P1 | 0 | — |
| P2 环境依赖 | 1 | `host-approval-real` 依赖外部 asar 解包目录，缺失时 2 个测试 SKIP |
| UNVERIFIED | 保留 | 真实 macOS 睡眠 / 系统通知 / VoiceOver / 拖拽 |

---

## 补录：独立 Agent B 探针（迟到产出）的逐条甄别

本文件初版由 Lead 的冻结探针写成。之后独立 Agent B 通道恢复并产出
`probe-dedup.mjs` / `probe-approval.mjs` 及对应 log（时间戳 18:02–18:04）。
其探针报出若干 FAIL，**逐条实证甄别如下**，不把探针错误包装成产品缺陷，
也不把真缺陷压下去。

| 探针 FAIL | 甄别结论 | 依据 |
|---|---|---|
| Q3.2(b) 未编码 prompt 判 update | **探针预期写反** | 比较基准必须是 `encodePrompt(...)`，这是 WP5.1 修过的幂等 bug 的设计意图 |
| Q3.4/Q3.5 scope 含冒号 `a::b` / `x:y:z` 往返失败 → 重复 create | **真缺陷 P1** | `reminderIdentity` 用 `:` 拼三段，`decodeIdentity` 用 `([^:]*)` 只吃不含冒号的 scope；实测 `task:a::b:e1` 解出 scope=`a`。连续 reconcile 两次 create=2、Host 行数=2 |
| Q4.1 `task.upsert` 无 token 未被拒 | **探针预期写反** | `task.upsert` 是**条件审批**：新建/编辑不需审批（授权要求快速创建），仅软删/复活软删需要。见 `service.js:975-996` 注释 |
| Q4.5 deny 模式「未拦」 | **探针输出格式错误** | 独立探针实测 `event.create/task.upsert/history.undo/task.reorder` 全部 `BLOCK confirmation-required`（`不可写模式（deny）：… 一律拒绝`）。探针把 BLOCK 显示成「未拦 (confirmation-required)」 |
| Q4.6 `host-tools.js 出现 .confirmed` | **正则误报** | `host-tools.js` 里 `.confirmed` 只在**注释**（:26、:124），:124 明写「工具绝不从 args 里读 confirmed」 |

### 真缺陷详情（P1，非 blocker）

**位置**：`workbench-core/src/reminder-sync.js:95-110`（`reminderIdentity`）与 `:371-381`（`decodeIdentity`）

**问题**：identity 用 `:` 分隔三段 `kind:scope:entityId`，但 scope 本身允许任意字符串
（`parsed.req.scope` 外部传入；契约里 `project` 可作 scope，项目名可能含冒号）。
`decodeIdentity` 的 `([^:]*)` 遇到含冒号 scope 会截断，导致自家记录被判
`suspect/scope-mismatch`，每轮 reconcile 都重新 create。

**影响**：重复注册 → 重复投递（同一提醒产生多条 Host 任务）。
**不**导致误删（保守策略仍保留），**不**导致跨 session/scope 越权。

**建议修法**：identity 改用不会与 scope 冲突的编码（如 scope 做 `encodeURIComponent`
或改用 `\u0000` 分隔），并补含冒号 scope 的往返测试与变异项。
**列入 WP6 修复清单**（见 `shared/02-wp6-plan.md`）。

**为何不算 WP5.2 关闭的 blocker**：触发需含冒号的 scope；后果是重复注册而非
误删/越权/数据损坏；且 WP5.2 授权范围内的既有真机验证（空 scope）不受影响。
按「如无 blocker 则关闭」的口径可关闭，但**必须作为已知缺陷登记**。

---

## 补录二：`probe-scope-colon.log` 把缺陷升级为 P0

独立 Agent B 追加了端到端探针 `probe-scope-colon.mjs` / `.log`（18:10）。
它不再只看「create 次数」，而是把重复行与 **Host 真实投递模型**连起来：

```
[含冒号 scope] scope="a::b"
  r1.created=1 r2.created=1 r3.created=1
  Host active 条数=3  create 调用=3
  Host identities=["task:a::b:t1","task:a::b:t1","task:a::b:t1"]
>>> 判定：含冒号 scope 3 次写操作 → 3 条 active 提醒 / 3 次 create

S3 投递语义佐证：
  行A due=true 行B due=true（同一到点时刻，两个不同 id）
  依据 02-delivery.md §1.2 drive() 扫全表 scheduledAt<=Date.now()，
  无 identity 去重 → 两条都满足 due 条件，会各自投递。
  结论：重复注册 = 重复投递（在本 Host 投递模型下）。
```

**定级修正**：初版把这条定为 P1「重复注册」。
但 `drive()` 全表扫描、无 identity 去重，意味着**同一提醒到点会投递 N 次**，
且自家记录恒被判 `suspect`，白名单与 `observed` 无法收敛、孤儿只增不减。
这是**产品行为错误**（重复打扰用户），命中本轮重点审查项「真实投递去重」，
构成 **P0 blocker**。

因此 `verdict.md` 由 APPROVE 改为 **REQUEST CHANGES**，
`shared/01-final-verdict.md` 综合裁决同步改为 REQUEST CHANGES，
**WP5.2 暂不关闭**。

### 该 P0 的修复与复审要求（供后续授权执行）

1. `reminderIdentity` / `decodeIdentity` 改用不与 scope 冲突的分隔
   （`encodeURIComponent` 或 `\u0000`），保证任意 scope 往返一致。
2. 补测试：含 `a::b` / `x:y:z` / `proj:sub` 的 scope，
   `decodeIdentity(reminderIdentity(...))` 往返一致；
   连续三次 reconcile `create` 恒为 1。
3. 补变异项锁死该保护点，跑 `r3-mutate.mjs` 必须 0 真空 0 跳过。
4. 针对该缺陷单独复审（明确 APPROVE/REQUEST CHANGES）后，
   才能正式关闭 WP5.2。

---

## 补录三：`probe-stub.log` / `probe-real-approval.log` 甄别

| 探针输出 | 甄别 |
|---|---|
| `[FAIL] 不再绕过 Cordis fiber 直接实例化` | **误报**：`new ApprovalService` 只出现在 `host-approval-real.test.mjs:121` 的**注释**里（解释为何不能直接 new）。实际加载走 `loadApprovalService()` 的 `ctx.plugin` + `await fiber`，探针自己也 `[PASS]` 了这一点 |
| `[FAIL] fail-closed 判据未被放宽` | **误报**：探针数 `r.approved===false` 断言只数到 1 处，实际有 4 处（:259 循环覆盖 rejected/cancelled/unavailable、:278 never、:295 无 answerer）。是探针计数逻辑错 |
| `await fiber 前 initDone=false，await 之后=true` | **通过**：证明 fiber 真等到了 `init()` |
| `probe-real-approval.log` | **2/2 真通过，0 skip**（直接运行冻结副本的 `host-approval-real.test.mjs`） |
| `[ENV-LIMIT] 无 asar → 无法逐字段对比桩与真 def.apply` | **如实保留**：探针自己声明了环境限制，不判通过也不判失败。本次审查会话已重建 asar 并跑出 2/2，桩的宽松性未发现实证问题 |

**不改变裁决**：Agent B 仍为 `REQUEST CHANGES`，唯一 blocker 是
`probe-scope-colon.log` 的 P0 重复投递。
