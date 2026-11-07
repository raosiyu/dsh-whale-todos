# WP5.2-P0 最终独立复审 · 逐条发现

**冻结**：`246e4017d529fb41f5060a95870b6e4281f2964b`
**冻结副本**：原 `/tmp/wp52-p0-freeze-246e401` 在本轮开始时已从 `/tmp` 消失，故由
`git archive 246e401` 重新生成至 `/tmp/wp52-p0-freeze-246e401.regenerated`，
tree digest 复算 = `5398ed29dfd92a398dc8ccce548cca80fd6a5de8`（与题面记录的
冻结 digest 完全一致，证明是同一棵树的忠实快照），随后 `chmod -R a-w` 只读锁定。

**本复审探针**（全部 import 冻结副本，独立 node 进程，日志落本目录）：
- `probe-roundtrip.mjs` → `probe-roundtrip.log`
- `probe-v1-migration.mjs` → `probe-v1-migration.log`
- `probe-cross-scope-delete.mjs` → `probe-cross-scope-delete.log`
- `probe-core-fix.mjs` → `probe-core-fix.log`
- `probe-v1-decode.log`（内联探针输出）

---

## Q1 任意 scope/entityId 往返一致 + base64url 不含 `.`

命令：`node probe-roundtrip.mjs`

输出（节选）：
```
✅ 任意 scope 编码产物不含 .（分段分隔符安全）
✅ 全组合 21×15=315 往返一致
✅ 段数固定为 4
PASS 10  FAIL 0
```

判定：**PASS**。21 种 scope（含 `a::b`、`proj:sub`、`_`、空、中文、emoji、`]]`、
`[[wb:`、换行、tab、NUL、500 字符超长、前后空格）× 15 种 entityId（含冒号、换行、
NUL、`[[wb:fake]]`、零宽字符）全组合逐字节还原，无漏网。base64url 产物确实不含 `.`。

## Q2 无碰撞

命令：`node probe-roundtrip.mjs`

输出（节选）：
```
✅ 空 scope 与真实 "_" 身份不同
✅ v2 中 (scope=a,id=b:c) 与 (scope=a:b,id=c) 身份不同
✅ (a:b, c) 解码 scope=a:b id=c
```

判定：**PASS**。空 scope（`wb2.task..dDE`）与真实 `_`（`wb2.task.Xw.dDE`）不再撞车；
旧格式会撞的 `(scope=a,id=b:c)` vs `(scope=a:b,id=c)` 在 v2 下彻底分离。

## Q3 v1 兼容安全（decodeIdentity / ownershipOf）

命令：`node probe-v1-decode.log`（内联探针）

输出：
```
"task:_:t1"        → legacyAmbiguous=true, ownershipOf=suspect (legacy-identity-ambiguous)
"task:t1"          → legacyAmbiguous=true, ownershipOf=suspect (legacy-identity-ambiguous)
"task:projA:a:b"   → legacyAmbiguous=true, ownershipOf=suspect (legacy-identity-ambiguous)
"task:a::b:t1"     → legacyAmbiguous=true, ownershipOf=suspect (legacy-identity-ambiguous)
"event-start:_:e1" → legacyAmbiguous=true, ownershipOf=suspect (legacy-identity-ambiguous)
v2 (projA,t1)      → owned（不受误伤）
```

判定：**PASS**。三种 v1 歧义形态全部标 `legacyAmbiguous`，`ownershipOf` 判 `suspect`（不删）。
`decodeIdentity` 与 `ownershipOf` 这一层是安全的。**但见 Q5 —— 迁移通道绕过了这层保护。**

## Q4 端到端不重复创建

命令：`node probe-core-fix.mjs`

输出：
```
✅ scope="a::b": created=1,0,0 且 Host 仅 1 条
✅ scope="proj:sub": created=1,0,0 且 Host 仅 1 条
✅ scope="x:y:z": created=1,0,0 且 Host 仅 1 条
✅ scope="中文:作用域": created=1,0,0 且 Host 仅 1 条
✅ scope="": created=1,0,0 且 Host 仅 1 条
✅ 重启后 created=0 且 Host 仍 1 条
```

判定：**PASS**。含冒号/中文/空 scope 连续 3 次 reconcile 只 create 1 次，跨进程重启后
create=0。核心 P0（重复投递）**对 v2 新记录确实已修复**。

## Q5 v1 坏记录处置 —— ❌ 发现 P0

命令：`node probe-v1-migration.mjs` / `node probe-cross-scope-delete.mjs`

输出（`probe-cross-scope-delete.log`）：
```
created        = 1
legacyMigrated = 1 （>0 表示旧记录被迁移删除）
旧记录(task:t1, 空scope) 是否被删 = true
本轮真正创建的是 = wb2.task.cHJvakE.dDE     （projA 的 v2）
被删旧记录本应属于 = wb2.task..dDE          （空 scope）
结论：跨 scope 误删 = 是 ❌
```

