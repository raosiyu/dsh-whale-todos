# WP5.2-P0 最终独立复审 · 第二轮（B1 修复后）· 逐条发现

**冻结 commit**：`07d401f4ad7f99539523f6b5fe338f45beda7873`
**冻结副本**：`/tmp/wp52-p0-freeze-07d401f`（`git archive`，无 `.git`，`chmod -R a-w` 只读锁定）
**复审性质**：第二轮独立复审，验证上一轮发现的 B1（迁移通道跨 scope 误删旧提醒）是否真正闭环。

## 探针清单（全部 import 冻结副本，独立 node 进程，日志落本目录 `round2/`）

| 探针 | 覆盖问题 | 结果 |
|---|---|---|
| `probe-b1-cross-scope.mjs` | B1 闭环：跨 scope v1 旧记录绝不被删 + 迁移通道移除 | PASS 20/20 |
| `probe-p0-colon.mjs` | P0 本体：含冒号 scope 3 次 reconcile create=1,0,0 | PASS 5/5 |
| `probe-v1-restart.mjs` | v1 兼容安全 + 白名单跨进程重启 | PASS 9/9 |
| `probe-isolation.mjs` | 隔离/白名单门控 | PASS 3/3 |
| `reminder-sync-wp51.test.mjs`（冻结全套 54 用例） | 回归面 | PASS 54/54 |

合计 37 项独立断言 + 54 条冻结测试，0 失败。

---

## Q1 B1 是否闭环 —— ✅ 闭环

### 迁移通道彻底移除（grep 实证）

`workbench-core/src/` 与 `workbench-core/test/` 内三个标记命中数：

```
legacyHostRecords: 0
legacyMigrated:   0
legacyKept:       0
```

全树命中仅存在于上一轮（round-1）的旧探针 `evidence/wp52-p0/final-review/probe-*.mjs` 与文档
`04-b1-remediation.md`（历史记录，非源码）。`workbench-core/src/reminder-sync.js` 内不再有任何
`legacyHostRecords` / `legacyMigrated` / `legacyKept` / `migration` 业务逻辑。

### reconcile report 字段面

`probe-b1-cross-scope.log` 实测 report keys：

```
sessionId, created, updated, deleted, unchanged, kept, observed, failed, problems, catalogAvailable
```

`legacyMigrated` / `legacyKept` 字段已随迁移通道一并消失。

### 代码 diff（本轮修复的实际改动）

`git diff 246e401..07d401f -- workbench-core/src/reminder-sync.js` 为**纯删除** 128 行：
- 删除 `legacyHostRecords()`（原 `:703` 起，故意 `void scope` 不做 scope 过滤的收集器）
- 删除 `reconcile` 末尾整段「v1→v2 受控迁移」（原 `:912` 起，含 `liveV2.has(wantV2)` 误删闸门）

本轮 `git diff --name-only` 触及的 src 文件**只有 `reminder-sync.js` 一个**；`approval-gate.js` /
`host-service.js` / `host-map.js` / `host-tools.js` 均未出现在 diff 中。

### 跨 scope v1 旧记录处置（独立探针实证）

`probe-b1-cross-scope.mjs` 用假 schedule 复现上一轮的误删场景矩阵，6 组 × 3 断言全绿：

```
旧记录 task:t1         (语义=空scope)   在 scope=projA 下 reconcile → 保留，delete 调用 0
旧记录 task:_:t1       (三段 `_` 占位)  在 scope=projA 下 reconcile → 保留，delete 调用 0
旧记录 task:projA:a:b  (id 含冒号)      在 scope=projA 下 reconcile → 保留，delete 调用 0
旧记录 task:a::b:t1    (scope 含冒号)   在 scope=a::b  下 reconcile → 保留，delete 调用 0
旧记录 task:t1         (空scope)        在 scope=""    下 reconcile → 保留，delete 调用 0
旧记录 event-start:t1  (event 两段)     在 scope=projA 下 reconcile → 保留，delete 调用 0
```

关键断言：**每一组「对旧记录 delete 调用 = 0」且「全轮 delete 调用 = 0」**——即任意 scope 的
reconcile 对 v1 旧记录零 delete。上一轮 B1 的误删路径已不存在。

---

## Q2 P0 本体是否仍成立 —— ✅ 成立

`probe-p0-colon.mjs` 实测（含冒号/中文/空 scope 各连续 3 次 reconcile）：

