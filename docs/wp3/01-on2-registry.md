# O(N²) 提醒对账性能问题登记（WP3 授权要求）

状态：**UNRESOLVED** —— 本轮仅登记 + 建立可复现基准，**未改动对账实现，不宣称已解决**。

## 1. 问题来源

- 第二轮独立 Review（`evidence/wp2/review-final/REVIEW-R5b.md`）**N-5 MINOR**：
  「adapter 的 `upsert()` 每次都 `catalog()` → 端到端 O(N²)
  （1000 条 5.6s / 2000 条 11.4s）；继承缺陷非本轮回归」。
- WP3 授权明确要求：**单独登记并建立基准测试，不得在缺乏证据时宣称已解决**。

## 2. 代码事实（可复核）

```bash
cd <repo>/workbench-core
grep -n "await backend.catalog()" src/schedule-adapter.js
# 341:      const current = await backend.catalog()   ← upsertLocked 第一行
```

`reconcile()` 对 desired 中判为「不存在」的每个 key 调 `upsert()`；
host 后端 `upsertLocked()` 第一行是 `await backend.catalog()`，
`catalog()` 需遍历宿主行并逐行做身份反查（现为 `hostIdLookup()` 一次建表，O(1) 查表）。

**理论**：若 `catalog()` 为 O(宿主当前行数)，则建 N 条 ≈ Σi = O(N²)。
**但这是推论，不是实测结论**——见下。

## 3. 基准（`scripts/bench-reconcile.mjs`）

与现有 207 项测试**同一 `contract-stub`**，测量 `reconcile` 一次建 N 条的耗时：

```bash
cd <repo>
node scripts/bench-reconcile.mjs
# 日志：evidence/wp3/bench-reconcile.log
```

实测（2026-11-05）：

| N | 耗时 ms | ms/1000 条 | 宿主行 | created | failed |
| --- | --- | --- | --- | --- | --- |
| 100 | 379.7 | 3797.2 | 100 | 100 | 0 |
| 200 | 746.7 | 3733.6 | 200 | 200 | 0 |
| 400 | 1493.1 | 3732.9 | 400 | 400 | 0 |
| 800 | 3339.2 | 4174.0 | 800 | 800 | 0 |

**二次增长观察**（`ms / N²`）：

| N | ms/N² |
| --- | --- |
| 100 | 3.797e-2 |
| 200 | 1.867e-2 |
| 400 | 9.332e-3 |
| 800 | 5.218e-3 |

## 4. 诚实的口径（重要）

- **本基准实测呈线性**（N 翻倍、耗时约翻倍，`ms/N²` 持续下降），
  **不支持**「在本环境下是 O(N²)」的定性。约 3.7–4.2 ms/条，常数较大。
- 原因推测（**未证实**）：`contract-stub` 的 `catalog()` 是内存操作，
  可能接近 O(1) 或浅拷贝；而真实 Host 的 `catalog()` 要经 `storageDomain`
  读盘与 schema 校验，代价结构不同。
- 因此：
  - ❌ 不照抄「O(N²) 已确认」；
  - ❌ 也不因线性就宣称「已解决」——**真实 Host 路径完全未测**；
  - ✅ 登记为「**模拟环境下线性但常数大；真实 Host 未测；实现未改动**」。
- 按 WP3 授权，此问题**单独登记**，不与 WP3 功能开发混在一起宣称解决。

## 5. 未解决的修法方向（留待有证据时）

把 `catalog()` 快照提到 `reconcile()` 开头、整轮只做一次，可消除
`upsertLocked` 重复读；但**必须与「同 key 创建串行化」**（R5-5 修的
BLOCKER-2，用 `createLocks` promise 链）协调，否则会重新引入并发重复投递。
需要：先补「真实 Host catalog 读盘代价」基准，再设计并发安全的快照方案。

## 6. 复核命令

```bash
node scripts/bench-reconcile.mjs
cat evidence/wp3/bench-reconcile.log
grep -n "await backend.catalog()" workbench-core/src/schedule-adapter.js
```
