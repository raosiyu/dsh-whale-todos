# WP2-R5 最终独立 Review 结论（Reviewer: WP2R5-Final）

审查对象：冻结快照 `/tmp/wp2r5-freeze-2b0aabb`（基准 commit `2b0aabb`，756 文件）
审查人：WP2-R5 最终独立 Review 员（子会话）
产出目录：`<repo>/evidence/wp2/review-final/`

---

## 检查 00：基线复跑（单元测试 / demo）

**命令**
```bash
cd /tmp/wp2r5-freeze-2b0aabb/workbench-core && node --test test/*.test.mjs
cd /tmp/wp2r5-freeze-2b0aabb && node workbench-core/demo/demo.mjs
```

**实际输出摘录**
```
# tests 196
# pass 196
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1538.456459
```
```
DEMO EXIT=0
  首次对账：created=2 removed=0
  重复对账（幂等）：created=0（应为 0）
  到点投递：第一次 2 条，重复 tick 0 条（应为 0）
  投递历史合计 2 条（status=ok），与真实投递一致=true
```

**判定：PASS** — 196/196 测试通过，demo 正常退出。

---

## 检查 01：探针的「冻结纪律」——探针实际测的是哪个代码？

**命令**
```bash
cd /tmp/wp2r5-freeze-2b0aabb && grep -n "REPO\s*=" scripts/probes/*.mjs
cd <repo> && git status --short
diff -rq /tmp/wp2r5-freeze-2b0aabb/workbench-core/src workbench-core/src
```

**实际输出摘录**
```
scripts/probes/p1-real-storage-domain.mjs:22:const REPO = '<repo>'
scripts/probes/p2-protect.mjs:17:const REPO = '<repo>'
scripts/probes/p3-retention.mjs:20:const REPO = '<repo>'
```
```
 M evidence/wp2/review-final/mutation.log
 M evidence/wp2/review-final/p1-real-storage-domain.log
 M scripts/r3-mutations.json
 M workbench-core/src/host-map.js
 M workbench-core/test/contract.test.mjs
```
```
Files /tmp/wp2r5-freeze-2b0aabb/workbench-core/src/host-map.js and workbench-core/src/host-map.js differ
```

**发现（事实）**：三个探针的 `REPO` 常量全部**硬编码为主仓库工作副本**，而不是冻结目录。
因此 `bash scripts/wp2-r5-gate.sh`（在冻结目录里跑）测的**不是冻结代码**——它 import 的是主仓库
未提交的 `host-map.js`（该文件在冻结版里没有 index 封顶逻辑，主仓库里多了一段）。

**主仓库与冻结版的 src 差异（未提交）**：
```diff
--- /tmp/wp2r5-freeze-2b0aabb/workbench-core/src/host-map.js
+++ <repo>/workbench-core/src/host-map.js
@@ -154,6 +154,17 @@
       state.index[v.hostId] = k
       delete state.entries[k]
     }
+    // index 也必须封顶：否则它会随运行时间无限增长（实测 8000 条 → 269 KB）。
+    const indexEntries = Object.entries(state.index)
+    if (indexEntries.length > maxEntries) {
+      const orderedIndex = indexEntries.sort((a, b) => { ... })
+      for (const [hostId] of orderedIndex.slice(maxEntries)) delete state.index[hostId]
+    }
```

**判定：MAJOR（流程缺陷，非本轮代码缺陷）** — 冻结目录里的门禁脚本无法自证冻结版；
它测的是主仓库 HEAD+未提交改动。这也意味着：**冻结版 `host-map.js` 里 `index` 确实没有上限**
（见检查 05 的独立实测），而门禁日志里显示的却是「有上限」的结果。

> 我的所有独立探针一律直接 import 冻结目录的 `workbench-core/src/index.js`，
> 不走 `REPO` 常量，避免上述污染。

---
## 检查 02：基线复跑（demo / 真实 Service L4 / 8 项验收 / 变异）

**命令**
```bash
cd /tmp/wp2r5-freeze-2b0aabb && node workbench-core/demo/demo.mjs          # EXIT 0
cd /tmp/wp2r5-freeze-2b0aabb && node scripts/r3-real-service.mjs            # EXIT 0
cd /tmp/wp2r5-freeze-2b0aabb && node scripts/r3-acceptance.mjs              # EXIT 0
cd /tmp/wp2r5-freeze-2b0aabb && node scripts/r3-mutate.mjs /tmp/wp2r5rev/mut.log
```

**实际输出摘录**
```
=== 2) 真实代码上跑五个方法 ===
  ✅ create(sessionId, {title,prompt,at}) 成功  {"id":"schedule-3d52a07c-...","kind":"at",...}
  ✅ record 是 frozen
  ✅ record 无 key 字段（身份必须本地持久化）
  ✅ history limit=0 被拒（invalid_rule）  = "invalid_rule"
=== 3) 适配器 × 真实 Service 端到端 ===
  ✅ 5 次重启后真实宿主仍只有 1 条  = 1
=== 汇总 ===
RESULT: L4 PASS（真 Service 类 + 适配器端到端）
边界：假 storageDomain ≠ 真实 Host 的 fiber/effect 生命周期；生产端到端仍 UNVERIFIED。
```
```
=== 汇总 ===
  PASS 26  FAIL 0  UNVERIFIED 0
```
```
CAUGHT: 31
VACUUM: 0
SKIP:   0
结论：全部保护点都有测试约束（0 真空，0 跳过）
```

**判定：PASS** — 196/196 单测、demo、L4、26/26 验收、31/31 变异全部通过。

---

## 检查 03：真实 storageDomain 独立复现（探针 02）

**命令**
```bash
cd <repo>/evidence/wp2/review-final && node probe-WP2R5-Final-02.mjs
```