```
scope="a::b"     : created=1,0,0 且 hostActive=1
scope="proj:sub" : created=1,0,0 且 hostActive=1
scope="x:y:z"    : created=1,0,0 且 hostActive=1
scope="中文:作用域" : created=1,0,0 且 hostActive=1
scope=""         : created=1,0,0 且 hostActive=1
```

v2 base64url 身份（`wb2.<kind>.<b64url(scope)>.<b64url(entityId)>`）对含冒号 scope 无歧义，
重复投递根因未回归。

---

## Q3 v1 兼容安全 —— ✅ 正确

`probe-v1-restart.mjs` 实测：

```
decodeIdentity("task:_:t1")      → legacyAmbiguous=true, ownershipOf=suspect (legacy-identity-ambiguous)
decodeIdentity("task:t1")        → legacyAmbiguous=true, ownershipOf=suspect
decodeIdentity("task:projA:a:b") → legacyAmbiguous=true, ownershipOf=suspect
decodeIdentity("task:a::b:t1")   → legacyAmbiguous=true, ownershipOf=suspect
decodeIdentity("event-start:_:e1")→ legacyAmbiguous=true, ownershipOf=suspect
v2 干净记录 (scope=projA)          → owned
v2 记录 scope 不匹配               → suspect（不误当 owned）
```

`decodeIdentity` 对 v1 歧义形态标 `legacyAmbiguous`，`ownershipOf` 判 `suspect`（永不删），
v2 干净记录判 `owned`、scope 不符判 `suspect`——三层语义均正确。

---

## Q4 跨进程重启 —— ✅ 不重复

`probe-v1-restart.mjs` 实测（白名单经 `ownershipFor` 持久化到共享 disk Map，模拟 `schedule.json`）：

```
进程 1 首轮 reconcile：created=1，白名单写盘 1 条 identity
进程 2（重启，全新 sync 实例 + 全新 schedule 但搬入 Host 已存记录）：created=0，Host 仍 1 条
```

跨进程重启后 create=0，无重复。

---

## Q5 隔离 / 白名单 / 审批 —— ✅ 未被本轮波及

`probe-isolation.mjs` 实测：

```
ISO-1 session 隔离：s2 reconcile 不删 s1 记录 ✅
ISO-2 白名单门控：未登记 identity 的可疑记录 kept 不删 ✅
ISO-3 scope 隔离：projA 与 projB 同名实体各 1 条，不互相 update 踩踏 ✅
```

本轮 diff 只改 `reminder-sync.js`，`approval-gate.js`（审批门控）及 host-service/host-map/host-tools
均未出现；审批门控代码（`approvalFingerprint` / `CONFIRMATION_REQUIRED` 路径）原样保留。

---

## 证据完整性披露（环境/元数据，非代码 blocker）

1. **题面 tree digest 与实际不符**：题面给出的「tree digest `0d8eedbb8f9303515e5fd3660be99fda0f617171`」
   在本仓库中**不存在**（`git cat-file` 报 could not get object info）；commit `07d401f` 的真实
   tree hash 是 `e2d0e07376f9f40bf0a6037a1cbbec77ce221730`。
   但**不影响复审有效性**：`git archive 07d401f` 与冻结副本 `/tmp/wp52-p0-freeze-07d401f`
   `diff -rq` 逐字节一致（exit 0），HEAD 即冻结 commit 本身。故本轮复审的对象是忠实快照，
   仅题面记录的 digest 字符串有误，建议归档时修正。
2. **冻结副本未改动**：`find -newermt` 无今日新写入文件，根目录 `dr-xr-xr-x`、源文件
   `-r--r--r--` 仍只读。
3. **测试运行方式**：冻结副本只读无法原地跑 node --test（node:test 需要写 `.test` 运行缓存目录外），
   故在 `/tmp` 的**可写副本**（内容逐字节复制自冻结副本）内运行，脚本逻辑与冻结副本完全一致。

---

## 判定汇总

| 项 | 结果 |
|---|---|
| B1 迁移通道彻底移除（grep 3 标记 = 0） | ✅ |
| 跨 scope v1 旧记录绝不被删（零 delete） | ✅ |
| 含冒号 scope 重复投递消除（create=1,0,0） | ✅ |
| v1 歧义标 suspect / v2 判 owned | ✅ |
| 跨进程重启不重复 create | ✅ |
| 隔离 / 白名单 / 审批门控未波及 | ✅ |
| 冻结全套 54 用例 | ✅ 54/54 |
