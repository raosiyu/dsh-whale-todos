# WP2 增量独立 Review（368207b..d6cc887）

## 结论：**APPROVE**（在授权范围 `368207b..d6cc887` 内，无阻断 WP2 条件验收的缺陷）

> 本文件由**独立 Review Agent**写出（委派：只读审查、自己跑、结论写入文件）。
> 审查对象是冻结的 `d6cc887` 提交内容，不是后续被修改的工作树。
> 结论仅对 `368207b..d6cc887` 这 7 处增量成立；之后的提交/未提交改动不在本次授权范围。

### 环境与基线（重要，影响证据可信度）

- 委派指定 `HEAD=d6cc887`、冻结比较 `git diff 368207b..d6cc887`。审查期间**主会话并发修改了仓库**：
  HEAD 先后变为 `4d5c403` → `c12d377`，`host-map.js` 出现过未提交改动与
  `host-map.js.mutation-backup` 残留。直接 import 主仓库实时文件会审到**非 d6cc887** 的版本。
- 因此用 `git archive d6cc887 | tar -x -C /tmp/wp3pre/frozen` 冻结全仓，
  校验 `shasum` = `f93b4b9e88e0edcfcf845c40cf46cc81e75e544d`
  与 `git show d6cc887:workbench-core/src/host-map.js` 一致。
  **所有探针、单测、变异均在该冻结副本上运行**（`probe-frozen.mjs` 等），不引用主仓库实时文件。
- 主会话在我写结论前已把 `02` 写成「有条件通过 / Agent 中断」草稿，并基于我的**早期探针输出**
  （那时探针误判了 P1.7/P1.8/P7）改了代码、加进 `c12d377`。那些改动**不属于本次冻结增量**，
  且我已证明那 3 组 FAIL 是**探针期望错误**（见下），不是 `d6cc887` 的缺陷。草稿已备份到
  `/tmp/wp3pre/02-main-session-draft.md`。本文件按委派要求以**独立 Review 的实测结论**覆盖它。

## 审查范围（严格增量）

- 命令：`git diff 368207b..d6cc887 -- workbench-core/src/host-map.js`（46 行增删，7 处）。
- 全范围仅 `workbench-core/src/host-map.js` 是 `workbench-core/src/*` 下唯一改动文件
  （与 `01-diff-classification.md` 一致：`git diff --name-status` 共 37 文件，其余为文档/证据/测试/变异定义）。
- 不审全仓、不重复 WP2 全量审查。7 处：`indexScopes`→`indexMeta`、load 兼容旧格式、
  老化判龄（回退 indexMeta + `fireAt===0` 跳过 + 删 indexMeta）、prune 写 indexMeta、
  flush 返回值、describe 返回真实 fireAtMs/scope、put/remove/removeByHostId 同步维护。

## 逐项验证表（全部在冻结 d6cc887 上实测）

探针源码 `/tmp/wp3pre/probe-frozen.mjs`，输出 `/tmp/wp3pre/probe-frozen.stdout.log`（退出码 0，无 FAIL 行）。
每格 `PASS n` 后是该组检查点数量。

