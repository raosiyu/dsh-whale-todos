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