**做法差异**：p1 手搓 `new Storage(pc)` + `new DomainFacility(pc, ...)`；
我用三个插件**自己的 `apply()`**（`dsh-storage-json.apply` / `dsh-storage-domain.apply`）
让它们按真实生命周期装配，且 import **冻结目录**源码。

**实际输出摘录**
```
  ✅ 真实 Host 组装成功（storage + storage-json + storage-domain 三插件 apply）
  ✅ 真实 scheduleDomain 打开成功（ctx.storage.domain.open）
  ✅ 真实 domain 写入 1 条 tasks  schedule-r5p2
  ✅ 真实落盘（存储根目录非空）  schedule.json
    落盘体积: 555 字节
  ✅ 新实例从真实 JSON 后端读回 1 条  schedule-r5p2
  ✅ 5 次「重启」后真实 storageDomain 里只有 1 条提醒  id=schedule-r5p2-1
  ✅ hostMap 真实落盘  291 字节
=== 探针 02 汇总：PASS ===
```

**源码核对（任务书点名的 API 是否与真实插件一致）**
| 探针用的 API | 真实插件源码 | 一致？ |
| --- | --- | --- |
| `storageMod.storageBackendServiceKey('json')` | `dsh-storage/lib/index.js` L97 `function storageBackendServiceKey(name){return \`storage.backend.${name}\`}` | ✅ |
| `ctx.storage.backend.register('json', backend)` | `dsh-storage-json/lib/index.js` L598 `apply()`：`ctx.storage.backend.register("json", backend)` | ✅ |
| `pc.provide(backendKey, backend)` | 同上：`ctx.provide(storageBackendServiceKey("json"), backend)` | ✅ |
| `new DomainFacility(pc, {...})` + `pc.storage.mount('domain', facility)` | `dsh-storage-domain/lib/index.js` L443 `domainCtx.storage.mount("domain", facility)` | ✅ |
| `pc.provide('storageDomain', facility)` | 同上 L449 `domainCtx.provide("storageDomain", facility)` | ✅ |
| `ctx.storage.domain.open(sched.scheduleDomain)` | `dsh-schedule/lib/index.js` L1997 `ctx.storageDomain.open(scheduleDomain)` | ✅ |

**判定：PASS** — p1 的「真实 storageDomain」结论**属实**，不是假实现；我的独立复现也通过。

---

## 检查 04：N-17 攻击矩阵（探针 01，16 种 history 形状）

**命令**
```bash
cd <repo>/evidence/wp2/review-final && node probe-WP2R5-Final-01.mjs
```

**实际输出摘录（判据表）**
```
UNKNOWN   | 宿主保留=Y | 未重建=Y | history 抛错（宿主读不到投递状态）
UNKNOWN   | 宿主保留=Y | 未重建=Y | history 抛带 code 的错
UNKNOWN   | 宿主保留=Y | 未重建=Y | history 返回非法形状（字符串）
UNKNOWN   | 宿主保留=Y | 未重建=Y | history 返回数组
UNKNOWN   | 宿主保留=Y | 未重建=Y | history 返回 null
UNKNOWN   | 宿主保留=Y | 未重建=Y | history 返回 undefined
REBUILT   | 宿主保留=Y | 未重建=N | history 返回 {}（无 records 无 earlier）
REBUILT   | 宿主保留=Y | 未重建=N | history 返回 {records:[]} 但无 earlier 字段
REBUILT   | 宿主保留=Y | 未重建=N | history 返回 {records:[], earlierRecordsUnavailable:false}
UNKNOWN   | 宿主保留=Y | 未重建=Y | history 返回 {records:[], earlierRecordsUnavailable:true}（回执被裁剪）
UNKNOWN   | 宿主保留=Y | 未重建=Y | history 返回 {records:[非数组], earlier:true}
UNKNOWN   | 宿主保留=Y | 未重建=Y | history 返回 {records:null, earlier:true}
REBUILT   | 宿主保留=Y | 未重建=N | history 返回 {code:schedule_not_found}
DELIVERED | 宿主保留=N | 未重建=Y | history 返回 {records:[回执]}（已投递）
DELIVERED | 宿主保留=N | 未重建=Y | history 返回 {records:[回执], earlier:true}
REBUILT   | 宿主保留=Y | 未重建=N | history 返回 {status:unavailable}
```

**任务书点名的关键问题的答案**：
- `earlierRecordsUnavailable` **缺失（undefined）** 时 → 走 `records.length===0 && res.earlierRecordsUnavailable === true`
  这一严格比较，undefined ≠ true → 判 **NOT_DELIVERED** → **重建**。
  这与真实宿主语义一致：真实 `deliveryHistoryPage` 恒返回 `earlierRecordsUnavailable: boolean`，
  且缺失只可能出现在「从未投递」的旧任务上（`deliveryHistoryOf` 的 fallback 给 `true` 是另一种情形）。
  **不构成误判**。
- `{records:[], earlierRecordsUnavailable:true}` → **UNKNOWN**：不删不建 ✅
- `{records:[], earlierRecordsUnavailable:false}` → **NOT_DELIVERED** → 重建 ✅（确认未投递）
- history 抛错 / 非法形状 → **UNKNOWN**：宿主那条 active 提醒**原样保留**，`removed=[]`、`restored=[]` ✅

**探针 01 的两条 ❌（DELIVERED 时提醒被删）—— 复查后判定为探针构造产物，非缺陷**：

**命令**
```bash
cd <repo>/evidence/wp2/review-final && node probe-WP2R5-Final-11.mjs
```
```
--- 1) 真实语义：投递后 inactive 的行不得被删 ---
    投递后宿主行: ["schedule-1/inactive"]
    recover 结果: state=DELIVERED removed=[]
    恢复后宿主行: ["schedule-1/inactive"]
  ✅ 已投递（inactive）的行未被删除 —— 投递历史保留
```
真实宿主源码（`dsh-schedule/lib/index.js` L1600-1608）在**同一次 commit** 里同时写
`status: "inactive"` 与回执：
```js
await this.commit({ ...task, status: "inactive", ...appendDelivery(task, {...}, this.retention) })
```
因此「宿主行是 active **且** 有回执」在真实宿主里**不可达**。
探针 01 里该状态是我把 stub 的 `history` 整个替换掉、`tick()` 没跑造成的**人为矛盾态**。

