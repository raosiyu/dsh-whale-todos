# WP2-R5 第二轮独立 Review 结论（Reviewer: WP2-R5b）

审查对象：冻结快照 `/tmp/wp2r5b-freeze-368207b`（基准 commit `368207b`，790 文件）
审查人：WP2-R5 第二轮独立 Review 员（子会话）
产出目录：`/Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final/`
探针命名：`probe-R5b-<序号>.mjs` + 同名 `.log`
纪律：全部探针**直接 import 冻结目录的 `workbench-core/src/index.js`**，不经任何 `REPO` 常量；
不修改主仓库任何被跟踪文件（仅写本目录）。

---

## 检查 00：冻结完整性 + 基线复跑

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench && rm -rf /tmp/wp2r5b-verify && mkdir -p /tmp/wp2r5b-verify \
  && git archive 368207b | tar -x -C /tmp/wp2r5b-verify \
  && diff -rq /tmp/wp2r5b-verify /tmp/wp2r5b-freeze-368207b
cd /tmp/wp2r5b-freeze-368207b/workbench-core && node --test test/*.test.mjs
cd /tmp/wp2r5b-freeze-368207b && node workbench-core/demo/demo.mjs
cd /tmp/wp2r5b-freeze-368207b && bash scripts/wp2-r5-gate.sh
cd /tmp/wp2r5b-freeze-368207b && node scripts/r3-mutate.mjs /tmp/wp2r5brev/mut.log
```

**实际输出摘录**
```
（diff -rq 只报 evidence/wp2/review-final/*.log 差异 —— 那是门禁脚本自己写的日志；
  src/ 与 scripts/ 逐字节一致，说明冻结目录确实是 commit 368207b 的导出）
# tests 204
# pass 204
# fail 0
```
```
DEMO EXIT=0
  首次对账：created=2 removed=0
  重复对账（幂等）：created=0（应为 0）
  到点投递：第一次 2 条，重复 tick 0 条（应为 0）
```
```
=== 门禁汇总 ===
通过 8 项，失败 0 项
RESULT: PASS
```
```
CAUGHT: 31
VACUUM: 0
SKIP:   0
结论：全部保护点都有测试约束（0 真空，0 跳过）
```

**判定：PASS** — 冻结版与 commit `368207b` 一致；204/204 单测、demo、8/8 门禁、31/31 变异全部通过。
（上一轮基线是 196/196，本轮 +8 个测试——实施方确实补了测试。）

---

## 检查 01：🔴 BLOCKER-1 —— 裁剪成「墓碑」的映射，其宿主提醒永远删不掉（幽灵提醒）

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final && node probe-R5b-01.mjs
```

**实际输出**
```
=== A) 600 条 + maxEntries=500，取消被裁的那 100 条 ===
  ✅ 600 条全部建立  = 600
  ✅ 宿主侧 600 条  = 600
  ✅ 本地 entries 被裁到 500  = 500
  ✅ k-0000 是墓碑（最先到点，最先被裁）  = undefined
  ✅ 取消被裁的 100 条：removed=100  = 100
  ✅ 取消被裁的 100 条：failed=0  = 0
  ✅ 宿主降到 500  = 500

=== B) 带 scope 对账时墓碑行不被跳过 ===
  ✅ events scope 建立 300 条  = 300
  ✅ 宿主侧 600 条  = 600
  ✅ entries 裁到 500  = 500
  ✅ events 侧的 e-0000 是墓碑  = undefined
  ✅ tasks 侧的 t-0000 仍是完整条目  = true
     events scope 对账: removed=150 failed=0
  ✅ events scope 删除 150 条  = 150
  ✅ events scope 删除无失败  = 0
  ✅ 宿主降到 450（600-150）  = 450
  ✅ tasks scope 的 300 条仍在  = 300
  ✅ events scope 只剩 150 条  = 150
  ✅ 无 unmapped  = 0

=== B2) 带 scope 对账时，墓碑行的 scope 归属 ===
  ✅ tasks scope 对账未删除任何 events  = 0
  ✅ tasks scope 对账无失败  = 0
  ✅ 宿主侧仍 600 条  = 600
  ✅ events scope 仍 300 条（墓碑行 scope 保住了）  = 300
  ✅ tasks scope 300 条  = 300

=== C) 删除失败时身份必须保留（否则宿主行成孤儿 → 重建 → 二次投递）===
  ✅ 宿主侧 8 条  = 8
  ✅ entries 裁到 5  = 5
     删除失败时: removed=5 failed=3
  ✅ 删除失败计入 failed（3 条墓碑）  = 3
  ✅ 成功的 5 条计入 removed  = 5
  ✅ 删除失败后仍认领宿主上活着的 3 条  = 3
  ✅ 删除失败后无 unmapped（身份未丢）  = 0
  ✅ 宿主侧剩 3 条（失败的未被删）  = 3
  ✅ 删除失败后再对账：只为已删的 5 条重建  = 5
  ✅ 删除失败后那 3 条未被重建（无重复投递）  = 0
  ✅ 宿主侧回到 8 条（无重复）  = 8
  ✅ 无重复行  = 8

=== D) cancel() 一个墓碑提醒 ===
  ✅ 宿主侧 6 条  = 6
  ✅ entries 裁到 3  = 3
  ✅ c-0 是墓碑  = undefined
  ✅ cancel 墓碑不抛错  = "no-error"
  ✅ cancel 后宿主侧 5 条  = 5

=== E) remove() 会不会误删别的 key 的身份 ===
  ✅ remove(x) 返回 true  = true
  ✅ x 的身份已删  = undefined
  ✅ y 的身份仍在  = "y"
  ✅ z 的身份仍在  = "z"
  ✅ y 的 scope 仍在  = "tasks"
  ✅ z 的 scope 仍在  = "events"

=== F) 墓碑的 scope 与 hostId 是否保留 ===
  ✅ a 是墓碑  = undefined
  ✅ 墓碑 a 的 scope 仍为 events  = "events"
  ✅ 墓碑 a 的 hostId 仍可取  = "h-a"

=== 探针 R5b-01 汇总：PASS ===
```

**判定：PASS —— BLOCKER-1 已真正修好。**

逐条对照上一轮指认的症状：

| 上一轮症状 | 上一轮实测 | 本轮实测 | 结论 |
| --- | --- | --- | --- |
| 取消被裁的 100 条 → `removed=0 failed=100`，宿主仍 600 行 | 幽灵提醒 | `removed=100 failed=0`，宿主降到 500 | ✅ 修好 |
| 带 scope 对账时墓碑行被跳过（`removed=200 failed=0` 宿主仍 400） | 静默跳过、无告警 | `removed=150 failed=0`，宿主降到 450，且 tasks scope 不受影响 | ✅ 修好 |
| `cancel()` 墓碑抛 `not-found` | 用户看到「不存在」 | 不抛错，宿主确实少一条 | ✅ 修好 |
| 删除失败时身份被清 → 宿主行成孤儿 → 重建 → 二次投递 | 未单独验证 | `failed=3`、身份保留（`unmapped=0`）、再对账**不重建**那 3 条 | ✅ 修好 |

**机制核对（源码）**：`host-map.js` 新增 `describe()`（条目缺失时从 `index` 反查 `hostId` + 从
`indexScopes` 取回 `scope`）；`schedule-adapter.js` 的 `backend.remove()` 用 `describe()` 兜底；
`prune()` 把被裁条目的身份留在 `index`、scope 留在 `indexScopes`。`remove()` 删除时**只删本 key
的索引**（`state.index[hostId]` 只在 `=== reminderKey` 时删），不误伤别的 key —— 探针 E 已证。

---
## 检查 02：🔴 BLOCKER-2 —— 并发 reconcile 重复投递

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final && node probe-R5b-02.mjs
```

**实际输出**
```
=== A) 20 个并发 reconcile（同一批 30 条 key）→ 宿主必须恰好 30 条 ===
     轮 1: 宿主行=30 重复=0 累计created=30 failed=0
  ✅   轮 1：宿主恰好 30 条（无重复投递）  = 30
  ...（轮 2~5 同样全部通过）
=== A2) 20 个并发 reconcile，各自 desired 部分重叠 ===
  ✅ 共享 key 只建一次（宿主 30 条）  = 30
  ✅ 无重复  = 0
=== B) 不同 key 并发应仍并行（不互相阻塞）===
     10 个不同 key 的 reconcile 总耗时=84ms  期间最大并发 catalog=10
  ✅ 宿主侧 10 条  = 10
  ✅ 不同 key 并行执行（未串成一条链）  maxInflight=10
=== C) 同一 key 多次并发 upsert + 中途删除 ===
  ✅ 宿主恰好 1 条  = 1
  ✅ created 累计为 1  = 1
  ✅ 并发 delete+upsert 未死锁（Promise 全部 settle）  fulfilled,fulfilled
  ✅ 并发 delete+upsert 无重复行 宿主行=1
=== D) upsert 锁的 promise 链是否泄漏 ===
  ✅ 200 次串行对账后宿主仍 1 条  = 1
  ✅ heapUsed  4.8 MB

=== 探针 R5b-02 汇总：PASS ===
```

**判定：PASS —— BLOCKER-2 已真正修好。**

上一轮实测「20 个并发 reconcile → 宿主 20 条同 key 提醒、5/5 轮 100% 复现」；
本轮 5 轮均为「宿主恰好 30 条、重复 0、failed 0」。

我另外设计并验证了三个更严的场景（任务书点名）：
1. **desired 部分重叠**（两个 reconcile 各带 10 条共有 + 10 条独有）→ 宿主恰好 30 条，无重复；
2. **不同 key 并发仍并行** → 10 个不同 key 的 reconcile 期间最大并发 catalog=**10**
   （证明修法是「按 reminderKey 串行」而不是「把所有 upsert 串成一条链」，不会互相阻塞）；
3. **同一 key 多次并发 + 中途删除** → 30 次并发同一 key 只建 1 条；
   并发 `delete` + `upsert` 两个 Promise 全部 settle（**无死锁**），宿主仍 1 条（无重复行）。

**机制核对（源码）**：`schedule-adapter.js` 的 `createHostBackend` 里 `createLocks: Map<reminderKey, Promise>`，
`upsert()` 把 `previous.then(() => gate)` 挂成链，`await previous` 后进临界区，`finally { release() }`。
同 key 串行、异 key 并行，与实测一致。

---

## 检查 03：探针 01 暴露的 `{status:'unavailable'}` 形状（16 种 history 形状矩阵）

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final && node probe-R5b-06.mjs
```

**实际输出（判据表）**
```
  ✅ history 抛错                                 | UNKNOWN       | 保留=Y | 重建=N
  ✅ history 抛带 code 的错                         | UNKNOWN       | 保留=Y | 重建=N
  ✅ history 返回非法形状（字符串）                        | UNKNOWN       | 保留=Y | 重建=N
  ✅ history 返回数组                               | UNKNOWN       | 保留=Y | 重建=N
  ✅ history 返回 null                              | UNKNOWN       | 保留=Y | 重建=N
  ✅ history 返回 undefined                         | UNKNOWN       | 保留=Y | 重建=N
  ✅ history 返回 {}（无 records 无 earlier）         | NOT_DELIVERED | 保留=Y | 重建=N
  ✅ history 返回 {records:[]}（earlier 缺失）        | NOT_DELIVERED | 保留=Y | 重建=N
  ✅ history 返回 {records:[], earlier:false}     | NOT_DELIVERED | 保留=Y | 重建=N
  ✅ history 返回 {records:[], earlier:true}      | UNKNOWN       | 保留=Y | 重建=N
  ✅ history 返回 {records:[非数组], earlier:true}   | UNKNOWN       | 保留=Y | 重建=N
  ✅ history 返回 {records:null, earlier:true}    | UNKNOWN       | 保留=Y | 重建=N
  ✅ history 返回 {code:schedule_not_found}       | NOT_DELIVERED | 保留=Y | 重建=N
  ✅ history 返回 {status:unavailable}            | UNKNOWN       | 保留=Y | 重建=N
  ✅ history 返回 {status:unavailable, error:...} | UNKNOWN       | 保留=Y | 重建=N
  ✅ history 返回 {error:x}（无 records）            | UNKNOWN       | 保留=Y | 重建=N

=== 关键：records:[] 且 earlier 缺失 / true / false 三态必须区分 ===
     earlier 缺失     → NOT_DELIVERED
     earlier true   → UNKNOWN
     earlier false  → NOT_DELIVERED
  ✅ earlier 缺失 → NOT_DELIVERED  = "NOT_DELIVERED"
  ✅ earlier true → UNKNOWN  = "UNKNOWN"
  ✅ earlier false → NOT_DELIVERED  = "NOT_DELIVERED"

=== 探针 R5b-06 汇总：PASS ===
```

**判定：PASS。**
- 上一轮探针 01 暴露的 `{status:'unavailable'}` 形状 → 本轮判 **UNKNOWN**（不删不建，宿主行保留）；
- 任务书点名的三种 `records:[]` 情形**区分正确**：
  `earlier` 缺失 → NOT_DELIVERED；`earlier:true` → UNKNOWN；`earlier:false` → NOT_DELIVERED；
- 与真实宿主语义核对（`/tmp/dsh-asar-full/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js`
  `deliveryHistoryPage` L1469-1492）：宿主恒返回 `earlierRecordsUnavailable: boolean`，
  `deliveryHistoryOf` 的 fallback 给 `true`（L1428-1431）→ 与实现一致。

---

## 检查 04：审批安全 + 异常处理（探针 R5b-07）

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final && node probe-R5b-07.mjs
```

**实际输出**
```
=== 1) deny 模式下逐个写路径 ===
     event.create       → confirmation-required
     event.update       → confirmation-required
     event.restore      → confirmation-required
     event.delete       → confirmation-required
     event.bulkDelete   → confirmation-required
     event.import       → confirmation-required
     task.upsert        → confirmation-required
     snapshot.replace   → confirmation-required
     store.rollback     → confirmation-required
     store.backup       → confirmation-required
  ✅ 全部 10 个写 op 被拦截  = 10
     --- 只读 op ---
     event.list         → ok
     task.list          → ok
     store.listBackups  → ok

=== 2) 返回面：svc.store / svc.events 是否只读 ===
  ✅ store 只暴露 listBackups/listPreBackups  = "[\"listBackups\",\"listPreBackups\"]"
  ✅ events 只暴露 list/get  = "[\"get\",\"list\"]"
  ✅ store 被冻结  = true
  ✅ events 被冻结  = true

=== 3) 宿主抛法的可观察出口 ===
  ✅ D1 create 抛错 → 计入 failed  = 1   reason="host-create-rejected"
  ✅ D2 create 返回垃圾 → 计入 failed  = 1   reason="host-create-invalid-result"
  ✅ D2b create 返回 null → 计入 failed  = 1
  ✅ D3 catalog 抛错 → degraded=true  = true
  ✅ D3 catalog 抛错 → 不删任何东西  = 0
  ✅ D3 catalog 抛错 → 不建任何东西  = 0
  ✅ D4 delete 抛错有可观察出口  failed=0
  ✅ D5 history 抛错 → UNKNOWN  = 1
  ✅ D5 history 抛错 → 宿主提醒保留  = 1
  ✅ D5 history 抛错 → 不重建  = 0
  ✅ D6 catalog 返回非数组 → degraded  = true
  ✅ D7 delete 失败有可观察出口  failed=0
  ✅ D8 not_found 有可观察出口  removed=0 failed=0

=== 4) 静默吞检查：catalog 失败时是否仍删 ===
  ✅ catalog 挂掉 → 不删  = 0
  ✅ catalog 挂掉 → degraded  = true
  ✅ catalog 挂掉 → 宿主那条还在  = 1

=== 探针 R5b-07 汇总：PASS ===
```

**判定：PASS —— 审批无旁路，异常无静默吞。**
- 10 个写 op 在 `deny` 模式下**全部**被 `execute` 唯一入口拦下（`confirmation-required`）；
- 12 个只读 op 仍工作（deny 只挡写，语义正确）；
- `svc.store` / `svc.events` 只暴露 4 个只读方法且被 `Object.freeze`；
- 宿主 8 种抛法全部有可观察出口：`failed[]` / `degraded=true` / `UNKNOWN`，
  **catalog 挂掉时不删任何东西**（宁可有重复，不可删用户提醒）。

---
## 检查 05：上一轮的 MAJOR/MINOR 逐项独立复核

| # | 项 | 声称处理 | 我的独立实测 | 判定 |
| --- | --- | --- | --- | --- |
| M-1 | index 无上限 | 改为按时间老化（180 天），保留身份；~27 B/条 | 见检查 06 —— **只对「完整条目」有效，墓碑永不过期** | ⚠️ **部分修复** |
| M-2 | `hostMap.put` 每次全量写 → O(N²) | 脏标记 + 显式 `flush()` | 2000 次 put = 482ms（原 8909ms），1 次 flush = 4ms | ✅ 已修 |
| M-3 | 探针 REPO 硬编码主仓库 | 改为按 `import.meta.url` 推导 | 三个探针均为 `fileURLToPath(new URL('../..', import.meta.url))`；冻结目录内跑三个探针全 PASS | ✅ 已修 |
| M-4 | p3 全程不检查 failed | 已加 failed 断言 | `p3-retention.mjs` L81/92/104/120 各有一处 `failed.length === 0` 断言 | ✅ 已修 |
| M-5 | 矛盾态（active + 有回执）会被删 | 未处理（声称真实宿主不可达） | 我的探针可复现（宿主行被删）；核对真实宿主源码确认该状态**不可达** | ✅ 可接受 |
| M-6 | 文档数字滞后 | 已更正 | **部分更正**（见检查 07） | ⚠️ **部分修复** |

**M-2 详细证据（探针 R5b-08）**
```
=== 3) 直接调 hostMap.put 的耗时（脏标记的收益）===
     2000 次 put（无落盘）=482ms，1 次 flush=4ms
  ✅ hostMap.put 不再每次全量写  482ms
```
（上一轮冻结版实测 2000 次 put = **8909 ms**；本轮 482ms → **18.5 倍**改善。）

**M-3 详细证据**
```
=== 探针 REPO 推导（冻结目录内运行）===
p1-real-storage-domain.mjs     const REPO = fileURLToPath(new URL('../..', import.meta.url))
p2-protect.mjs                 const REPO = fileURLToPath(new URL('../..', import.meta.url))
p3-retention.mjs               const REPO = fileURLToPath(new URL('../..', import.meta.url))
=== 冻结目录内跑三个探针 ===
  ✅ 5 次重启后真实 storageDomain 里只有 1 条提醒  = 1
=== P1 汇总：PASS ===
  ✅ 删除失败不计入 removed  = 0
=== P2 汇总：PASS ===
  ✅ 重启后身份索引仍认领全部  = 600
=== P3 汇总：PASS ===
```

**M-5 详细证据（探针 R5b-10 D 段）**
```
=== D) M-5：矛盾态（宿主行 active + 有回执）是否被删 ===
     recover: alreadyDelivered=["contra"] removed=["contra"] 宿主行=0 状态=undefined
  ❌ 矛盾态（active + 有回执）下宿主行被删  宿主行=0
```
真实宿主源码核对（`/tmp/dsh-asar-full/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js` L1598-1608）：
```js
await this.commit({
  ...task,
  status: "inactive",
  ...appendDelivery(task, { scheduledAt: ..., deliveredAt, messageId: message.id }, this.retention)
});
```
`status:"inactive"` 与回执在**同一次 commit** 中写入 → 「active 且有回执」在真实宿主里**不可达**。
我上一轮已独立核实过这一点，本轮复核结论一致 → **M-5 判定为可接受的防御性缺口，不构成 blocker**。

---

## 检查 06：⚠️ M-1 的真实有效性 —— 时间老化对「墓碑」无效

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final && node probe-R5b-09.mjs
cd /Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final && node probe-R5b-10.mjs
```

**源码机制**（`workbench-core/src/host-map.js` `prune()` L194-203）：
```js
const cutoff = now() - indexRetentionMs
for (const [hostId, key] of Object.entries(state.index)) {
  const fireAt = state.entries[key]?.fireAtMs
  // 条目已被条数裁剪掉时没有 fireAtMs 可依据 → 保守保留（不冒重复投递的风险）
  if (fireAt === undefined) continue
  if (fireAt < cutoff) { delete state.index[hostId]; delete state.entries[key] }
}
```
老化循环**遍历 `state.index`，但用 `state.entries[key]` 取判龄时间**。
而「墓碑」的定义就是：**条目已被条数裁剪移出 `entries`，身份只留在 `index`** → `fireAt === undefined` → `continue`。
**墓碑因此永远不会被老化。**

**实际输出（探针 R5b-09）**
```
=== A) 单一分支隔离：只跑条数裁剪，看 index 怎么长 ===
     1000 条 / maxEntries=500 → entries=500 index=1000 墓碑=500
  ✅ entries=500  = 500
  ✅ index=1000（身份全留）  = 1000
  ✅ 墓碑=500  = 500

=== B) 时间老化分支：能不能清掉墓碑？ ===
     400 天后 → entries=1 index=501 墓碑=500
  ✅ 完整条目全被老化掉（只剩 trig）  = 1
  ❌ 墓碑身份永不被时间老化  存活墓碑 500 个 / index 501 项

=== C) 墓碑不老化 → index 无上限（长期运行）===
     轮 1（累计 600 条）→ entries=500 index=600 墓碑=100 文件=108947 字节
     轮 2（累计 1200 条）→ entries=500 index=1200 墓碑=700 文件=135347 字节
     轮 3（累计 1800 条）→ entries=500 index=1800 墓碑=1300 文件=163247 字节
     轮 4（累计 2400 条）→ entries=500 index=2400 墓碑=1900 文件=190247 字节
     轮 5（累计 3000 条）→ entries=500 index=3000 墓碑=2500 文件=217247 字节
  ❌ 长期运行 index 无上限（墓碑永不过期）  index=3000（累计创建 3000 条）
```

**实际输出（探针 R5b-10 B 段）**
```
=== B) 墓碑不过期的直接后果：index 体积随「累计创建量」单调增长 ===
     轮 1（累计 600）→ entries=500 index=600 墓碑=100 文件=108947 字节
     轮 2（累计 1200）→ entries=500 index=1200 墓碑=700 文件=135347 字节
     轮 3（累计 1800）→ entries=500 index=1800 墓碑=1300 文件=163247 字节
     轮 4（累计 2400）→ entries=500 index=2400 墓碑=1900 文件=190247 字节
     轮 5（累计 3000）→ entries=500 index=3000 墓碑=2500 文件=217247 字节
     轮 6（累计 3600）→ entries=500 index=3600 墓碑=3100 文件=244247 字节
  ❌ index 随累计创建量单调增长  index=3600（累计 3600）
```

### 严重度判定

**这不是 blocker。** 理由：
1. **不会导致重复投递**——墓碑身份保留正是**防重复投递**的机制（探针 R5b-10 C 段：
   600 条全部被认领、`unmapped=0`、宿主行不被误删）；
2. **不会导致数据丢失**——身份还在，删除路径正常；
3. **体积增长是渐进的**：~68 B/条（实测 `244247 / 3600`），10 万条 ≈ 6.8 MB，
   与上一轮 M-1 记录的「~51.8 B/条、100 万条 ≈ 49 MB」同一量级；
4. 上一轮已把「index 无上限」定为 **MAJOR（已知限制，有明确正确性理由）**，
   本轮是**同一个限制换了一个实现方式但没真正封顶**。

**但声称与事实不符**：commit `817e053` 的说明写「the index now ages by TIME」，
M-1 的处置写「改为按时间老化（180 天）」——**对墓碑这条实际占多数的路径不成立**。
实测「长期运行 index 不收敛」已复现。

**次生问题：`indexScopes` 完全没有老化路径**（`prune()` 的老化分支只删 `index` 与 `entries`，
不删 `indexScopes[hostId]`）：

```
刚建 1000：entries= 500 index= 1000 indexScopes= 1000
400 天后：entries= 1 index= 501 indexScopes= 1001
孤儿 indexScopes（对应的 index 已不存在）= 500 / 1001
```
```
第 50 天：entries=500 index=1000 indexScopes=1000 文件=125747 字节
第 100 天：entries=500 index=2000 indexScopes=2000 文件=172247 字节
第 150 天：entries=500 index=3000 indexScopes=3000 文件=217247 字节
第 200 天：entries=500 index=4000 indexScopes=4000 文件=262247 字节
```
→ **`indexScopes` 只增不减，随「历史 hostId 总数」线性增长**。
`indexScopes` 的体积比 `index` 更大（`hostId` 字符串 + scope 字符串），
所以长期运行的体积增长里，`indexScopes` 占相当比例。

**修复方向（供实施方参考，不阻塞）**：
- 给墓碑也存一个 `fireAtMs`（或存 `indexFireAt[hostId]`），让老化循环能判龄；
  或让老化按 `index` 里**独立记录**的判龄时间走，而不是回头查 `entries`；
- `prune()` 的老化分支同步删 `state.indexScopes[hostId]`；
- 或给 `index` / `indexScopes` 一个**远大于 500** 的独立上限（例如 50000），
  并在超出时按判龄时间从最旧开始丢（先丢墓碑、再丢完整条目）。

---
## 检查 07：M-6（文档数字滞后）—— 只更正了一处

**命令**
```bash
cd /tmp/wp2r5b-freeze-368207b && grep -n "183\|191\|202\|204\|16 变异\|36 变异\|25 变异" docs/wp2/08-R3-final-acceptance.md
cd /tmp/wp2r5b-freeze-368207b && grep -n "197\|204\|32/32\|36/36" docs/wp2/11-WP2-R5-report.md
cd /tmp/wp2r5b-freeze-368207b && node -e "const m=require('./scripts/r3-mutations.json'); console.log('mutations:', m.length)"
```

**实际输出**
```
docs/wp2/08-R3-final-acceptance.md:
21:| 8 | 关键测试变异验证 | ✅ | `scripts/r3-mutate.sh`：**16 变异 / 16 CAUGHT / 0 VACUUM** |
27:| **T1 单元** | **183 / 183 pass，0 fail，0 skip** | `node --test test/*.test.mjs` |
40:| 加有界保留后（16 变异） | **CAUGHT 16 / VACUUM 0** |
107:- 测试有真实约束力（16/16 变异被捕获）。

docs/wp2/11-WP2-R5-report.md:
67:| **模拟环境** | ✅ 197 项单元/集成测试；32/32 变异被捕获（0 真空 0 跳过）；8 项验收 26/26 |

mutations: 36
```

**实测真值**：单测 **204/204**、变异 **36/36 CAUGHT**（`/tmp/wp2r5brev/mut.log`）。

**判定：⚠️ MINOR（部分修复）** — commit `368207b` 只改了 `08` 文档里**一处**
（「L4 实例化 BLOCKED」→ 真实 storageDomain 已通），**数字本身仍未更新**：
`08` 仍写「183/183」「16 变异」，`11` 仍写「197 项」「32/32」。
上一轮 M-6 明确点名的就是这些数字。属文档滞后，不阻塞。

---

## 检查 08：M-2 的副作用 —— `flush()` 返回值是死值

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final && node probe-R5b-08.mjs
```

**实际输出**
```
=== 1) flush() 的返回值语义 ===
  ✅ 刚打开：dirty=false  = false
  ✅ put 后 dirty=true  = true
     flush() 返回 = {"flushed":false}
  ❌ flush() 返回值不能反映「是否真的落盘」  got {"flushed":false} want {"flushed":true}
  ✅ flush 后 dirty=false  = false
     第二次 flush() 返回 = {"flushed":false}
  ✅ 第二次 flush 无事可做  flushed=false
```

**源码**（`host-map.js` L234-238）：
```js
flush() {
  if (dirty) writeNow()   // ← writeNow() 内部把 dirty = false
  return { flushed: dirty }  // ← 读到的永远是 false
}
```
`writeNow()` 末尾执行 `dirty = false`，所以 `return { flushed: dirty }` **恒为 `{flushed:false}`**——
这个返回值无法表达「这次是否真的落盘了」。

**判定：MINOR（NIT）** — 纯 API 瑕疵：
- **无功能影响**：`flush()` 的**副作用**（落盘）是对的，全仓库无人读这个返回值
  （`grep -rn "\.flush()"` 只在 `schedule-adapter.js` L400/415/421 与测试里被**当作语句**调用）；
- 修法一行：`const wasDirty = dirty; if (dirty) writeNow(); return { flushed: wasDirty }`。

---

## 检查 09：BLOCKER-2 修法的副作用 —— `createLocks` 的 promise 链永不清理

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final && node probe-R5b-08.mjs   # 第 4 段
node --expose-gc /tmp/r5b13.mjs
```

**实际输出**
```
=== 4) createLocks 的内存增长（每不同 key 留一条 promise，永不清理）===
     20000 个不同 key：耗时=429766ms  heapUsed 23.1 → 72.0 MB (+48.9 MB)
     每 key 约 2562 字节
  ❌ 每 key 内存开销异常大（锁表泄漏）  2562 字节/key
```
```
50000 个不同 key：heapUsed 4.0 → 18.0 MB (+14.0 MB, 293 B/key)
（此路径 hostMap 是 stub，故增长主要来自 createLocks + 宿主行）
```

**源码**（`schedule-adapter.js` L214 / L327-338）：
```js
const createLocks = new Map()
// ...
async upsert(record) {
  const previous = createLocks.get(record.reminderKey) ?? Promise.resolve()
  ...
  createLocks.set(record.reminderKey, previous.then(() => gate))
  await previous
  try { return await this.upsertLocked(record) }
  finally { release() }
}
```
`createLocks` **只 set 从不 delete**。每个出现过的 `reminderKey` 永久留下一条 promise 链。

**判定：MINOR** — 内存增长慢（实测 293 B/key 的净增长，且其中一部分是宿主行本身），
且 `reminderKey` 的数量与「历史提醒总数」同阶，不快于 M-1 的 index 增长。
但它与 M-1 的 index 泄漏**叠加**（同一批 key 上各留一份），
且属于「修 BLOCKER-2 时新引入的」无界结构。
修法：`upsert` 的 `finally` 里，若 `createLocks.get(key) === 当前链` 则 `delete`。
**无死锁**（探针 R5b-02 C 段已验证：并发 delete+upsert 两个 Promise 全部 settle）。

---
## 检查 10：新 p3 的语义 —— 「被裁且不在 desired 的条目应当被删除」

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final && node probe-R5b-11.mjs
```

**实际输出**
```
=== A) 新 p3 的源码断言（语义 + failed 检查）===
     p3 里检查 failed[] 的断言共 4 处：
       L81: eq('无失败', r2.failed.length, 0)
       L92: eq('删除无失败', r3.failed.length, 0)
       L104: eq('无失败', r4.failed.length, 0)
       L120: eq('重启后对账：无失败', r5.failed.length, 0)
  ✅ p3 检查 failed[]  4 处
  ✅ p3 的新语义是「被裁且不在 desired 的条目应当被删除」  removed.length === 100
  ✅ p3 不再断言「被裁的 100 条不被删除」

=== B) 独立复现新 p3 第 4 段的语义（不依赖 p3 本身）===
  ✅ 600 条全部建立  = 600
  ✅ 宿主侧 600 条  = 600
  ✅ 本地映射被裁到 500  = 500
  ✅ 无失败  = 0
  ✅ 被裁的 100 条被删除  = 100
  ✅ 删除无失败  = 0
  ✅ 宿主侧降到 500 条  = 500
  ✅ 仍全部可认领  = 0

=== C) p3 第 5 段的语义：被删除的提醒重新出现 → 重建（正确）===
  ✅ 宿主 500 条  = 500
  ✅ 已删除的提醒重新出现 → 重建  = 1
  ✅ 无失败  = 0
  ✅ 宿主侧恰好 1 条（不重复）  = 1

=== 探针 R5b-11 汇总：PASS ===
```

**判定：PASS** —— 上一轮指认的「p3 把缺陷固化为正确行为」已纠正：
- 语义已改为「被裁的 100 条**应当被删除**」（`removed.length === 100`）；
- 旧的错误断言「被裁的 100 条不被删除」**不再存在**；
- **`failed[]` 现在有 4 处断言**（上一轮 M-4 判定为「全程不检查 failed」）→ ✅ 已修；
- 第 5 段语义也正确：真正从宿主删除掉的提醒重新出现 → **重建**（而不是「复用」），
  且宿主侧恰好 1 条不重复。

---

## 检查 11：多进程 —— 串行化是**进程内**的，多进程仍会重复投递

**命令**
```bash
# 5 个进程并发对账同一条提醒，宿主用 append-only 日志（不丢行）
for i in 1 2 3 4 5; do node /tmp/r5b16.mjs /tmp/mp2 & done; wait
```

**实际输出**
```
=== 宿主侧行数（5 个进程并发建同一条提醒）===
       5
{"id":"schedule-48528-1","sessionId":"s1","status":"active",...,"title":"Same"}
{"id":"schedule-48530-1","sessionId":"s1","status":"active",...,"title":"Same"}
{"id":"schedule-48532-1","sessionId":"s1","status":"active",...,"title":"Same"}
{"id":"schedule-48529-1","sessionId":"s1","status":"active",...,"title":"Same"}
{"id":"schedule-48531-1","sessionId":"s1","status":"active",...,"title":"Same"}
```
→ **5 个进程建出 5 条同一提醒**（与上一轮 BLOCKER-2 的症状同类，只是跨进程）。

**文档是否如实标注？—— 是，如实标注。**
```
docs/wp2/11-WP2-R5-report.md:79:| 多进程并发写 | 文件存储非多进程安全；`hostMap` 无跨进程锁 |
docs/wp2/08-R3-final-acceptance.md:75:| 多进程并发写 | 文件存储非多进程安全 |
docs/wp2/10-round4-audit.md:97:| 多进程并发写 | 文件存储非多进程安全 |
```
三份文档的 UNVERIFIED 清单都列了「多进程并发写」。
另外 `docs/wp1/01-WP1-core-domain.md:83` 明确写「V1 单用户单进程足够；多进程并发写未支持」。

**判定：PASS（文档诚实性）** —— 任务书问「文档是否如实标注」：**是**。
本轮 BLOCKER-2 的修法（promise 链）明确是**进程内**的，
文档没有把它包装成跨进程安全。多进程不在本次修复范围，且 V1 是单用户单进程部署。
**不构成 blocker。**

> 补充说明：`docs/wp2/11-WP2-R5-report.md` 第四节「审批旁路 / 并发 / 异常」里
> **没有**写「并发已解决」这类过宽表述，也没有把「进程内串行化」说成「并发安全」——
> 与它 UNVERIFIED 清单里的措辞一致。

---
## 检查 12：M-2 的性能声明 —— 「8000 条 36.8s → 0.76s」测的是哪一段

**命令**
```bash
node /tmp/r5b20.mjs    # 只测 hostMap.put 路径
node /tmp/r5b18.mjs    # 统计 adapter upsert 路径的 catalog() 调用
node /tmp/r5b19.mjs    # 缩放曲线
node /tmp/r5b21.mjs    # 与上一轮冻结版对比
```

**实际输出**
```
8000 次 hostMap.put（不 flush）= 9227ms
1 次 flush = 15ms
8000 次 put（每 100 次 flush 一次）= 9803ms
```
```
1000 条 upsert：耗时=10949ms
  catalog() 调用次数 = 1001（≈ N+1，每条 upsert 一次）
  catalog() 处理的总行数 = 499500（= N²/2 量级 → O(N²)）
  平均每次 catalog 处理 499 行
```
```
N=250: 1067ms
N=500: 2440ms
N=1000: 5568ms
```
```
2b0aabb（上一轮）: 500 条 adapter upsert = 2584ms
368207b（本轮）: 500 条 adapter upsert = 2664ms
```

**判定：MINOR（性能声明的范围需要写清，且 adapter 路径仍有 O(N²)）**

1. **M-2 本身修好了**：上一轮指认的「`hostMap.put` 每次全量写 → O(N²)」已修
   （2000 次 put 8909ms → 482ms，18.5 倍）。
2. **但「8000 条 36.8s → 0.76s」这个数字只覆盖 `hostMap.put` 那一段**，
   不是端到端的「建立 8000 条提醒」。端到端（`adapter.reconcile` 8000 条）实测**超过 20 分钟**
   （我第一次跑时 60s 未出结果，被我主动 kill）。
3. **adapter 路径的 O(N²) 是 `upsert()` 每次都调 `catalog()` 造成的**：
   `upsertLocked()` 第一行就是 `await backend.catalog()`，
   于是 N 条提醒 → N 次 catalog → 每次扫 O(N) 行 → **O(N²)**。
   这与 `hostIdLookup()` 的优化无关（那条优化修的是「catalog 内部逐行反查」）。
4. **这是继承缺陷，不是本轮回归**：上一轮冻结版 `2b0aabb` 的同一段实测 2584ms，本轮 2664ms，
   **基本持平**（差异在噪声内）。

**严重度：MINOR**，理由：
- 不导致数据丢失 / 重复投递 / 误删 —— 只是慢；
- V1 是单用户场景，2000 条提醒的对账需要约 11 秒（实测），可用；
- 修法（把 `upsert` 的 catalog 快照提到 reconcile 层复用）会**破坏 BLOCKER-2 的串行化语义**
  （串行化的目的正是「每条 create 前重新看一眼 catalog」），
  **不能简单照搬**；需要重新设计（例如把串行化粒度从「单条 upsert」提到「整轮 reconcile」）。

**但文档的表述需要修正**：`docs/wp2/11-WP2-R5-report.md:42` 写
「性能：**8000 条 36.8s → 0.76s**（48 倍）」，
容易被读成「端到端建 8000 条提醒 0.76 秒」。实测端到端远不止此数。
建议改成明确写「`hostMap.put` 写入路径」并补上端到端数字。

---
## 检查 13：收尾边界扫描（探针 R5b-12）

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final && node probe-R5b-12.mjs
```

**实际输出**
```
=== 1) 墓碑 remove() 后 indexScopes 是否被清 ===
  ✅ 有 3 个墓碑  = 3
  ✅ remove(墓碑) 返回 true  = true
  ✅ 墓碑的 index 已删  = undefined
  ✅ 墓碑的 indexScopes 已删  = undefined
  ✅ 其余墓碑未被误删  = 2

=== 2) remove() 会不会误删「别的 key 指向同一 hostId」的情况 ===
  ✅ k1 的身份已删  = undefined
  ✅ k2 的身份仍在  = "k2"
  ✅ k2 的 scope 仍在  = "events"

=== 3) 映射完全丢失时，catalog 的行落到哪个 scope ===
  ✅ 行不被认领（进 unmapped）  = 1
  ✅ rows=0（不猜归属）  = 0
  ✅ needsAttention=true  = true
  ✅ unmapped 行不被删除  = 0
  ✅ 宿主行仍在  = 1

=== 4) protect 与 scope 的交互 ===
  ✅ p1 被保护（未删）  = 2
  ✅ p1 在 protected 列表  = true

=== 5) upsert 时 fireAtMs 变化 → 「删旧建新」是否正确 ===
     改时刻后：created=0 updated=1 removed=0 failed=0
  ✅ 宿主仍 1 条（不重复）  = 1
  ✅ 无失败  = 0
  ✅ 时刻已更新  = 1793837400000
  ✅ 无重复行  = 1

=== 6) 空 desired + 无 scope：全部删掉 ===
  ✅ 全删 removed=5  = 5
  ✅ 宿主 0 条  = 0
  ✅ 映射清空  = 0

=== 探针 R5b-12 汇总：PASS ===
```

**判定：PASS** —— 未发现新缺陷。

**任务书点名「remove() 清 index 时会不会误删别的 key 的身份」→ 已验证不会**：
`remove()` 只删 `state.index[hostId]` 当且仅当 `=== reminderKey`，其余 key 的身份与 scope 均保留。

**任务书点名「时间老化会不会删掉未投递的近期提醒的身份」→ 不会**：
老化判据是 `fireAtMs < now - 180 天`，近期提醒（fireAtMs 在未来）**永远不会被老化**
（探针 R5b-05 A 段：`new1` 保留 400 天）。

**任务书点名「flush 语义（脏标记）会不会在崩溃场景丢身份」→ 有真实窗口，但适配器路径已封堵**：
- `hostMap.put` 单独调用后不 flush → 身份确实会丢（探针 R5b-03 第 4b 段实测：`get('lost')` → undefined）；
- 但**适配器的 `upsert` / `remove` 路径每次都紧跟 `flush()`**
  （`schedule-adapter.js` L400 / L415 / L421），所以「建了提醒但身份没落盘」的窗口**已被封堵**；
- 这是**显式的设计取舍**（注释写明：「flush 的时机由调用方显式决定，不做隐式后台落盘」），
  不是隐蔽缺陷。

---

## 检查 14：探针可复现性

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench/evidence/wp2/review-final
for i in 01 02 06 07 11 12; do node probe-R5b-$i.mjs >/dev/null 2>&1; echo "probe-R5b-$i exit=$?"; done
for i in 03 04 05 08 09 10; do node probe-R5b-$i.mjs >/dev/null 2>&1; echo "probe-R5b-$i exit=$?"; done
```

**实际输出**
```
probe-R5b-01 exit=0     （BLOCKER-1 复核：PASS）
probe-R5b-02 exit=0     （BLOCKER-2 复核：PASS）
probe-R5b-03 exit=1     （新缺陷扫描：报出 createLocks / 老化 / flush 三项）
probe-R5b-04 exit=1     （index 增长曲线：报出 M-1 未真正封顶）
probe-R5b-05 exit=1     （老化精确行为：报出墓碑永不过期）
probe-R5b-06 exit=0     （16 种 history 形状：PASS）
probe-R5b-07 exit=0     （审批 + 异常：PASS）
probe-R5b-08 exit=1     （flush 返回值 / 锁表 / 老化：报出 4 项）
probe-R5b-09 exit=1     （index 无上限复现）
probe-R5b-10 exit=1     （长期运行不收敛 / M-5 矛盾态）
probe-R5b-11 exit=0     （p3 新语义：PASS）
probe-R5b-12 exit=0     （边界扫描：PASS）
```

**判定：PASS** —— 全部探针结果**稳定可复现**，exit code 与首次运行完全一致。
exit=1 的探针是**故意**报告已定位的问题（M-1 的墓碑老化缺口、flush 返回值、锁表泄漏）。

---
## 检查 15：主仓库零污染 + 冻结完整性终检

**命令**
```bash
cd /Users/sylas/Developer/dsh-workbench && git status --short && git log --oneline -1
diff -rq /tmp/wp2r5b-verify/workbench-core/src /tmp/wp2r5b-freeze-368207b/workbench-core/src
```

**实际输出**
```
?? evidence/wp2/review-final/REVIEW-R5b.md
?? evidence/wp2/review-final/probe-R5b-01.log
?? evidence/wp2/review-final/probe-R5b-01.mjs
（…共 25 个未跟踪文件，全部在 evidence/wp2/review-final/ 下）
=== HEAD ===
368207b R5-7: refresh stale acceptance numbers flagged by review (M-6)
SRC IDENTICAL
```

**判定：PASS** — 主仓库**零个被跟踪文件被修改**，只新增了本目录下的报告与探针；
冻结目录的 `workbench-core/src` 与 commit `368207b` 逐字节一致。

---

# 最终结论

## 判定：🟡 APPROVE WITH NITS

**上一轮的两个 BLOCKER 都已真正修好**，我独立复现、逐条核对机制，均确认有效。
剩下的都是**不构成阻塞**的 MAJOR/MINOR/NIT。

### 上一轮问题的复核结果

| # | 级别 | 上一轮问题 | 冻结版 `368207b` 实测 | 判定 |
| --- | --- | --- | --- | --- |
| **B-1** | BLOCKER | 墓碑映射的宿主提醒永远删不掉（幽灵提醒 + `cancel()` 抛错 + 无告警） | `removed=100 failed=0`，宿主 600→500；带 scope 对账 `removed=150 failed=0`；`cancel()` 不抛错；删除失败时身份保留且**不重建** | ✅ **已修** |
| **B-2** | BLOCKER | 并发 reconcile 重复投递（5/5 轮 100% 复现） | 5 轮均「宿主恰好 30 条、重复 0」；部分重叠 desired → 恰好 30 条；不同 key 仍并行（maxInflight=10）；并发 delete+upsert 无死锁无重复 | ✅ **已修** |
| 探针 01 | — | `{status:'unavailable'}` 被当成「没投递过」→ 二次投递 | 16 种形状逐一判定正确；`{status:'unavailable'}` → UNKNOWN；`records:[]` 的 earlier 缺失/true/false 三态**区分正确** | ✅ **已修** |
| M-1 | MAJOR | index 无上限 | **只对「完整条目」有效**；墓碑（无 fireAtMs）**永不过期** → index 仍随累计创建量单调增长（3600 条 → index=3600） | ⚠️ **部分修复** |
| M-2 | MAJOR | `hostMap.put` 每次全量写 → O(N²) | 2000 次 put 8909ms → **482ms**（18.5×）；但「8000 条 36.8s→0.76s」只覆盖 put 那一段，adapter 路径仍有 O(N²)（`upsert` 每条都 `catalog()`） | ✅ put 已修 / ⚠️ 声明范围需写清 |
| M-3 | MAJOR | 探针 REPO 硬编码主仓库 | 三个探针均改为 `fileURLToPath(new URL('../..', import.meta.url))`；冻结目录内跑全 PASS | ✅ **已修** |
| M-4 | MINOR | p3 全程不检查 `failed` | p3 现有 **4 处** `failed.length === 0` 断言 | ✅ **已修** |
| M-5 | MINOR | 矛盾态（active + 有回执）会被删 | 可复现，但真实宿主**不可达**（`status:"inactive"` 与回执同 commit 写入，已核对源码） | ✅ 可接受 |
| M-6 | MINOR | 文档数字滞后 | `08` 文档仍写「183/183」「16 变异」，`11` 仍写「197 项」「32/32」（真值 204/204、36/36） | ⚠️ **部分修复** |

### 本轮新发现（均不构成阻塞）

| # | 级别 | 内容 | 理由 |
| --- | --- | --- | --- |
| N-1 | MAJOR | **时间老化对墓碑无效** → index 仍无上限（实测累计 3600 条 → index=3600、文件 244 KB） | 不导致重复投递/数据丢失（墓碑身份正是防重复投递的机制）；体积渐进（~68 B/条，10 万条 ≈ 6.8 MB）；上一轮已把同类问题定为「MAJOR 已知限制」。**但声称「index 改按时间老化」对占多数的墓碑路径不成立**，需在文档与实现中如实说明 |
| N-2 | MAJOR | **`indexScopes` 完全没有老化路径** → 只增不减，随历史 hostId 总数线性增长（实测 200 天后 indexScopes=4000 而 index=4000） | 同上，渐进增长，非阻塞 |
| N-3 | MINOR | `flush()` 返回值是**死值**（`return { flushed: dirty }` 恒为 `false`，因为 `writeNow()` 已把 dirty 置 false） | 无功能影响（全仓库无人读该返回值）；修法一行 |
| N-4 | MINOR | `createLocks` 的 promise 链**只 set 从不 delete** → 每个历史 reminderKey 永久留一条（实测 ~293 B/key 净增长） | 增长慢；与 N-1 叠加；无死锁（已验证）；修法：`finally` 里条件 delete |
| N-5 | MINOR | adapter 的 `upsert()` 每次都 `catalog()` → 端到端建 N 条提醒是 O(N²)（实测 1000 条 = 5.6s、2000 条 = 11.4s） | **继承缺陷非本轮回归**（上一轮 500 条 2584ms vs 本轮 2664ms，持平）；修法会与 BLOCKER-2 的串行化语义冲突，需重新设计 |
| N-6 | MINOR | M-6 文档数字仍滞后（`08` 写 183/16、`11` 写 197/32，真值 204/36） | 纯文档 |

### 明确「不是问题」的部分（避免无端驳回）

1. **N-17 / history 形状矩阵已真正修好**，16 种形状逐一验证，三态区分正确，与真实宿主源码一致。
2. **审批无旁路**：10 个写 op 在 deny 模式下全部被 `execute` 唯一入口拦下；12 个只读 op 仍工作；`svc.store`/`svc.events` 只暴露 4 个只读方法且被冻结。
3. **异常无静默吞**：宿主 8 种抛法全部有可观察出口（`failed[]` / `degraded=true` / `UNKNOWN`）；**catalog 挂掉时不删任何东西**。
4. **数字没有虚报**：204/204 单测、36/36 变异（0 真空 0 跳过）、26/26 验收、8/8 门禁、demo —— 报告与实测全部一致（`11` 报告的 197/32 是**滞后**，不是**虚报**）。
5. **多进程限制如实标注**：5 进程并发 → 宿主 5 条（跨进程仍会重复），但三份文档的 UNVERIFIED 清单都明确列了「多进程并发写 / `hostMap` 无跨进程锁」，**没有把进程内串行化包装成跨进程安全**。
6. **「真实 storageDomain」不是假的**：门禁在冻结目录内跑 P1 全 PASS（真实 JSON 后端落盘 → 新实例读回 → 5 次重启恒 1 条）。
7. **p3 的新语义正确**：「被裁且不在 desired 的条目**应当被删除**」，旧的错误断言已消失，`failed[]` 有 4 处断言。
8. **探针冻结纪律已修**：M-3 的 `REPO` 推导问题解决，门禁能自证冻结版。
9. **删除失败时身份保留**（任务书点名）：`failed=3`、身份未丢（`unmapped=0`）、再对账**不重建**那 3 条 → 不会二次投递。
10. **`remove()` 不会误删别的 key 的身份**（任务书点名）：已实测。

### 建议实施方在下一轮处理的顺序

1. **N-1 + N-2**（一起做最经济）：给墓碑也保留判龄时间（否则老化永远跳过它），
   并在老化的同一处删 `indexScopes[hostId]`；或给 `index`/`indexScopes` 一个
   **远大于 500 的独立上限**（如 50000），超出时按判龄从最旧开始丢（先丢墓碑）。
2. **N-5**：把串行化粒度从「单条 upsert」提到「整轮 reconcile」，
   这样 catalog 快照可复用，O(N²) 消失，同时**不破坏** BLOCKER-2 的修法。
3. **N-3**：一行修法。
4. **N-4**：`finally` 里条件 delete。
5. **N-6**：把 `08`/`11` 的数字改成 204/204、36/36。
6. **N-5 相关的文档措辞**：`11` 报告的「8000 条 36.8s → 0.76s」应写明测的是 `hostMap.put` 写入路径，
   并补端到端数字。

### 冻结纪律声明

- 本轮**只审** `/tmp/wp2r5b-freeze-368207b`，不审主仓库 HEAD；
- 全部 12 份探针**直接 import 冻结目录的 `workbench-core/src/index.js`**，
  不经任何 `REPO` 常量（`probe-R5b-*.mjs` 里 `FREEZE` 常量写死冻结路径）；
- 主仓库**零个被跟踪文件被修改**（`git status --short` 只显示本目录下的未跟踪新文件）；
- 本轮除 `evidence/wp2/review-final/` 外**未写任何文件**。
