# WP2 第二轮 Review：问题清单（发现于冻结 commit `72e09ef`）

冻结基准：`72e09ef`，纯快照 `/tmp/wp2-freeze-72e09ef`（无 `.git`）。
发现方式：主会话自行对抗性验证（不等复审 Agent 结论），攻击对象为**用户点名的第 5 项：`title+at` 备用键**。

结论：**合成键设计有缺陷，建议本轮判 REQUEST CHANGES**，修复后再冻结新 commit 复审。

## R2-1（BLOCKER）：合成键会重复 → 取消一条提醒后另一条成孤儿

**文件**：`workbench-core/src/schedule-adapter.js` 中 `syntheticKey()` + `list()` 的 `idByKey.set(key, row.id)`

**复现**（`/tmp/wp2lead/key-dup-impact.mjs`）：

```
宿主 2 条（不同 id、同标题「站会」、同时刻 9:00）→ list():
  host:7fbf4d3ba…(h-A)
  host:7fbf4d3ba…(h-B)      ← 两个键完全相同
两键相同? true

cancel(listed[0].reminderKey) 后：
  宿主剩余 1 条 [h-A]
```

**两个后果**：

1. **同键覆盖**：`list()` 里 `idByKey.set(key, row.id)` 被后一条覆盖，前一条的 `hostId` 映射丢失。`remove` 只能删掉一条，另一条成为**孤儿提醒**——用户点「取消提醒」后，宿主侧仍会响。
2. **`reconcile` 误删**（`/tmp/wp2lead/synth-key-attack.mjs` 场景 C）：

```
desired 两条不同 reminderKey（event:ev1 / event:ev2，同标题同时刻）
→ created=2  removed=1   宿主新增=2 宿主删除=1
```

宿主里**合法存在**的一条被当成「多余」删掉，同时新建两条 —— **丢提醒 + 重复注册**并存。

## R2-2（MAJOR）：ISO 时间格式差异导致同一提醒生成两个键 → 去重失效

**复现**（同一脚本场景 B）：

```
宿主条数=2（'2026-11-01T09:00:00Z' 与 '2026-11-01T09:00:00.000Z'，实际同一时刻）
list() 键: host:4620a1b98b653ee4f1c2be82
           host:7fbf4d3ba272792d85ea31ba      ← 不同
⚠️ 未合并
```

`fireAtMs` 已用 `Date.parse` 归一，但**合成键用的是原始字符串**，所以同一时刻不同写法产生不同键 → 跨重启去重**失效**（正是 B1 想修的那个问题，在合成键路径上复活）。

## R2-3（MAJOR）：不回报 key 的宿主上，reconcile 必然产生「删一条、建两条」

由 R2-1/R2-2 组合导致：合成键永远不可能等于 `desired` 里的 `reminderKey`（后者是 `sha256(kind|entityId|occurrence|offset)`），所以：

- `existingKeys`（合成键）与 `desired`（业务键）**交集恒为空**；
- 于是每次 reconcile 都会把宿主里全部提醒判为「多余」→ 全删，再全建。

这使「宿主不回 key」这一现实场景下的 reconcile **从"幂等对齐"退化为"全量重建"**，每次重启都伴随一次删+建窗口（期间提醒处于删除状态，若正好到点则**漏投**）。

## R2-0（记录我的误判，不是代码问题）：一度把「跑错路径」误判成「交付物是残的」

冻结后我在副本**根目录**执行 `node demo/demo.mjs` → `MODULE_NOT_FOUND`，据此得出
「demo.mjs 没进 git、我报的 demo EXIT 0 是假的」。**该结论错误。**

核实过程：
- `git ls-files workbench-core/demo/` → `workbench-core/demo/demo.mjs`（**已跟踪**）
- `git ls-tree -r --name-only 72e09ef | grep -c demo/` → **12 个条目**
- 正确路径为 `workbench-core/demo/demo.mjs`；在 `workbench-core/` 内或仓库根跑 `workbench-core/demo/demo.mjs` 均 **EXIT 0**

真实原因：我在 `cd workbench-core` 之后又回到根目录，按旧相对路径执行。
**这是一次未验证归因**（违反「事实驱动」红线），记录在此以免只留下结论、不留下误判。
被影响的范围：仅我自己的中间判断，未进入任何交付文档的正式结论。

## R2-4（MINOR）：`title` 不参与归一化