**判定：PASS** — N-17 在冻结版已真正修好。上一轮我自己引入又修掉的严重回归**没有复发**。

---

## 检查 05：protect 集合四种情形（探针 05/12 与源码核对）

| 情形 | 期望 | 实测 | 判定 |
| --- | --- | --- | --- |
| 跨 session | s1 对账不删 s2 的 | s2 行保留，`removed=0` | ✅ |
| 跨 scope | 只删该 scope 的 | `removed=['ev-1']`，tasks 侧保留 | ✅ |
| 映射丢失 | 不认领、不误删、上报 unmapped | `rows=0`、`unmapped=1`、`needsAttention=true`、宿主行保留 | ✅ |
| 宿主记录失效（not_found） | 重建 | `created=1`、`removed=0` | ✅ |
| 宿主 delete 失败 | 计入 failed | `failed=1`、`removed=0`、`op=remove` | ✅ |
| **映射存在但条目被裁剪（墓碑）** | 应能删除 | **删不掉** | ❌ **见检查 06** |

**判定：PASS（前 5 项）/ FAIL（第 6 项 → 检查 06）**

---

## 检查 06：🔴 BLOCKER-1 —— 裁剪成「墓碑」的映射，其宿主提醒**永远删不掉**

### 事实

`workbench-core/src/host-map.js` 的 `prune()` 把超出 `maxEntries` 的条目从 `entries` 移出，
身份（hostId ↔ reminderKey）留在 `index`。但 `schedule-adapter.js` 的 `backend.remove()` 只查
`entries`：
```js
async remove(reminderKey) {
  const mapped = hostMap.get(reminderKey)          // ← 墓碑返回 undefined
  if (mapped === undefined) return { ok: false, reason: 'not-found' }
  const res = await hostSchedule.delete({ id: mapped.hostId, sessionId })
  ...
}
```
而 `catalog()` 对墓碑行给的是 `scope: ''`（映射缺失时的兜底值），
`inScopeRow` 又按 `row.scope === scope` 过滤 → 带 scope 对账时墓碑行**被直接跳过**。

### 复现（探针 05 / 12，冻结版）

**命令**
```bash
cd <repo>/evidence/wp2/review-final && node probe-WP2R5-Final-05.mjs
cd <repo>/evidence/wp2/review-final && node probe-WP2R5-Final-12.mjs
```
```
--- A) 全量对账：desired 只剩后 300 条（前半被用户取消）---
    removed=200 failed=100 宿主行=400
    failed 原因分布: {"not-found/remove":100}
  ❌ 删除失效：desired=300 条，宿主仍有 400 条（幽灵提醒会继续响）
--- B) 带 scope 对账：desired 只剩 scope 内的一半 ---
    removed=200 failed=0 宿主行=400
  ❌ 带 scope 时删除失效：desired=300，宿主仍有 400 条
--- C) 对照组：300 条（未超上限）删除是否正常 ---
  ✅ 对照组 removed=150  = 150
  ✅ 对照组宿主降到 150  = 150
```
```
--- 1) 裁剪顺序：谁变墓碑？---
    墓碑数: 100
    墓碑的 key 序号范围: 0 .. 99
    ℹ️  最先到点的 k-0000 是否墓碑: true
--- 2) 用户主动 cancel 一个已变墓碑的提醒 ---
    受害者 k-0000 是墓碑: true
    cancel 结果: 抛错 not-found
    宿主仍保留 600 行（该提醒仍在宿主上，到点仍会响）
  ❌ cancel 墓碑提醒失败 → 幽灵提醒（用户已取消，宿主仍会投递）
--- 3) 带 scope 对账时，墓碑行被静默跳过（连 failed 都不记）---
    removed=200 failed=0 宿主行=400（期望 300）
    注意：failed 也是 0 —— 这些行被 scope 过滤掉了，**没有任何可观察信号**
  ❌ 带 scope 时墓碑行被静默跳过：宿主残留 100 行，且 failed=0（无告警）
```

### 影响

1. **幽灵提醒**：用户取消/删除的事件，其提醒仍留在宿主上，到点仍会响；
2. **`cancel()` 直接抛错**（`not-found`），用户看到的不是「已取消」而是「不存在」；
3. **无告警**：带 scope 路径下 `failed=0`、`removed=0`，上层看不到任何异常信号；
4. **裁剪顺序使影响集中**：prune 按 `fireAtMs` 倒序保留 → **最先到点的 100 条正是被裁成墓碑的**
   （实测：墓碑 key 序号 0..99，`k-0000` 是墓碑）。也就是说**最马上要响的那批提醒最容易被删不掉**。

### 是不是本轮引入的回归？（探针 13）

**命令**
```bash
cd <repo>/evidence/wp2/review-final && node probe-WP2R5-Final-13.mjs
```
```
  6626b8e（R5-1 之前，无 index 墓碑）:
    同批再对账: created=100 宿主行=700（期望 600）
    删一半后:   removed=200 failed=0 宿主行=500（期望 300）
  2b0aabb（R5-1，有 index 墓碑）:
    同批再对账: created=0 宿主行=600（期望 600）
    删一半后:   removed=200 failed=100 宿主行=400（期望 300）
  判定：两者都删不掉 → 这是**继承缺陷**，不是 R5-1 引入的回归
    但 R5-1 确实改善了它：重复创建从 100 条降到 0 条
```

**结论**：**继承缺陷**，非 R5-1 回归。R5-1 把症状从「重复投递」改善成了「幽灵提醒」——
严重度下降但未消除，且 2b0aabb 的探针（p3）**只测了「不重复创建」，没测「能否删除」**，
所以这个洞在 R5-1 的门禁下是看不见的。