| 项 | 命令 / 探针 | 实际输出 | 判定 |
| --- | --- | --- | --- |
| 1 `emptyState` + load 旧格式兼容 | P1.1–P1.9 | 手工构造 `indexScopes:{"h1":"events"}`（无 indexMeta）文件：`reminderKeyByHostId('h1')='k1'`、`describe('k1').scope='events'`、`hostIdOf('k1')='h1'`；墓碑路径 `describe().scope='events'`、`fireAtMs=0`；触发一次写后落盘 `indexMeta.h1={scope:'events',fireAtMs:0}`，旧字段 `indexScopes=undefined`，身份仍在 | ✅ 不丢身份；字符串 scope 正确转成 `{scope,fireAtMs:0}` |
| 2 `fireAt===0` 保守跳过 | P3.1–P3.4 | 手工构造 `indexMeta.hZero.fireAtMs=0` 与旧格式 `indexScopes` 墓碑，`now()` 推进 +200 天后触发老化：身份 `kZero`/`kLegacy` 均保留，磁盘 `index`/`indexMeta` 仍在 | ✅ 不误删身份 → 不重复投递 |
| 3 墓碑老化真生效（N-1 修复点） | P2.1–P2.6 | maxEntries=2 写 6 条 → 4 个墓碑；`indexMeta['h-0'].fireAtMs=1792972800000`（**证明确实从 indexMeta 取到值**）；推进 +200 天 + 一次 put 触发老化：`reminderKeyByHostId(h-0..h-3)=undefined`，磁盘 `indexMeta` 仅剩 `h-trigger`、`index` 仅剩 `h-trigger` | ✅ 判龄读 indexMeta 成立，墓碑可老化 |
| 4 prune 写 indexMeta + 收敛 | P2.3 / growth.mjs | 墓碑 `indexMeta.scope='events'`；5 代「写 6 条→超窗老化」循环：每代老化后 `index=indexMeta=1`，`index` 与 `indexMeta` 键集合一致 | ✅ 不无限增长（N-2） |
| 5 flush 返回值 | P5.1–P5.7 | 无脏 `flush()={flushed:false}`；put 后 `dirty=true`；`flush()={flushed:true}`；再次 `flush()={flushed:false}`；`dirty=false`；磁盘有 `k1` | ✅ 修复生效（对照：base `flush-base.log` 第一次返回 `{flushed:false}`） |
| 6 describe 真实 fireAtMs / scope | P4.1–P4.4 | 墓碑 `describe().fireAtMs=1793404800000` == put 值（非 0）、`scope='events'`；完整条目仍返回 entry 自身值 | ✅ 真实值 |
| 6b upsert 时刻比较回归评估 | 静态 + P4.4 | `schedule-adapter.js:290` 仅在 `Date.parse(scheduledAt)` 为 NaN 时回退 `mapped.fireAtMs`；`:347`/`:691` 比较的是 catalog 行的 `fireAtMs`，非 describe 直接值；全仓无 `fireAtMs===0` 哨兵依赖 | ✅ 无回归：describe 改动只在宿主行缺 scheduledAt 时把回退值从 0 改成真实值（单向改善） |
| 7 put/remove/removeByHostId 同步维护 | P6.1–P6.9 | `remove('kA')` 后 `indexMeta` 无 hA；`removeByHostId('hB')` 返回 'kB' 后无 hB；墓碑 `remove(k)` 返回 true 且 `indexMeta` 无该 hostId | ✅ 无残留 |
| 7b 老化一致性 | P7.1a–P7.5 | 手工构造「超窗完整条目 + 超窗墓碑」，触发老化：内存 `entries()=[]`、反查均 undefined；经 put 触发写后磁盘 `entries`/`index`/`indexMeta` 同步清除 | ✅ 三处一致 |

### 关于早期探针 3 组 FAIL 的判定（不是缺陷）

`probe.mjs`（21:45 首跑）曾报 P1.7/P1.8/P7.1–P7.5 FAIL。根因是**探针期望写错**，不是 `d6cc887` 的缺陷：

- `flush()` 契约是「dirty 才写」；`load()` 兼容转换、`prune()` 老化都只改内存、**不置脏**，
  单纯 `flush()`（无脏）返回 `{flushed:false}` 且不重写磁盘 —— 这是既有设计
  （`put()` 尾部 `prune()+persist()`；生产代码无 `.prune()`/`.reload()` 调用，老化只经 `put()` 触发）。
- `dirty-test.log` 对照实验：`368207b` 与 `d6cc887` 的 `prune()+flush()` 行为**完全一致**
  （两者都 `dirty=false`、磁盘不变），公开 `prune()` 实现逐字相同（`diff` = IDENTICAL）
  → **pre-existing，非本次增量引入**，且生产路径由 `put()` 保证落盘。
- 把探针改成「用 put 触发写后再验磁盘」后，P1.7/P1.8/P7 全 PASS（`probe-frozen.stdout.log`）。
- 主会话据此做的「load/prune 置脏」修复与两条守卫测试属于**之后的工作树/提交**，
  可作为健壮性增强，但**不是 d6cc887 的 blocker**；本结论不把它们算作本次增量的通过条件。

## 新发现

**无阻断缺陷。** 以下为非阻断观察，均经复现确认：

1. **（信息 / 非阻断）老化与旧格式归一化不置脏**：单看 `load()`/`prune()` 后直接 `flush()`，
   磁盘不会写。复现：`dirty-test.log` 两版本一致。影响：仅当调用方**不写任何新数据、只调
   `prune()` 再 `flush()`** 时，老化结果不落盘，重开后旧身份「复活」。但生产代码
   （`schedule-adapter.js`）唯一触发老化的路径是 `put()`，其尾部必 `persist()`，故实际不可达。
   属既有 contract，不阻断本次增量。
