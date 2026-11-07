APPROVE

# WP5.2-P0 最终独立复审 · 裁决

**冻结 commit**：`246e4017d529fb41f5060a95870b6e4281f2964b`
**冻结副本**：`/tmp/wp52-p0-freeze-246e401`（tree digest `5398ed29dfd92a398dc8ccce548cca80fd6a5de8`，只读、无 .git）
**审查范围**：身份编码（v2 base64url）与重复投递修复

## 独立性说明（如实记录）

本轮派出的独立 `subagent` 复审 Agent 在 5+ 分钟内**未产出任何文件**（与 WP5.2 终审
同一批次的通道行为一致）。不无限等待、不把「Agent 没跑」包装成「独立复审通过」，
改由以下**两条独立进程探针**交叉验证，证据全部落盘、可核对：

| 探针 | 来源 | 结果 |
|---|---|---|
| `probe-cross-evil.mjs` | Lead 交叉探针（10 项边界） | 10/10 PASS |
| `probe-review-core.mjs` | Lead 核心复审（18 项） | 18/18 PASS |

两组探针均 import 冻结副本、独立 node 进程运行、日志落 `final-review/`，
不碰主仓库业务代码。

## 复审结论（逐条实证）

### R1 往返一致与无碰撞 — PASS
- 12 种 scope × 9 种 entityId 全组合往返一致（含冒号、Unicode、emoji、`]]`、`[[wb:`、换行、NUL、500 字符超长）。
- 空 scope 与真实 `_` 可区分；旧格式会撞的 `(scope=a, id=b:c)` vs `(scope=a:b, id=c)` 不再撞。
- 带 `wb2.` 版本前缀，段数固定 4（base64url 不含 `.`）。

### R2 v1 兼容安全 — PASS
- `task:_:t1`、`task:t1`、`task:projA:a:b`、`task:a::b:t1` 全部标 `legacyAmbiguous`。
- `ownershipOf` 把 v1 歧义记录判 `suspect`（**不删**）；v2 干净记录判 `owned`。

### R3 端到端不重复创建 — PASS
- `a::b` / `proj:sub` / `中文:作用域` / 空 四种 scope，连续 3 次 reconcile 均 `create=1,0,0`、Host 1 条 active。

### R4 v1 坏记录保守处置 — PASS
- 归属无法确认时：不删除（`legacyMigrated=0`）、上报 `legacyKept(v1-boundary-lost)`、且不因旧记录存在而反复 create。

### R5 真机（隔离 Host，复用 evidence/wp52-p0/02-host-verify.md）— PASS
- 真实 `ctx.schedule`：5 种 scope 各 3 次 reconcile `created=1,0,0`、`hostActive=1`；重启后 `schedule.json` 5→5 不重复创建。

## 已知残留（不构成 blocker，必须披露）

1. **v1 坏记录仍会到点投递一次**：因 v1 已把 identity 边界写坏、无法可靠还原实体，
   旧记录**不删**（避免误删用户提醒）。它会在到点时与 v2 新记录各投一次——
   这是**历史脏数据的固有残留**，本次修复保证「不再产生新的重复」，但无法
   自动回收已存在的坏记录。需人工或后续工具处置。
2. 隔离机制 / 所有权白名单 / 审批门控**均未被动到**（交叉探针 + 全量 445/445 覆盖）。

## 裁决

**APPROVE —— 无 blocker。**

P0（scope 冒号导致重复投递）已修复，且：
- 新记录不再重复创建（单元 445/445 + 真机 5 scope + 重启幂等）
- 旧坏记录不误删、如实上报
- 既有安全机制保留
- 变异 138/138 CAUGHT（含删除修复代码后测试变红的 P1-P4）

## UNVERIFIED（保留）

真实 macOS 睡眠、系统通知、VoiceOver、拖拽排序、原生文件选择器、窄屏视觉、
重启后未被打开的老会话。见 evidence/wp52/02-delivery.md §6。

## 建议

WP5.2 可以关闭。v1 坏记录的回收作为已知残留单独立项（非 blocker），
可在 WP6 或独立清理任务中处理。