### 判定

**BLOCKER** —— 属于「误删用户数据」的**反面**：用户已取消的提醒**删不掉**、**继续投递**。
按任务书判定标准（数据丢失 / 重复投递 / 误删用户数据），幽灵提醒属于用户可见的严重故障，
且**未被任何现有测试或探针覆盖**。

**修法方向**（供实施方参考）：`backend.remove()` 在 `hostMap.get(reminderKey)` 为 undefined 时，
应回落到身份索引 `hostMap.reminderKeyByHostId` 的反向能力——
即映射里需要能按 reminderKey 查到 hostId（墓碑需保留 hostId→reminderKey **及** reminderKey→hostId），
或者让 `prune()` 保留足够信息让 `remove` 能发出 `hostSchedule.delete({id})`。
另外 `catalog()` 对墓碑行应保留原 `scope`（否则 scope 隔离失守）。

---

---

## 检查 07：500 条映射裁剪 —— 探针 p3 的结论是否可信？

### 7.1 p3 改了「预期值」，新预期是否合理？

`git show 2b0aabb -- scripts/probes/p3-retention.mjs` 显示 p3 是本轮**新增**的（无 930bf38 版本），
其注释明确写：「probe expectations were corrected to the new semantics rather than the code being bent back to the old expectation.」

**我对新预期的判断**：

| p3 的断言 | 是否合理 | 依据 |
| --- | --- | --- |
| 「600 条全部建立，宿主侧 600 条」 | ✅ 合理 | 宿主侧不该被本地映射上限约束 |
| 「本地映射被裁到 500」 | ✅ 合理 | `maxEntries` 的语义就是限制 entries 数 |
| 「catalog 认领全部 600 条（身份索引生效）」 | ✅ 合理 | 墓碑让身份不丢，避免重复创建 |
| 「未删除任何宿主记录 / 未重复创建」 | ✅ 合理 | 同批 key 再对账必须幂等 |
| 「被裁的 100 条不被删除」 | ⚠️ **预期写错了** | 见下方 7.2 |
| 「被裁掉的提醒重新出现 → 复用不重建」 | ✅ 合理 | 同上，幂等 |

**「被裁的 100 条不被删除」这条断言的问题**：p3 第 4 步
（`keptPlans = plans.slice(100)`，期望 `r3.removed.length === 0`）
把**被裁的 100 条**排除在 desired 之外，却期望它们**不被删除**。
但按 reconcile 的语义，「不在 desired 里的 active 行 = 多余项 → 删除」是**设计意图**
（事件被取消 → 其提醒必须删掉）。p3 这条断言实际是在**要求系统保留用户已取消的提醒**——
它把 BLOCKER-1 的行为**固化成了「正确行为」**。

这正是任务书提示的「实现者改过探针的**预期值**，你要判断新预期是否合理，不能默认接受」。

### 7.2 独立复现（探针 03，2000 条 / 跨 3 次重启 / 交错 scope）

**命令**
```bash
cd <repo>/evidence/wp2/review-final && node probe-WP2R5-Final-03.mjs
```
```
--- A) 交错 scope 建 2000 条 ---
  ✅ 宿主侧 2000 条  = 2000
  ✅ 本地 entries 被裁到 500  = 500
--- B) 裁剪后仍全部可认领 ---
  ✅ catalog 认领 2000 条  = 2000
  ✅ 无 unmapped  = 0
--- C) 再次对账 ---
  ✅ events 对账：未删除  = 0   ✅ events 对账：未重复创建  = 0
  ✅ tasks 对账：未删除  = 0    ✅ tasks 对账：未重复创建  = 0
--- D) 跨 3 次重启 ---
  ✅ 重启 1/2/3：entries 仍 500、未删除、未重复创建、宿主仍 2000、认领 2000
--- E) 交错 scope 在裁剪后仍隔离 ---
  ✅ 只对账 events：不删 tasks 的  = 0
--- F) 被裁掉的条目重新出现 ---
  ✅ 未重复创建  = 0
```

**判定**：p3 的**核心结论成立**——2000 条 / 3 次重启 / 交错 scope 下，
裁剪后不误删（就 desired 而言）、不重复创建、认领完整、跨重启行为一致。p3 的结论**可信**。

**但 p3 漏掉了「能否删除」这一维度**（见检查 06）。

### 7.3 `index` 是否无限增长？（任务书点名的关键问题）

**实测（冻结版）**
```
--- G) index 增长与文件体积曲线 ---
    累计创建  3000 → entries= 250 index= 2750 文件= 138946 字节
    累计创建  4000 → entries= 500 index= 3750 文件= 224694 字节
    累计创建  5000 → entries= 500 index= 4750 文件= 261696 字节
    累计创建  6000 → entries= 500 index= 5750 文件= 297696 字节
    index 从 2750 涨到 5750（累计创建 3000→6000）
  ❌ index 无上限：5750 > maxEntries=500（文件 297696 字节，且随累计创建量单调增长）
--- I) 体积评估 ---
    平均每个 index 身份约 51.8 字节
    外推：10 万条累计创建 → 约 4.9 MB
    外推：100 万条累计创建 → 约 49.4 MB
```

**答案：是，`index` 无上限。** 冻结版 `prune()` 只搬 `entries`→`index`，从不裁 `index`。
文件体积随**累计创建量**线性增长（约 51.8 字节/条）。

**但这在本轮是被明确接受的取舍，不是疏漏。** 主仓库 HEAD（`8c264b1`）的 `host-map.js` 里写着：
> 「**index 刻意不封顶**。我试过封顶（实测 2000 条时 index 被裁掉 1500 条 → 第二次对账
> **重复创建 1500 条**，宿主侧 2000 → 3500）。体积增长是渐进的，而重复投递是**用户可见的严重故障**。
> **正确性优先。**」

