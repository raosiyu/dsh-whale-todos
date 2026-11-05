# WP2 增量独立 Review（`368207b..d6cc887`）

## 结论：**有条件通过（由主会话复核，非独立 Agent 结论）**

> ⚠️ 流程事实：派出的独立 Review Agent 跑完了 7 组探针，但**在写出结论文件前中断**
> （`list_agents` 中已消失，`02-*.md` 未产出）。按 WP3 授权的
> 「审查失败或中断不得标记 APPROVE」，**不把本次当作独立 Review 的 APPROVE**。
> 它的探针与输出留在 `/tmp/wp3pre/`，是**一手证据**；主会话据此逐条复核、修复、补测试。

## 审查范围（严格增量）

`git diff 368207b..d6cc887 -- workbench-core/src/host-map.js`
（7 处：`indexScopes`→`indexMeta`、load 兼容、老化判龄、prune 写 indexMeta、
flush 返回值、describe、remove/removeByHostId 同步维护）。
其余 36 文件为文档/证据/测试/变异定义，不改变运行时行为。

## 探针验证表（Agent 的 `/tmp/wp3pre/probe.stdout.log`）

| 组 | 项 | 初判 | 复核 |
| --- | --- | --- | --- |
| P1 | 旧格式兼容（身份、scope、墓碑反查） | P1.1–P1.6 PASS | ✅ 通过 |
| P1 | **P1.7 落盘升级为 indexMeta** | **FAIL**（`indexMeta=undefined`） | ✅ **已修** |
| P1 | **P1.8 旧字段 indexScopes 不再写出** | **FAIL**（仍写出） | ✅ **已修** |
| P2 | 墓碑老化生效（fireAtMs 从 indexMeta 取） | P2.1–P2.6 全 PASS | ✅ 通过（复审 N-1 修复点成立） |
| P3 | `fireAtMs===0` 保守跳过 | P3.1–P3.4 全 PASS | ✅ 通过（不会误删身份） |
| P4 | describe 返回真实 fireAtMs / scope | P4.1–P4.3 PASS | ✅ 通过；P4.4 明确 `upsert` 时刻比较取 catalog 行的 `Date.parse(scheduledAt)`，**不受 describe 影响，无回归** |
| P5 | flush 返回值 | P5.1–P5.7 全 PASS | ✅ 通过 |
| P6 | remove / removeByHostId 清 indexMeta | P6.1–P6.9 全 PASS | ✅ 通过 |
| P7 | **老化时 entries/index/indexMeta 同步删除** | **P7.1–P7.5 FAIL** | ✅ **已修** |

## 两条 FAIL 的根因与修法（主会话复核确认）

**同源缺陷**：`load()` 与 `prune()` 修改了内存状态，却**没有 `persist()` 置脏**。
`flush()` 的语义是「dirty 才写」，于是显式 `flush()` 写不下去；生产路径里
`put()` 紧跟 `persist()` 掩盖了这一点。

- `load()`：旧格式读入后归一化成 `indexMeta` 内存结构，但磁盘仍是 `indexScopes`
  → 旧字段永久残留、每次读都做转换。
- `prune()`：老化删除 `index`/`indexMeta`/`entries` 后不置脏 → 直接调 `prune()`
  再 `flush()` 时磁盘无变化。

修法（`workbench-core/src/host-map.js`）：
1. `dirty` 声明提前到 `load()` 之前，供 `load`/`prune` 共用；
2. `load()` 检测到旧格式（`indexMeta` 缺失或值为字符串）时置 `dirty = true`；
3. `prune()` 老化删除命中时置 `dirty = true`。

复核证据：`node /tmp/wp3pre/probe.mjs` 重跑后 **P1.7/P1.8/P7.1–P7.5 全部转 PASS**（无 FAIL 行）。

## 新增守卫测试

`workbench-core/test/contract.test.mjs`：
- `WP3-P1 守卫：旧格式 indexScopes 读入后归一化落盘（不留旧字段）`
- `WP3-P7 守卫：prune 的老化删除可被显式 flush 落盘`

## 回归结果（主会话实测）

| 项 | 结果 |
| --- | --- |
| `node --test test/*.test.mjs` | **209 / 209 pass，0 fail** |
| `node scripts/r3-mutate.mjs` | **36 / 36 CAUGHT，0 VACUUM，0 SKIP** |
| `bash scripts/wp2-r5-gate.sh` | 8/8 PASS |
| `node scripts/probes/p1-real-storage-domain.mjs` | PASS |
| `node scripts/probes/p3-retention.mjs` | PASS |

## 是否阻断 WP2 条件验收

**否。** 两条 FAIL 是「显式 flush 与格式升级」的一致性缺陷，**不影响读取正确性**
（旧格式读取兼容、老化仅在 put 路径触发时生产行为正确）；已修复并有测试锁定。
增量本身未引入数据丢失、重复投递、审批旁路。

## 诚实边界

- 本次**不是独立 Agent 的 APPROVE**：Agent 中断，结论由主会话据其探针复核得出。
- 若用户要求「必须取得独立 Review 的明确结论」，需**重派一次**并强制即时写文件。
- WP2 的 UNVERIFIED 项（macOS 系统级、真实投递回执、多进程并发、exactly-once）
  一律保留，不因本次增量复核而变更。

## 复核命令

```bash
node /tmp/wp3pre/probe.mjs
cat /tmp/wp3pre/probe.stdout.log
cd /Users/sylas/Developer/dsh-workbench/workbench-core && node --test test/*.test.mjs
```
