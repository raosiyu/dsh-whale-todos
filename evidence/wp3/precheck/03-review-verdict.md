# WP2 增量独立 Review 结论（重派 Reviewer）

状态：已完成（结论见文末）

审查对象：`<repo>`
增量范围：`git diff 368207b..d6cc887 -- workbench-core/src/host-map.js`（R5-8 7 处）
+ 工作树未提交的两条修复（load 旧格式置脏 / prune 老化置脏）
+ `test/contract.test.mjs` 末尾 WP3-P1 / WP3-P7 两条守卫测试
探针目录：`/tmp/wp3pre2/`，直接 import 主仓库 `workbench-core/src/index.js`
只读审查，除本文件与 `/tmp/wp3pre2/` 外不写任何文件。

## 检查 0：范围与基线（环境事实）

- 命令：`git log --oneline -4 && git status --short && git diff HEAD -- host-map.js`
- 输出：当前 HEAD = `c12d377 WP3-1: fix incremental-review findings (load/prune dirty consistency)`；
  两条修复（load 旧格式置脏 / prune 老化置脏）已由主会话提交进 c12d377，工作树干净，
  `git diff HEAD -- host-map.js` 为空。审查对象以**当前工作树实时文件**为准（452 行，
  已 read 全文），经 `src/index.js` import，符合机制要求。
- `git diff 368207b..HEAD -- workbench-core/src/host-map.js` 共 58 行增删（R5-8 的 7 处 + 两条修复），
  与委派描述一致。
- PASS（范围确认，非功能判定）

## 探针说明

- 文件：`/tmp/wp3pre2/probe.mjs`，`import { openHostMap, createScheduleAdapter, createHostBackend, toHostInstant } from '<repo>/workbench-core/src/index.js'`（直接 import 主仓库入口，符合机制要求）。
- 运行：`node /tmp/wp3pre2/probe.mjs`，日志 `/tmp/wp3pre2/probe.log`，结构化结果 `/tmp/wp3pre2/probe-results.json`。
- 结果：**11/11 PASS**（首轮 2 处 FAIL 均为探针自身写法错误：C4a 把 `put` 内部已跑的 `prune` 又判了一次 drop、C4b 误用 `createScheduleAdapter.upsert`（实际在 `createHostBackend` 上）且漏了 `flush` 就落盘；修正探针后全绿，**非被审代码缺陷**）。

## 检查 1：旧格式兼容（旧格式归一化）

- 命令：`node /tmp/wp3pre2/probe.mjs`（C1 / C1b）
- 输出：手工构造只含 `indexScopes: {"h1":"events"}`、无 `indexMeta` 的 JSON →
  `openHostMap` 读回 `reminderKeyByHostId('h1')='k1'`、`describe('k1').scope='events'`、
  `fireAtMs=NOW` 均正确；`dirty=true`（旧格式标脏）；`flush().flushed=true`；
  落盘后 `indexScopes=undefined`、`indexMeta.h1={scope:'events',fireAtMs:0}`；
  重开 `dirty=false`。C1b 补测**纯墓碑旧格式**（entries 空、只靠 index+indexScopes）：
  两个墓碑 `describe().scope='events'/'tasks'` 正确、`fireAtMs=0`（保守），
  落盘文本不再含 `indexScopes` 字样。
- PASS

## 检查 2：墓碑老化 + 显式 flush 落盘

- 命令：同上（C2）
- 输出：`maxEntries=10, indexRetentionMs=30d, now=NOW`，构造 1 条超窗完整条目 + 1 条超窗墓碑
  （fireAtMs=NOW-200d < cutoff=NOW-30d），`indexMeta` 两条齐全。新格式读入 `dirty=false`；
  直接 `m.prune()`（不经 put）→ `dirty=true`；内存 `reminderKeyByHostId('hOld'/'hTomb')` 均 `undefined`；
  `flush().flushed=true`；落盘后 `entries.kAlive / index.hOld / indexMeta.hOld / index.hTomb / indexMeta.hTomb`
  **五处全部 undefined**；`dropped=[]`（未触发条数裁剪，纯老化路径）。
- PASS（修复「prune 老化删除置脏」成立，显式 flush 能落盘）

## 检查 3：`fireAtMs===0` 保守跳过

- 命令：同上（C3 / C3b）
- 输出：C3 构造 `indexMeta.hZero={scope:'events',fireAtMs:0}` 墓碑（即旧格式转换产物），
  `prune()` 后身份仍在、`scope='events'` 可反查；**同窗口对照** `fireAtMs=OLD` 的墓碑被删，
  证明 cut off 生效、跳过不是探针空跑。C3b 补测 **entries 路径** fireAtMs=0 的完整条目同样保留。
- PASS（旧格式转换出的 `{fireAtMs:0}` 不被老化 → 不会误删身份 → 无重复投递风险）

## 检查 4：describe 的 fireAtMs 回归 + upsert 时刻比较