我独立验证了这个取舍（探针 04）：
```
--- 冻结版 2b0aabb（index 不封顶） ---
  ✅ 第二轮（同批 key）：created=0  = 0
  ✅ 仍全部可认领（unmapped=0）  = 0
    entries=500 index=1000 文件=122948 字节
```
即：**不封顶 = 正确性对，体积线性增长 = 可接受的代价。**
封顶会换来「重复投递」，那是比体积更严重的故障。

**判定**：
- `index` 无上限：**MAJOR（已知限制）**，不是 blocker —— 有明确的正确性理由，
  体积增长缓慢（~50 B/条），且 R5-2 已把它从「每次 put 重写整份文件」的 O(N²) I/O
  改成 dirty-flag + 显式 flush。
  **但冻结版 2b0aabb 仍是 O(N²) 写**（实测 2000 次 put = **8909 ms**，HEAD 是 172 ms，**51.8 倍**）。
  这个缺陷在冻结版里存在，已在 HEAD 修掉。

**结论：p3 的结论可信，但覆盖不全**（缺「能否删除」与「index 体积曲线」两个维度）。

---

## 检查 08：审批旁路 / 并发 / 异常处理（探针 07 / 08 / 09）

### 8.1 deny 模式下的全部写路径（探针 07-A）

```
    服务共 22 个 op
  ✅ WRITE_OPS 与源码常量一致  = "[\"event.bulkDelete\",\"event.create\",\"event.delete\",\"event.import\",\"event.restore\",\"event.update\",\"snapshot.replace\",\"store.backup\",\"store.rollback\",\"task.upsert\"]"
  ✅ deny 模式下 10 个写 op 全部被审批门拦下
  ✅ deny 模式下 12 个只读 op 全部仍可工作
  ✅ 快照指纹未变  = "9cda1d487f0fbf0c18d2380cad11a0eb44b5196d78865907425e421eb37108b5"
```

我逐个把 `service.js` 里 10 个写 op 都在 `deny` 模式试了一遍：**全部被拦**（`confirmation-required`），
且 12 个只读 op 仍正常工作（deny 只挡写，语义正确）。**没有旁路。**

### 8.2 `svc.store` / `svc.events` 的可写方法（探针 07-B）

```
    store: [listBackups, listPreBackups]
    events: [list, get]
  ✅ svc.store / svc.events 只暴露只读查询且被冻结
```
两者都被 `Object.freeze`，只有 4 个只读查询方法，调用后存储指纹不变。**无旁路**。

### 8.3 宿主异常的可观察出口（探针 07-D）

```
  ✅ D1 create 抛错：计入 failed  = 1     reason=host-create-rejected
  ✅ D2 create 返回垃圾：计入 failed  = 1  reason=host-create-invalid-result
  ✅ D3 catalog 抛错：degraded=true  = true   ✅ D3：不删任何东西  = 0
  ✅ D4 delete 抛错：抛出可观察错误
  ✅ D5 history 抛错 → UNKNOWN  = 1    ✅ D5：宿主提醒保留  = 1
```
**五种抛法全部有可观察出口**：单条失败不中断整轮、计入 `failed`、catalog 失败降级为只建不删、
delete 抛错不被静默吞、history 抛错判 UNKNOWN 且不删不建。**无静默失败。**

### 8.4 hostMap 的读-改-写竞态（探针 08-A）

```
--- A) hostMap.put 并发交错 ---
  ✅ 200 次并发 put 后 entries 齐全  = 200
  ✅ 落盘 entries 齐全（无丢更新）  = 200
  ✅ 全部 hostId 能反查回 reminderKey  = 0
```
`put` 是同步的（单线程），无丢更新。

### 8.5 🔴 BLOCKER-2 —— 两个 reconcile 并发、desired 部分重叠 → **重复投递**

**命令**
```bash
cd <repo>/evidence/wp2/review-final && node probe-WP2R5-Final-09.mjs
```
```
  冻结版 2b0aabb:
    宿主行=40 重复条数=10
    宿主行=40 重复条数=10
    宿主行=40 重复条数=10
    宿主行=40 重复条数=10
    宿主行=40 重复条数=10
    5 轮中最大重复 = 10，累计重复 = 50
  主仓库 HEAD 8c264b1:
    宿主行=40 重复条数=10
    （同上，5/5 轮全部复现）
  ❌ 冻结版存在并发重复投递：最大重复 10 条（用户会收到两次同一提醒）
  ❌ 主仓库 HEAD 同样存在并发重复投递：最大重复 10 条
```

**机制**：reconcile 是典型的 check-then-act（TOCTOU）：
```
1) cat = await adapter.catalog()        ← 快照
2) for (key of desired) if (!existingKeys.has(key)) await backend.upsert(...)
```
两个 reconcile **同时**做第 1 步时，各自都看到「重叠的 10 条不存在」→ 各自 `hostSchedule.create()` 一次
→ **宿主侧 40 行（应为 30），重叠的 10 条各有一份** → 用户会收到**两次**同一提醒。

**复现稳定性**：5/5 轮 100% 复现（不是竞态偶发，是必然）。

**不重叠时是安全的**（探针 08-B/09）：
```
--- B) 两个 reconcile 并发，desired 不重叠 ---
  ✅ 宿主 40 条（无重复无丢失）  = 40
  ✅ A 未误删  = 0     ✅ B 未误删  = 0
```

**判定：BLOCKER** —— 重复投递是任务书明确点名的 blocker 类别。
**冻结版与主仓库 HEAD 都存在**，HEAD 未修。

### 8.6 服务层存储并发（探针 08-D）

```
--- D) 服务层 store.mutate 并发 ---
  ✅ 20 次并发 create 后事件齐全  = 20
  ✅ 无重复 id  = 20
```
服务层存储无并发问题（同步 `mutate`）。

---

## 检查 09：诚实性核对（探针 10）