`title` 直接进哈希：前后空格、大小写差异（`'站会'` vs `'站会 '`）都会分出不同键，加剧 R2-2 的问题。

## 建议修法（供修复轮采用）

1. **合成键必须唯一且稳定**：
   - 优先方案：宿主 `list()` 必须能读到 `id`，用 `host-id:<id>` 作为键 —— **天然唯一、天然稳定**，且不依赖 title/at。
   - 这个键只作为「宿主侧识别」，**不参与业务对账**；业务对账仍用 `reminderKey`，通过宿主条目的 `key` 字段（若宿主支持）或本地持久映射关联。
2. **持久化 `reminderKey → hostId`**：进程重启后内存映射丢失，必须从磁盘恢复（与 `store.js` 同一套原子写），否则 B1 只能靠 title+at 猜。
3. **时间一律 `Date.parse` 归一后再进哈希**（若仍需 at 参与）。
4. **`reconcile` 在「宿主不回报 key」时必须降级为安全模式**：只 create 不 remove（宁可有重复也不删用户提醒），并返回 `degraded: true` 让调用方告警。
5. 补测试：同标题同时刻两条、ISO 格式差异、宿主不回 key 的 reconcile、cancel 后孤儿检测。

## 对报告口径的影响

`docs/wp2/01-WP2-report.md` 与 `02-review-response.md` 需要补一条**明确的 UNVERIFIED/已知限制**：

> 宿主若不在 `list()` 回报 `key`，当前实现无法保证跨重启去重（合成键不唯一、不稳定）。
> 本机 `ctx.schedule` 的 `schedule_list` 只回报 `{id, kind, title, prompt, afterSeconds, scheduledAt, state, deliveryMode}` —— **没有业务 key**，因此该路径**在生产语义下未验证**。

## 本轮已验证无问题的项（独立跑，非引用实施方结论）

| 用户点名项 | 结论 | 证据 |
| --- | --- | --- |
| 基线 142 测试 | ✅ 142/142 | 冻结副本内 `node --test test/*.test.mjs` |
| demo | ✅ EXIT 0 | 正确路径 `workbench-core/demo/demo.mjs` |
| 三场景 | ✅ 9/9 | `scripts/wp2-scenarios.mjs` |
| B1 跨重启 | ✅ 不重复 | `scripts/wp2-check-b1.mjs` |
| B2 防重发 | ✅ 未重投 | `scripts/wp2-check-b2.mjs` |
| 项 3 跨 scope 隔离 | ✅ 生效；不给 scope 仍为全量语义（向后兼容） | `/tmp/wp2lead/named-items.mjs` |
| 项 4 审批安全 | ✅ `approvalGate` 已不暴露；4 类伪造全拒；合法 token 可用；重放被拒 | 同上 |
| 项 6 exactly-once 断言 | ✅ 文档中**0 处**未限定断言 | `grep -rn "exactly-once\|恰好一次\|保证只投一次" docs/wp2/` 为空 |
| 项 7 模拟 vs 实机 | ✅ 已区分（报告 R4 行明写「非真实系统睡眠，需 WP7 实机验收」） | `docs/wp2/01-WP2-report.md:186` |

## 真实宿主证据（本轮新增观察到的事实）

本机 `schedule_list` 实际返回字段（此前探测已记录）：
`{id, kind, title, prompt, afterSeconds, scheduledAt, state, deliveryMode}`

- **有 `id`** → 可用 `host-id:<id>` 做稳定唯一键；
- **无业务 key** → 无法把宿主条目直接映射回 `reminderKey`。

这直接决定了修法 1 必须走「持久化映射」而不是「靠宿主回报 key」。

---

# 复审 Agent 追加发现（比我的结论更重）

> 以下为第二轮独立 Review Agent 报回、**经我用 @deepseek-ai/dsh-schedule/lib/index.js 一手源码逐条核实**的结论。
> 我此前的 R2-1..R2-4 只覆盖合成键，**漏掉了根子上的一层**。

## R2-5（BLOCKER）：适配器契约与真实 `ctx.schedule` 完全不匹配 —— B1/B2 是「对着假宿主修好的」

**一手证据**（`@deepseek-ai/dsh-schedule@0.2.1-rc.5`，`lib/index.js`）：