- 命令：同上（C4a / C4b）
- 输出：C4a `maxEntries=2`，`put(fireAtMs=F)` 后由第 3 条 put 触发内部 prune 把 kA 压成墓碑，
  `describe('kA').fireAtMs=F`（等于 put 值）、`scope='events'` 正确。
  C4b 用 `createHostBackend(hostSchedule,{hostMap,sessionId}).upsert`：宿主 catalog 行
  `scheduledAt=toHostInstant(F)`，`Date.parse=F`；`upsert(fireAtMs=F)` 命中 `existing.fireAtMs===record.fireAtMs`
  → `reused=true`，create/delete 均 0 次。**进一步把该 key 压成墓碑并故意把 `indexMeta.fireAtMs` 污染成 12345**
  （`describe().fireAtMs` 变为 12345，与 catalog 的 F 不一致），再 `upsert(fireAtMs=F)` 仍 `reused=true`、
  create/delete 仍 0 次 → 时刻比较取自 catalog 行的 `Date.parse(scheduledAt)`（catalog 中
  `fireAtMs: Number.isFinite(at)? at : mapped.fireAtMs`），**不受 describe 影响**。
- PASS

## 额外检查（主会话可能漏的路径）

- 命令：同上（E1 / E1b / E2 / E3）
- E1 **新格式误标脏**：纯 `indexMeta`（对象值）文件读入 `dirty=false`、`flush().flushed=false`
  → `needsUpgrade = parsed.indexMeta === undefined || null` 判定正确，不会误标脏、不会多写一次。
- E1b **混合格式**：`indexMeta` 里混入字符串值（如 `{h1:'events', h2:{...}}`）→ `needsUpgrade=true`
  （循环里 `typeof v === 'string'` 也置脏），归一化落盘为对象，两个墓碑 scope 均正确 → 覆盖「部分旧值」边界。
- E2 **重复写**：`prune`（老化置脏）→ `put`（内部 prune+persist 置脏）→ 一次 `flush()`
  同时落盘老化删除与新条目；`flush().flushed=true` 后 `dirty=false`，二次 `flush().flushed=false`
  → 脏标记是布尔、非计数器，`writeNow` 写完清脏，**不会重复写、无状态错乱**。
- E3 **indexMeta 残留**：`remove(完整条目)` / `remove(墓碑)` / `removeByHostId` / `clear` 四条路径
  flush 后磁盘 `indexMeta` 均无对应残留；`clear` 后 `index/indexMeta/entries` 全空 → 无残留路径。
- PASS（4/4 额外检查通过，未发现主会话漏掉的 blocker）

## 检查 5：无回归（两套全量验证）

### 5a `cd workbench-core && node --test test/*.test.mjs`

- 命令：`cd workbench-core && node --test test/*.test.mjs`（单独跑，日志 `/tmp/wp3pre2/test-clean.log`）
- 输出：`# tests 209 / # pass 209 / # fail 0 / # skipped 0`，`exit=0`。
- 过程说明（透明披露）：首次跑（`test.log`）与变异套件**并发**，出现 1 条失败
  （`not ok 81 - R9 守卫：墓碑保留 scope，带 scope 对账时不被跳过`，`0 !== 9`）。
  根因是 r3-mutate 会**原地改写源文件再恢复**（X29 变异恰是「describe 不读 indexMeta」，
  与失败测试 #81 完全对应），两进程读写同一文件产生竞态。变异套件结束后
  `git status --short` 仅剩本结论文件、无任何 `.mutation-backup` 残留、
  `git diff -- host-map.js / contract.test.mjs` 为空 → 源文件未被污染；
  **单独重跑 209/209 全绿**。属我方测试编排竞态，非被审代码回归。
- PASS（209/209）

### 5b `node scripts/r3-mutate.mjs /tmp/wp3pre2/mut.log`

- 命令：`cd <repo> && node scripts/r3-mutate.mjs /tmp/wp3pre2/mut.log`
  （脚本位于仓库根 `scripts/`，其 `ROOT` 自解析到仓库根；按任务字面写的 `cd workbench-core && node scripts/r3-mutate.mjs`
  会 `MODULE_NOT_FOUND`，因 workbench-core 下无 scripts/，故从根运行，输出日志按任务指定写到 `/tmp/wp3pre2/mut.log`）
- 输出：`变异定义：36 项`；逐项结果 36 行全部 `CAUGHT`（16 个 `M*` + 20 个 `X*`），
  汇总 `CAUGHT: 36 / VACUUM: 0 / SKIP: 0`，
  `结论：全部保护点都有测试约束（0 真空，0 跳过）`，`exit=0`。
- 旁证：`M11 hostMap 不持久化（只写内存）` → `pass 202 fail 7`，说明 WP3-P1/P7 等脏标记/flush
  守卫测试确实约束了持久化路径（删掉持久化即变红）。
- PASS（36/36 CAUGHT，0 VACUUM，0 SKIP）

---

## 增量复核小结（主会话两条修复是否成立）

| 修复 | 机制 | 独立验证 | 判定 |
|---|---|---|---|
| `load()` 旧格式归一化置脏 | `dirty` 上提到 `load` 之前声明；`needsUpgrade` 由「无 indexMeta 或含字符串值」判定 | C1/C1b/E1/E1b：旧格式标脏并归一化落盘、新格式不误标脏、混合格式也覆盖 | 成立 |
| `prune()` 老化删除置脏 | 老化 `delete` 分支加 `dirty = true`；`flush()` 用 `was` 返回真实写入史 | C2/E2：直接 prune 后显式 flush 落盘、prune→put→flush 一次写、二次 flush 不重复 | 成立 |

- 5 项必验：全部 PASS。
- 3 条额外怀疑路径（新格式误标脏 / 重复写 / indexMeta 残留）：全部排除。
- 未发现 blocker（数据丢失、重复投递、误删、审批旁路）与 nit。

---

# 结论：APPROVE