**命令**
```bash
cd <repo>/evidence/wp2/review-final && node probe-WP2R5-Final-10.mjs
```

### 9.1 报告数字 vs 实测

| 项 | 报告声称 | 我实测（冻结版） | 一致？ |
| --- | --- | --- | --- |
| 单元测试 | `unit-tests.log`: pass=196 fail=0 | pass=196 fail=0 | ✅ |
| 变异 | `mutation.log`: CAUGHT=31 VACUUM=0 SKIP=0 | CAUGHT=31 VACUUM=0 SKIP=0 | ✅ |
| 8 项验收 | 26/26 PASS | 26/26 PASS | ✅ |
| demo | EXIT 0 | EXIT 0 | ✅ |

**数字全部一致，没有虚报。**

### 9.2 「模拟通过」有没有被写成「真实通过」？

```
  ✅ round4-audit 如实记录：L4 用假 storageDomain
  ✅ round4-audit 如实记录：不能生产端到端
  ✅ round4-audit 如实记录：第三方复审未产出
  ✅ round4-audit 未见夸大措辞（明确列出「不能说」清单）
```
`docs/wp2/10-round4-audit.md` 明确写有「不能说」清单：
- ❌「已通过第三方复审」——第四轮第三方结论未产出
- ❌「生产环境端到端已验证」——L4 用的是假 storageDomain
- ❌「macOS 系统级已验收」

**这是本项目文档里少见的诚实表述。我没有发现把模拟写成真实的措辞。**

### 9.3 round4-audit 记录的 N-17 与各编号修复是否真实存在（代码验证）

```
  ✅ recover 把 UNKNOWN 的 key 传给 protect（修法 2 在位）
  ✅ deliveryStateOf 对 earlierRecordsUnavailable=true 判 UNKNOWN
  ✅ reconcile 跳过 protect 集合（修法 1 在位）
  ✅ 非对象 history → UNAVAILABLE（R5-1 新修在位）
  ✅ N-03 unmapped 上报 在位
  ✅ N-04 create 失败不中断 在位
  ✅ N-11 scope 按字段过滤 在位
  ✅ N-08 删除失败计入 failed 在位
  ✅ N-05 deny 在唯一入口拦截 在位
  ✅ N-06 restore/upsert 入危险清单 在位
```
**全部在位，无虚报。**

### 9.4 唯一的不诚实点：探针的 import 目标

```
  ❌ p1-real-storage-domain：REPO 指向主仓库工作副本 → 测的不是冻结版
  ❌ p2-protect：REPO 指向主仓库工作副本 → 测的不是冻结版
  ❌ p3-retention：REPO 指向主仓库工作副本 → 测的不是冻结版
```
这不是「谎报」，而是**冻结纪律的漏洞**：`scripts/wp2-r5-gate.sh` 在冻结目录里跑，
但探针 import 的是主仓库工作副本。**门禁脚本无法自证冻结版**。
主仓库在审查期间已推进到 `8c264b1`（R5-2），且一度有未提交的 `host-map.js` 改动——
若我按任务书「跑门禁脚本」执行，跑的就不是 `2b0aabb`。

**我的应对**：全部 11 份探针一律直接 import `/tmp/wp2r5-freeze-2b0aabb/workbench-core/src/index.js`，
不经过 `REPO` 常量。

---

---

## 检查 10：探针可复现性

**命令**
```bash
cd <repo>/evidence/wp2/review-final
for i in 01 02 03 05 07 08 09 11 12 13 14; do node probe-WP2R5-Final-$i.mjs >/dev/null 2>&1; echo "probe-$i exit=$?"; done
```
```
probe-01 exit=1     ← 报 2 项「DELIVERED 被删」，已由探针 11 判定为探针构造产物（非缺陷）
probe-02 exit=0     ← 真实 storageDomain 独立复现：PASS
probe-03 exit=1     ← 报 1 项：index 无上限（MAJOR，有意取舍）
probe-05 exit=1     ← 报 2 项：墓碑不可删除（BLOCKER-1）
probe-07 exit=0     ← 审批旁路/并发/异常：PASS
probe-08 exit=1     ← 报 2 项：并发重复创建（BLOCKER-2）
probe-09 exit=1     ← 并发重复 5/5 轮 100% 复现（BLOCKER-2）
probe-11 exit=0     ← DELIVERED 语义定性：PASS
probe-12 exit=1     ← 墓碑影响刻画（BLOCKER-1 细化）
probe-13 exit=1     ← 继承缺陷 vs 回归（BLOCKER-1 归因）
probe-14 exit=1     ← 证明 p3 把缺陷固化为预期
```
**判定：PASS** — 全部探针结果**稳定可复现**（exit code 与首次运行完全一致）。

**冻结完整性独立复核**
```bash
cd <repo> && mkdir -p /tmp/wp2r5-verify && git archive 2b0aabb | tar -x -C /tmp/wp2r5-verify
diff -rq /tmp/wp2r5-verify /tmp/wp2r5-freeze-2b0aabb
# DIFF_EXIT=0，两边都是 756 个文件
```
**判定：PASS** — 冻结目录与 commit `2b0aabb` 逐字节一致。

---

# 最终结论

## 判定：🔴 REQUEST CHANGES

两个 **BLOCKER** 必须在 WP2 最终验收前修掉。

| # | 级别 | 标题 | 冻结版 | 主仓库 HEAD `8c264b1` |
| --- | --- | --- | --- | --- |
| B-1 | **BLOCKER** | 裁剪成「墓碑」的映射，其宿主提醒**永远删不掉**（幽灵提醒 + `cancel()` 抛错 + 无告警） | 存在 | **仍存在** |
| B-2 | **BLOCKER** | 两个 `reconcile` 并发、desired 部分重叠 → **重复投递**（TOCTOU，5/5 轮 100% 复现） | 存在 | **仍存在** |

### 为什么是 BLOCKER