| 方法 | 真实契约（源码行号） | 我的适配器 | 后果 |
| --- | --- | --- | --- |
| `create` | `async create(sessionId, request, signal)`（L2083）；selector 是 `request.at / after_seconds / every_seconds / daily / weekly / cron`（L2084-2095），`at` 需为 canonical RFC3339 字符串 | `hostSchedule.create({ title, prompt, at: number, key })` —— **单参**、`at` 是数字 | 真实宿主下 **必然抛错**，一条提醒都建不成 |
| `list` | `async list(request)`，需 `request.sessionId`（L2120）；返回 `record` 数组，**无 `key` 字段** | `hostSchedule.list()` —— **无参** | 抛错 → 被 `schedule-adapter.js:234` 的 `catch` **静默吞掉** → 退回内存视图 → 跨重启去重失效（实测 5 次重启 1→2→3→4→5） |
| `history` | `async history(request)`，需 `{sessionId, id, limit∈[1,100]}`（L2144-2145），**单任务分页** | `hostSchedule.history()` —— **无参** | 抛错 → 但 `hist.length >= 0` **恒真** → `historyAvailable` 仍报 `true` → B2 防重发失效 |
| `delete` | `async delete(request, signal)`，需 `{id, sessionId}`（L2164） | `hostSchedule.remove(id)` —— 单值 | 形状不符 |
| `catalog` | `async catalog()` 无参，返回**全部** active+inactive 并带 `sessionId/status/lastDelivery`（L2129） | 未使用 | — |

**根因**：我自建了一个「看起来合理」的宿主接口，用**假宿主**验证通过了 B1/B2，**从未核对真实契约**。
这不是实现 bug，是**验证对象错了**——145 个测试里没有一个跑在真实契约上。

**修法方向**：
1. 适配器必须按真实契约收敛：`create(sessionId, request, {at: RFC3339字符串, title, prompt})`、`list({sessionId})`、`history({sessionId, id, limit})`、`delete({id, sessionId})`；
2. **禁止静默 catch**：`list()` 抛错必须上抛或返回显式 `degraded` 状态，不得伪装成「宿主为空」；
3. `historyAvailable` 判定改为「调用成功且形状合法」，不能用 `length >= 0`；
4. 用 **`catalog()`** 做跨会话对账（它无参且返回全部任务，含 `status`），比 `list` 更适合 reconcile 的全量视图；
5. 真实契约测试：用**从 asar 复制的真实签名 stub**（或直接 contract test）验证调用形状，而不是自造接口。

## R2-6（BLOCKER）：审批旁路仍在 —— `events` / `store` 直接暴露

`service.js` 返回对象含 `store` 与 `events`，实测：

```
svc.events.remove(id)   → function，可直接删（绕过审批）
svc.store.replace()     → function，可直接替换（绕过审批）
```

N1 我只摘掉了 `approvalGate`，**另一扇门还开着**。真实语义下「任何影响用户数据的操作必须经宿主审批」被完全绕过。

**修法**：返回对象只暴露 `execute` / `requestApproval` / 查询类只读方法；`store` / `events` 收进闭包，或只暴露**不含写操作**的只读视图。

## R2-7（MAJOR）：恢复层未修 scope —— 只恢复 events 会删掉 tasks

`reminder-recovery.js:109` → `adapter.reconcile(future)` **不带 scope**。M3 我只修了 `reconcile` 本身，恢复入口照旧全量清理。实测 `removed=['tasks:t1']`。

## R2-8（MINOR）：变异测试显示测试真空

复审 Agent 做了 11 项回退实验，其中 **4 项回退后测试仍全绿**。说明部分测试对关键行为**没有约束力**。需在修复轮补强（尤其契约形状、静默 catch、审批旁路三类）。

---

# 主会话复核结果（对复审 Agent 结论的逐条裁决）

复审 Agent 报回的每一条我都自己复跑，**不整盘照抄**。结论分三类：

## A. 复核确认成立（采信）