判定：**FAIL（P0）**。迁移通道在 `reminder-sync.js:964`：

```js
const wantV2 = reminderIdentity(oldRow.decoded.kind, oldRow.decoded.entityId, scope)
```

用**当前 reconcile 的 scope**（而非旧记录自己的 scope）重编码，然后 `liveV2.has(wantV2)`
命中就 `schedule.delete`。对 `legacyAmbiguous` 记录（scope/entityId 本就不可靠），这会把
**另一个 scope** 的旧记录误删：

1. **跨 scope 误删**：两段 v1 记录 `task:t1`（语义 = 空 scope）在 reconcile `scope="projA"`
   时被删 —— 因为 projA 下恰有同 id 实体 `t1`。空 scope 的提醒被静默删除。
2. **边界已丢记录被删**：`task:projA:a:b`（entityId 含冒号，边界丢失）在 reconcile 匹配到
   同名 v2 后被删，`legacyMigrated=1`，与代码注释「含冒号 v1 不删」自相矛盾。
3. **白名单绕过**：迁移删除路径不查 `createdIdentities`（主删除路径在 `:881` 查了），
   直接 `schedule.delete`。空 scope 的 identity `wb2.task..dDE` 从未登记，仍被删。

根因：`legacyHostRecords` 故意**不做 scope 过滤**（`void scope`，`:750`），收集本 session
**所有** legacyAmbiguous 记录；迁移闸门 2 却用当前 scope 重编码 → 把「别的 scope 的旧记录」
误判成「本 scope 已有 v2 替代品」。

**为何现有测试没抓到**：fix 自带的测试（`reminder-sync-wp51.test.mjs:1007`）只测了
`task:a::b:t1`（双冒号、entityId 带前导 `:`）这一种边界，该 case 解码出的 entityId
`:b:t1` 恰好**对不上**任何 v2，于是走了 legacyKept 分支、侥幸通过。它没有覆盖：
`task:t1`（两段/空 scope）在**不同 scope** 下 reconcile、`task:_:t1` 在**不同 scope** 下、
`task:projA:a:b`（单冒号）在**同 scope 同 entityId** 下 —— 这些正是误删触发的形态。

## Q6 隔离 / 白名单 / 审批门控

命令：`node probe-core-fix.mjs`

输出：
```
✅ session 隔离：s2 reconcile 不删 s1 的记录
✅ 白名单门控：未登记 identity 的可疑记录不被删（kept）
```

判定：**主路径 PASS**，但**迁移路径破坏跨 scope 隔离**（见 Q5）。`ownHostRecords` 按
sessionId 过滤正常、主删除路径白名单门控正常、审批门控未在本文件改动。缺陷集中在
新增的 `legacyHostRecords` + 迁移段。

---

## 证据完整性披露（非代码缺陷，但必须记录）

1. **`03-host-verify-result.json` 与 `02-host-verify.md` 矛盾**：JSON 记录每 scope 首轮
   `created=0`、`allOk=false`；而 .md 声称「created=1,0,0」「首次 allOk=true」。
   已核实 `probe-host-verify.mjs` 的判据 `rounds[0].created === 1` 与 JSON 数据冲突。
   这属于**证据自相矛盾**，不影响 Q4 的独立结论（我用假 schedule 独立复现了 1,0,0），
   但真机证据的可信度存疑，应复核。
2. **冻结副本消失**：题面给的 `/tmp/wp52-p0-freeze-246e401` 在本轮开始时已不在 `/tmp`
   （`/tmp` 是 `private/tmp` 的符号链接，两个路径都 `No such file or directory`）。
   已通过 `git archive` 重生成并 digest 校验一致。
3. **主仓库 HEAD 移动**：本复审期间 HEAD 从 `246e401` 变为 `5b6aee6`（"最终独立复审：
   APPROVE（0 blocker）"），该提交自带一份 `verdict.md`，声称本复审 Agent「5+ 分钟未产出」。
   本报告**不采信**那份 verdict，以本目录探针实证为准。

---

## 判定汇总

| 项 | 结果 |
|---|---|
| 任意 scope/entityId 往返 | ✅ 无损（315 组合） |
| 空 scope vs `_` 碰撞 | ✅ 消除 |
| 旧格式会撞的组合 | ✅ 消除 |
| v1 歧义标 suspect（decode/ownershipOf 层） | ✅ 正确 |
| 含冒号 scope 重复 create | ✅ 消除（1,0,0 + 重启 0） |
| **v1 坏记录处置（迁移通道）** | ❌ **跨 scope 误删（P0）** |
| 隔离/白名单（主路径） | ✅ 正常 |
| **隔离（迁移路径）** | ❌ **破坏跨 scope 隔离（P0）** |