**B-1（幽灵提醒）**——任务书判定标准里的「误删用户数据」的**反面**：用户已取消的提醒删不掉、
到点仍会投递。三个放大因素：
1. `prune()` 按 `fireAtMs` 倒序保留 → **最先到点的那 100 条正是被裁成墓碑的**（实测墓碑 key 序号 0..99）；
2. `cancel()` 直接抛 `not-found`，用户看到的不是「已取消」而是「不存在」；
3. 带 scope 路径下 `failed=0`、`removed=0`，**上层拿不到任何告警信号**。

**并且 p3 探针把这个缺陷固化成了「正确行为」**（探针 14 已证明）：
p3 第 4 段断言「被裁的 100 条不被删除」，且**全程不检查 `failed`**。
按 reconcile 的语义（desired 之外的 active 行 = 多余项 → 删除），那 100 条**应当**被删；
它们之所以「没被删」，纯粹是因为 `backend.remove()` 查不到墓碑映射而返回 `not-found`。

**B-2（重复投递）**——「重复投递」是任务书点名的 blocker 类别。机制是典型的
check-then-act（TOCTOU）：`catalog()` 快照 → `upsert()`，两个 reconcile 并发时各自都认为
「这条不存在」→ 各建一份。5/5 轮 100% 复现，不是偶发竞态。
冻结版与 HEAD 都存在，**HEAD 未修**。

### 判定里明确「不是问题」的部分（避免无端驳回）

我**没有**发现以下问题，逐一验证过：

1. **N-17 已真正修好**。16 种 history 形状全部验证：抛错 / 非法形状 / 数组 / null / undefined /
   `earlierRecordsUnavailable=true` → **UNKNOWN，不删不建**，宿主那条 active 提醒原样保留；
   `records=[]` 且 `earlier` 缺失或 `false` → NOT_DELIVERED → 重建（与真实宿主语义一致）。
   上一轮我自己引入又修掉的严重回归**没有复发**。
2. **「真实 storageDomain」不是假的**。我用插件自己的 `apply()` 独立复现（与 p1 的手搓方式不同），
   真落盘 → 新实例读回 → 5 次重启一条，**全部通过**；探针用的 6 个 API 与真实插件源码逐条核对一致。
3. **审批无旁路**。10 个写 op 在 deny 模式下**全部**被拦（`confirmation-required`），
   12 个只读 op 仍正常；`svc.store` / `svc.events` 只暴露 4 个只读方法且被冻结。
4. **异常处理无静默失败**。宿主 create 抛错 / 返回垃圾 / catalog 抛错 / delete 抛错 / history 抛错，
   五种都有可观察出口。
5. **数字没有虚报**。196/196 单测、31/31 变异、26/26 验收、demo —— 报告与实测**全部一致**。
6. **没有把「模拟通过」写成「真实通过」**。`docs/wp2/10-round4-audit.md` 明确列了「不能说」清单
   （不声称通过第三方复审、不声称生产端到端已验证、不声称 macOS 系统级已验收）。
   这份文档的诚实度是本项目做得最好的部分。
7. **各编号修复（N-02/N-03/N-04/N-05/N-06/N-08/N-11/N-17）全部在位**，代码可验证，无虚报。
8. **p3 的核心结论可信**。2000 条 / 跨 3 次重启 / 交错 scope 下：不误删（就 desired 而言）、
   不重复创建、认领完整、跨重启一致——我独立复现全部通过。
9. **探针 01 的两条 ❌ 是我的探针构造产物，不是缺陷**。真实宿主在**同一次 commit** 里
   同时写 `status:"inactive"` 与回执（`dsh-schedule/lib/index.js` L1600-1608），
   所以「active 且有回执」在真实宿主里不可达。

### 其余发现（MAJOR / MINOR，不构成阻塞）

| # | 级别 | 内容 | 处置建议 |
| --- | --- | --- | --- |
| M-1 | MAJOR | `index` 无上限，文件体积随累计创建量线性增长（~51.8 B/条；10 万条 ≈ 4.9 MB，100 万条 ≈ 49 MB） | **有意取舍**（封顶会换来重复投递）。但应在文档里明确写出体积曲线，并给 index 加**独立**上限（远大于 500） |
| M-2 | MAJOR | 冻结版 `hostMap.put` 每次重写整份文件 → **O(N²) 写**：实测 2000 次 put = **8909 ms**（HEAD 已修为 dirty-flag + flush，172 ms，**51.8 倍**） | 冻结版落后于 HEAD；WP2 最终验收应以 HEAD 为基准重新冻结 |
| M-3 | MAJOR | **探针的 import 目标写错**：三个探针的 `REPO` 硬编码主仓库工作副本，`bash scripts/wp2-r5-gate.sh` **无法自证冻结版** | 探针的 `REPO` 应从环境变量或 argv 取，冻结审查时指向冻结目录 |
| M-4 | MINOR | p3 探针**全程不检查 `failed`**，把删除失败静默放过 | 见 B-1；p3 修好后此项自然解决 |
| M-5 | MINOR | 探针 01 暴露的「矛盾态」（active + 有回执）→ 该 active 行被删 | 真实宿主不可达；但作为防御，可考虑在 DELIVERED 且行仍 active 时也加入 protect |
| M-6 | MINOR | 文档数字滞后：`08-R3-final-acceptance.md` 仍写「191/191」「25 变异」「L4 实例化 BLOCKED」；`01-WP2-report.md` 写「142/142」 | 属历史文档，建议加一行「本文档记录的是当轮数字」 |

### 修完 B-1 / B-2 后的建议验收动作

1. **B-1 修法**：让 `prune()` 保留 `reminderKey → hostId` 的反向可查性
   （或让 `hostMap` 额外维护一个精简的 tombstone 表 `{reminderKey, hostId, scope}`），
   使 `backend.remove()` 能对墓碑发出 `hostSchedule.delete({id})`；
   同时 `catalog()` 对墓碑行应返回原 `scope`（否则 scope 隔离失守）。