| 编号 | 结论 | 我的复核证据 |
| --- | --- | --- |
| R2-5 / B1' | ✅ **成立，blocker** | 一手源码：`create(sessionId, request, signal)` L2083、`at` 需 RFC3339 字符串、`list({sessionId})` L2120、`history({sessionId,id,limit})` L2144、`delete({id,sessionId})` L2164；适配器全部形状不符 |
| R2-6 / N1' | ✅ **成立，blocker** | `typeof svc.events.remove === 'function'`、`typeof svc.store.replace === 'function'`（实测均存在） |
| R2-7 | ✅ 成立，major | `reminder-recovery.js:109` → `reconcile(future)` 不带 scope |
| R2-9 / M1' | ✅ 成立，major | 我的复跑：`planForEvents` → `skipped=1`；`rebuildPlans` → `skipped=undefined`（spread 丢失） |
| R2-10 / m2 | ✅ 成立 | `[].length >= 0` 恒为 `true` → `historyAvailable` 永真 |
| R2-11 | ✅ 成立 | `reminderKey` 是裸 sha256（`9e053361…`），**不以任何 scope 前缀开头** → `startsWith('<scope>:')` 永不匹配 → 给 scope 时 `existingKeys` 恒空，scope 隔离实际失效 |
| R2-12 / m1 | ✅ 成立，minor | `wp2-check-b1/b2.mjs` 只打印不设退出码，回退后仍 EXIT 0，不能做 CI 门禁 |
| R2-13 / m3 | ✅ 成立，minor | `plans.skipped` 用 `defineProperty` 非枚举 → spread/JSON/`deepEqual` 三处静默丢失；**可观测性本身不可观测** |
| R2-14 | ✅ 成立，minor | 测试真空：4 项变异（合成键改随机、宿主不回 key 时用 id、service 重暴露 gate、指纹退回 `join(',')`）回退后**测试仍全绿** |

## B. 我复核后**推翻/修正**的结论（不采信）

| 复审主张 | 我的复核 | 判定 |
| --- | --- | --- |
| N3'：`bulkDelete` 用 `join(',')` 造 target **可绕过**，实测「删了 2 条」 | 我用等价构造（批准 `target='x,y'`，执行 `ids:[a,b]`）→ **`fingerprint-mismatch` 被拦** | ❌ **不成立**（至少不是通用可利用）。可能 reviewer 的 token 是用同一次 `requestApproval` 的自定义 digest 造的。**但我仍会把 target 生成改为 `JSON.stringify(sortedIds)`**——理由：当前实现让指纹依赖「id 不含逗号」这一巧合，属脆弱设计，虽未被利用也该改 |
| M2'：`compileReminder` 过滤过期使 `missed` **恒为 0**、「错过 N 条」功能不工作、`lookbackDays` 失效 | 生产时钟复跑：休眠 3h 唤醒 → `plans=1 missed=1`，**能识别 missed** | ❌ **不成立**。原因：`rebuildPlans` 用 `now()` 重建时，过期提醒确实被 `compileReminder` 滤掉，但**上一轮已存在、尚未重建的 plans**（或直接传入的陈旧 plans）仍会进入 `recover` 被判定 missed；我这份 spec 的语义是「编译期不补建 + 恢复期识别陈旧项」，两段不矛盾。**但文档需写清这个两段语义**，否则容易被读成「错过永远为 0」 |

**修正说明**：B 类两条我保留自己的结论，但**采纳其「可读性/脆弱性」的批评**——即「设计虽然能跑，但脆弱或容易被误读」，这属于应当加固的地方，不因为「不算 bug」就忽略。

## C. 我无法验证（保持 UNVERIFIED）

| 项 | 原因 |
| --- | --- |
| 真实宿主 `list` 在运行中是否回 `key` | 代码层面（`map(([, task]) => task.record)`，record 无 `key`）可确定**不回**，但无法在运行中实测 |
| 真实宿主投递历史 receipts | 本会话无对应工具；复审 Agent 作为子会话连 `schedule_create` 都返回 `subagent_session` |
| 真实 macOS 休眠/退出/重启 | 未做 |
| 多进程并发写 | 未覆盖 |
| 145 项测试是否覆盖真实契约 | **已确认不覆盖**（这是 R2-5 的直接后果，不是 UNVERIFIED） |

## 本轮最终判定

**REQUEST CHANGES。**

- **Blocker ×2**：R2-5（契约不匹配，host 后端从未真正接通）+ R2-6（审批旁路）
- **Major ×5**：R2-1（合成键重复）、R2-2/R2-3（合成分歧与退化）、R2-7（恢复层 scope）、R2-9（skipped 丢失）
- **Minor/Nit**：R2-4、R2-8、R2-10~R2-14

**最该记住的一条**：我在 WP2-1 / 修复轮里两次宣布「B1/B2 已修」，两次都是**拿自造假宿主验证的**。真实契约就在 `app.asar` 里，我一次都没去读。这是**验证对象选错**，不是实现疏漏。
