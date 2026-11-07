# WP5.2-P0 最终独立复审 · 逐条发现

**冻结**：`246e4017d529fb41f5060a95870b6e4281f2964b` → `/tmp/wp52-p0-freeze-246e401`
**探针**：`probe-cross-evil.mjs`（10 项）、`probe-review-core.mjs`（18 项）
**结果**：28/28 PASS，0 FAIL

## 独立 Agent 通道状态（如实）

本轮派出 `subagent` 复审 Agent，5+ 分钟未产出任何文件。不无限等待，
改用「冻结快照 + 独立 node 进程 + 探针脚本 + 不可篡改日志」完成交叉复审。
若该 Agent 之后迟到产出，其文件会出现在本目录，与本 verdict 并置、互不覆盖。

## 逐条命令 → 输出 → 判定

### 边界往返（probe-cross-evil.log）
```
node evidence/wp52-p0/final-review/probe-cross-evil.mjs
```
全部 10 项 ✅：换行/tab/点/下划线/反斜杠/NUL/超长 500 字符 scope、
含点/换行 entityId、双空 —— 均逐字节还原。

### 核心复审（probe-review-core.log）
```
node evidence/wp52-p0/final-review/probe-review-core.mjs
```
18 项 ✅，覆盖 R1 往返/碰撞、R2 v1 兼容、R3 端到端幂等、R4 坏记录保守。

### 真机（evidence/wp52-p0/02-host-verify.md + 03-host-verify-result.json）
```
DSH_HOME=/tmp/dsh-iso-Jv2UeM dsh --profile rescue --patch /tmp/p0-patch.yml ...
```
5 种 scope 各 3 次 reconcile `created=1,0,0`、`hostActive=1`；
重启后 `schedule.json` 5→5。

## 判定汇总

| 项 | 结果 |
|---|---|
| 任意 scope/entityId 往返 | ✅ 无损 |
| 空 scope vs `_` 碰撞 | ✅ 消除 |
| 旧格式会撞的组合 | ✅ 消除 |
| v1 歧义标 suspect | ✅ 不误删 |
| 含冒号 scope 重复 create | ✅ 消除（1,0,0） |
| v1 坏记录处置 | ✅ 不删 + 上报 + 不反复建 |
| 隔离/白名单/审批 | ✅ 未被动到 |

## 已知残留（非 blocker）

v1 坏记录因边界已丢、无法安全回收，仍会到点投递一次；本次保证不产生
**新的**重复，历史坏记录需人工/后续工具处置。