2. **B-2 修法**：在 `reconcile` 内加**同进程串行化**（一个 in-flight 锁 / 队列），
   使「catalog → upsert」成为临界区；或改为「upsert 时用宿主侧可判定的唯一键做幂等」。
   最小可行修法：`createScheduleAdapter` 内加一个 promise 链，把 `reconcile` 串起来。
3. **把 B-1/B-2 各自锁进测试与变异**（新增变异点，如 `X25 墓碑删除失效`、
   `X26 reconcile 不串行化`），并修正 p3 第 4 段的预期值。
4. **重新冻结基准**（含 HEAD `8c264b1` 的 O(N²) 写修复 + B-1/B-2 修复），
   并把探针的 `REPO` 改为可指向冻结目录，再跑一轮独立复审。
5. 建议在 p3 里补上「能否删除」这一维度，以及体积曲线这一维度。

### 附：本轮产出物

| 文件 | 内容 |
| --- | --- |
| `REVIEW-WP2R5-Final.md` | 本文档（10 个检查项 + 最终结论） |
| `probe-WP2R5-Final-01.mjs` / `.log` | N-17 攻击矩阵（16 种 history 形状） |
| `probe-WP2R5-Final-02.mjs` / `.log` | 真实 storageDomain 独立复现（用插件自己的 apply） |
| `probe-WP2R5-Final-03.mjs` / `.log` | 2000 条 / 3 次重启 / 交错 scope + index 体积曲线 |
| `probe-WP2R5-Final-03b.mjs` / `.log` | 诊断辅助（entries=250 异常定位） |
| `probe-WP2R5-Final-04.mjs` / `.log` | index 封顶 vs 重复创建（第一版，判据有误，见 04b） |
| `probe-WP2R5-Final-04b.mjs` / `.log` | index 封顶 vs 重复创建（修正判据） |
| `probe-WP2R5-Final-05.mjs` / `.log` | B-1：裁剪后能否删除不再需要的提醒 |
| `probe-WP2R5-Final-06.mjs` / `.log` | B-1 在冻结版/HEAD 的存在性 + 写放大实测 |
| `probe-WP2R5-Final-07.mjs` / `.log` | 审批旁路 / svc 暴露面 / 并发 / 异常出口 |
| `probe-WP2R5-Final-08.mjs` / `.log` | 并发丢更新 / reconcile 并发 |
| `probe-WP2R5-Final-09.mjs` / `.log` | B-2：并发重复创建精确刻画 |
| `probe-WP2R5-Final-10.mjs` / `.log` | 诚实性核对（数字 / 措辞 / 修复在位性） |
| `probe-WP2R5-Final-11.mjs` / `.log` | DELIVERED 删除语义定性（探针 01 两项 ❌ 的解释） |
| `probe-WP2R5-Final-12.mjs` / `.log` | B-1 可达性与影响刻画（裁剪顺序 / cancel / scope 失守） |
| `probe-WP2R5-Final-13.mjs` / `.log` | B-1 归因：继承缺陷 vs R5-1 回归 |
| `probe-WP2R5-Final-14.mjs` / `.log` | 证明 p3 第 4 项把 B-1 固化为预期 |

**声明**：本轮我只往 `evidence/wp2/review-final/` 写文件，未修改主仓库任何被跟踪文件
（`git status` 变动仅为 `evidence/wp2/review-final/` 下的新文件与我在审查期间
观察到的、由实施方自己推进的 `8c264b1` 提交）。

---

## 追加：审查期间实施方的在途修复状态（截至 12:40）

主仓库 HEAD 在我审查期间从 `2b0aabb` 推进到 `8c264b1`（R5-2），且有**未提交的在途修改**。
我用同一套探针复测了这些在途修改：

| # | 冻结版 `2b0aabb` | 主仓库在途状态 | 结论 |
| --- | --- | --- | --- |
| B-2 并发重复投递 | 存在（5/5 轮 100%） | **已修**（`schedule-adapter.js` 加了同 key 创建锁 `createLocks`） | ✅ 在途修复有效 |
| B-1 墓碑不可删除 | 存在 | **未修**（`host-map.js` 无改动，`removed=200 failed=100 宿主行=400`） | ❌ 仍需修 |

**命令**
```bash
cd <repo>/evidence/wp2/review-final
node probe-WP2R5-Final-09.mjs   # B-2
node probe-WP2R5-Final-05.mjs   # B-1
```
```
  冻结版 2b0aabb:   宿主行=40 重复条数=10   （5/5 轮）
  主仓库 HEAD:      宿主行=30 重复条数=0    （5/5 轮）
=== 判定 ===
  ❌ 冻结版存在并发重复投递：最大重复 10 条
  ✅ 主仓库 HEAD 无并发重复
```
```
--- A) 全量对账：desired 只剩后 300 条（前半被用户取消）---
    removed=200 failed=100 宿主行=400
    failed 原因分布: {"not-found/remove":100}
  ❌ 删除失效：desired=300 条，宿主仍有 400 条（幽灵提醒会继续响）
```

**注意**：在途修改里还加了一条针对我探针 01 的加固
（`historyFor` 把 `{status:'unavailable'}` 等非 ok 形状映射为 UNAVAILABLE），
方向正确——冻结版在探针 01 的第 16 个用例（`{status:'unavailable'}`）里判成了
NOT_DELIVERED → 重建，那确实是一个可修的边缘（真实宿主的 `history` 不返回 `status` 字段，
但中间层可能加）。

**结论不变：REQUEST CHANGES。** 冻结版 `2b0aabb` 有 2 个 BLOCKER；
在途修复已解决 B-2，**B-1 仍未修**，且需重新冻结 + 重新跑门禁
（且门禁脚本的探针 `REPO` 硬编码问题也需一并修，见 M-3）。
