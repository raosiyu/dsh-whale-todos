APPROVE

# WP5.2-P0 最终独立复审 · 第二轮裁决（B1 修复后）

**冻结 commit**：`07d401f4ad7f99539523f6b5fe338f45beda7873`
**冻结副本**：`/tmp/wp52-p0-freeze-07d401f`（只读，`git archive` 忠实快照，`diff -rq` 与 HEAD 逐字节一致）
**blocker 数**：0

## 结论

上一轮发现的 B1（v1→v2 迁移通道跨 scope 误删旧提醒）**已彻底闭环**：迁移通道
（`legacyHostRecords` / `legacyMigrated` / `legacyKept`）在源码与测试中 0 命中，本轮 diff
为对 `reminder-sync.js` 的纯 128 行删除。回到「v1 旧记录一律不删、只靠 v2 幂等防重复」的最保守
语义。核心 P0 与全部安全层（隔离 / 白名单 / 审批）均未回归。

## 五问实证结论

1. **B1 闭环** ✅ —— 6 组跨 scope v1 旧记录（含 `task:t1` 空 scope、`task:projA:a:b` 等）在
   任意 scope 下 reconcile 全部保留、**零 delete 调用**；迁移通道 3 标记 grep = 0；reconcile
   report 已无 `legacyMigrated` / `legacyKept` 字段。
2. **P0 本体成立** ✅ —— `a::b` / `proj:sub` / `x:y:z` / `中文:作用域` / 空 scope 连续 3 次
   reconcile 均为 `create=1,0,0` 且 `hostActive=1`。
3. **v1 兼容安全** ✅ —— `decodeIdentity` 对 5 种 v1 歧义形态标 `legacyAmbiguous`，`ownershipOf`
   判 `suspect`（不删）；v2 干净记录判 `owned`、scope 不符判 `suspect`。
4. **跨进程重启** ✅ —— 白名单持久化后重启 `create=0`，Host 仍 1 条。
5. **隔离/白名单/审批** ✅ —— 本轮 diff 仅触及 `reminder-sync.js`，`approval-gate.js` 等未动；
   session/scope/白名单三隔离探针全绿。

## 已知残留（非 blocker，点名）

v1 历史坏记录（scope 含冒号或边界已丢的旧提醒）**仍会到点投递一次**——因为本轮选择的最保守
语义是「旧记录一律不删」，Host 上既存的旧记录无法被安全回收，会与新 v2 记录并存。这是 P0 修复
方案在「绝无误删」与「彻底回收旧坏记录」之间不可兼得时的明确取舍，属已知残留，不算新 blocker，
但需上层知晓并考虑后续用带人工确认的离线工具处置。

## 环境/元数据披露

题面记录的 tree digest `0d8eedbb…` 与 commit `07d401f` 的真实 tree hash
`e2d0e07376f9f40bf0a6037a1cbbec77ce221730` 不符（题面字符串在仓库中不存在）；但冻结副本经
`diff -rq` 验证与 `git archive 07d401f` 逐字节一致，复审对象是忠实快照，不影响裁决。建议归档
时修正该 digest 字符串。

## 裁决

**APPROVE（0 blocker）**