2. **（信息 / 非阻断）`flush()` 返回值虽被修复，但无测试直接断言 `.flushed`**：
   `grep -rn "flushed" workbench-core/test/` 为空。不过全仓无生产消费者读取该返回值
   （`schedule-adapter.js` 6 处 `hostMap.flush()` 均忽略返回），故不构成回归风险；
   建议后续补一条断言（不属于 blocker）。
3. **（信息）`removeByHostId` 不清墓碑身份**：该缺陷在两个版本均存在（base 同样不删
   `index`），与 `indexMeta` 增量无关，且全仓无生产调用者（`grep removeByHostId` 仅定义与探针）。
   不属本次增量引入。

## 回归结果（冻结 d6cc887，均在 `/tmp/wp3pre/frozen` 内跑）

| 项 | 命令 | 实际输出 | 判定 |
| --- | --- | --- | --- |
| 单元测试 | `cd /tmp/wp3pre/frozen/workbench-core && node --test test/*.test.mjs` | `# tests 207 / # pass 207 / # fail 0`，退出码 0（`/tmp/wp3pre/unit-tests.log`） | ✅ 207/207 |
| 变异验证 | `cd /tmp/wp3pre/frozen && node scripts/r3-mutate.mjs /tmp/wp3pre/mut.log` | `变异定义：36 项`；`CAUGHT: 36 / VACUUM: 0 / SKIP: 0`；`结论：全部保护点都有测试约束`（`/tmp/wp3pre/mut.log`） | ✅ 36/36 |
| X29 专项 | 同上 | `CAUGHT X29 B-1 回归：describe 不读 indexMeta（墓碑 scope 丢失，带 scope 对账跳过） → pass 206 fail 1`；锚点 `scope: state.indexMeta?.[hostId]?.scope ?? ''` 在 d6cc887 中唯一（`grep -c`=1）；由 `R9 守卫：墓碑保留 scope` 捕获 | ✅ 锚定 describe 的 scope 读取后仍被捕获 |
| 脚本自净 | `shasum` 变异后 | 冻结副本 `host-map.js` sha 仍为 `f93b4b9…`，无 `.mutation-backup` 残留 | ✅ |

## 是否有阻断 WP2 条件验收的缺陷

**否。** 对 `368207b..d6cc887` 的 7 处增量：

- 旧格式兼容不丢身份；`fireAt=0` 保守跳过避免误删；墓碑老化真生效且 indexMeta 收敛；
  flush 返回值修复正确；describe 真实 fireAtMs 对 upsert 时刻比较无回归；
  remove/removeByHostId 清理干净。
- 未发现数据丢失、重复投递、身份漂移、审批/安全旁路。
- 207/207 单测与 36/36 变异（含 X29）全绿。
- 故本独立 Review 给出 **APPROVE**，可据此把 WP2 标记为条件验收完成。

### 授权边界（不越界）

- 本结论**只覆盖** `368207b..d6cc887`。审查期间主会话把仓库推进到 `c12d377` 并合入了额外修复；
  那些改动未审、也未依赖本次通过。若要让 WP2 条件验收覆盖 `c12d377`，需另行审查。
- WP2 既有 UNVERIFIED 项（macOS 系统级、真实投递回执、多进程并发、exactly-once）一律保留，
  不因本次增量复核而变更。
- 全程只读仓库被跟踪文件；除本文件、`/tmp/wp3pre/` 外未写任何文件
  （冻结副本、探针、日志、备份草稿均在 `/tmp/wp3pre/`）。

## 复核命令（可复现）

```bash
cd <repo>
git diff 368207b..d6cc887 -- workbench-core/src/host-map.js
git show d6cc887:workbench-core/src/host-map.js | shasum   # f93b4b9e88e0edcfcf845c40cf46cc81e75e544d
# 冻结（避免实时工作树干扰）
git archive d6cc887 | tar -x -C /tmp/wp3pre/frozen
node /tmp/wp3pre/probe-frozen.mjs                 # 全部 PASS，退出码 0
cd /tmp/wp3pre/frozen/workbench-core && node --test test/*.test.mjs      # 207/207
cd /tmp/wp3pre/frozen && node scripts/r3-mutate.mjs /tmp/wp3pre/mut.log  # 36/36，X29 CAUGHT
cat /tmp/wp3pre/dirty-test.log /tmp/wp3pre/flush-base.log /tmp/wp3pre/growth.log
```
