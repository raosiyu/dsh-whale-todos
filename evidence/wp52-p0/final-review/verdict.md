REQUEST CHANGES

# WP5.2-P0 最终独立复审 · 裁决

**冻结 commit**：`246e4017d529fb41f5060a95870b6e4281f2964b`
**冻结副本**：`/tmp/wp52-p0-freeze-246e401.regenerated`（原 `/tmp/wp52-p0-freeze-246e401`
已消失，`git archive` 重生成后 tree digest 复算 = `5398ed29dfd92a398dc8ccce548cca80fd6a5de8`，
与题面一致，只读锁定）

## 结论

核心 P0（含冒号 scope 导致重复投递）**对 v2 新记录已修复**，但本轮新增的
**v1→v2 迁移通道引入一个新的 P0：跨 scope 误删旧提醒**。因此 `REQUEST CHANGES`。

## 发现的 P0（blocker）

### B1：v1→v2 迁移通道跨 scope 误删旧记录（破坏 scope 隔离 + 绕过白名单）

**位置**：`workbench-core/src/reminder-sync.js:964`

```js
const wantV2 = reminderIdentity(oldRow.decoded.kind, oldRow.decoded.entityId, scope)
```

迁移闸门用「**当前 reconcile 的 scope**」重编码旧记录身份，而非旧记录自己的 scope。
对 `legacyAmbiguous` 记录（scope/entityId 边界本就不可靠），会把**另一个 scope** 的旧提醒
误判为「本 scope 已有 v2 替代品」→ `schedule.delete` 删除。

**实证**（`probe-cross-scope-delete.log`，独立假 schedule 复现）：
```
旧记录 task:t1（语义=空 scope，identity=wb2.task..dDE）
reconcile(scope="projA") 且 projA 下恰有 entity t1
→ legacyMigrated=1，空 scope 的旧记录被删
```

同时 `task:projA:a:b`（entityId 含冒号、边界丢失）也在匹配到同名 v2 后被删，
`legacyMigrated=1`，与代码注释「含冒号 v1 不删」自相矛盾。

**为何绕过安全层**：
1. `legacyHostRecords` 故意 `void scope` 不做 scope 过滤（`:750`），收集本 session **所有**
   legacyAmbiguous 记录；
2. 迁移删除路径**不查 `createdIdentities` 白名单**（主删除路径 `:881` 查了），直接
   `schedule.delete`；
3. 因此一条「我们从未以该 scope 身份创建过」的旧记录仍会被删。

**影响**：用户某个 scope 的历史提醒被静默删除，属数据丢失，命中裁决标准「旧记录被误删」
→ 必须 `REQUEST CHANGES`。

**为何 fix 自带测试没抓到**：只测了 `task:a::b:t1`（双冒号，解码出的 entityId `:b:t1`
恰对不上任何 v2，走 legacyKept 分支侥幸通过），未覆盖两段 `task:t1`/`task:_:t1` 在
**不同 scope** 下、及 `task:projA:a:b` 单冒号在**同 scope 同 entityId** 下的误删形态。

## 其余审查项（均 PASS，供参考）

- Q1 任意 scope/entityId 往返一致（21×15=315 组合逐字节还原，base64url 不含 `.`）✅
- Q2 无碰撞（空 scope vs `_`；`(a,b:c)` vs `(a:b,c)`）✅
- Q3 v1 三种歧义形态标 `legacyAmbiguous`、`ownershipOf` 判 `suspect`（decode 层正确）✅
- Q4 含冒号/中文/空 scope 连续 3 次 reconcile 只 create 1 次、重启后 create=0 ✅
- Q6 主路径 session 隔离 + 白名单门控 ✅（**迁移路径被 B1 破坏**）

## 修复建议（非本轮改动，仅方向）

迁移闸门 2 的 `wantV2` 必须使用**旧记录自己解出的 scope**（或对 `legacyAmbiguous` 记录
一律不迁移、仅 `legacyKept`），并给迁移删除路径补白名单校验。最保守且无歧义的修复：
**凡 `legacyAmbiguous` 记录一律不删**（当前注释已主张此策略，但代码未遵守），只保留
「无歧义 v1 记录」的受控迁移——而「无歧义 v1 记录」本就不标 `legacyAmbiguous`、
不进 `legacyHostRecords`，因此迁移通道需要重新设计其触发条件。

## 已知残留（非 blocker，必须披露）

v1 坏记录若保留不删，会在到点时与 v2 新记录**各投一次**（历史脏数据固有残留）。
本次裁决不把「仍投一次」当 blocker，但要求报告披露：因 B1 修复方向是「保留更多旧记录」，
残留投递面会增大，需在报告里如实说明。

## UNVERIFIED / 环境限制

- 真实 DSH Host 真机验证本轮未重跑（冻结副本消失、`02-host-verify.md` 与
  `03-host-verify-result.json` 数据自相矛盾：JSON 首轮 `created=0`、`allOk=false`，
  与 .md 声称的「1,0,0 / allOk=true」冲突）。Q4 用假 schedule 独立复现，结论不受影响，
  但真机证据需复核。
- 主仓库 HEAD 在本复审期间从 `246e401` 变为 `5b6aee6`（含一份预置 verdict），
  本裁决不采信该预置结论，以本目录探针实证为准。

## 裁决

**REQUEST CHANGES —— 1 个 P0 blocker（B1：迁移通道跨 scope 误删）。**

在 B1 修复并补上「不同 scope 下 v1 两段/`_`/单冒号记录不得被迁移删除」的回归测试前，
WP5.2-P0 不得关闭。
