# WP5.2 最终独立 Review · Agent A 逐条发现

**审查范围**：提醒所有权白名单 / 误删保护 / 持久化恢复
**冻结副本**：`/tmp/wp52-freeze-e9b2b32`（digest `131e8c74…`，只读）
**探针**：`probe-ownership.mjs` → `probe-ownership.log`
**结果**：`PASS=30 FAIL=0`

> 说明：两次 `subagent_fork` 与一次 `subagent` 在本环境启动即失败（未留下任何文件）。
> 独立性改由「冻结快照 + 独立 node 进程 + 探针脚本 + 不可篡改日志」实现：
> 探针只 import 冻结副本，不碰主仓库业务代码，日志直接落证据目录。

## A1 · 用户伪造完全合法的标记 → 能否误删

| 命令 | 实际输出 | 判定 |
|---|---|---|
| `node probe-ownership.mjs`（A1 段） | 伪造 prompt 尾部 `"… ​⁠[[wb:task:_:victim]]"`；`ownershipOf` → `owned` | 标记**确实不能单独当认证** |
| 同上 | `reconcile: deleted=0 kept=1 observed=0 failed=0` | ✅ 未删 |
| 同上 | `sched.calls.delete.length === 0` | ✅ 一次 delete 都没发起 |
| 同上 | `kept[0].reason === 'never-created-by-us'` | ✅ 白名单是最终防线 |

**结论**：即使标记格式完全合法、含不可见前缀、scope 自洽，
`ownershipOf` 会判 `owned`，但 `reconcile` 的删除前白名单校验会拦住它。
**不存在「伪造标记即可误删」的路径。**

## A2 · 三级分级与 observed 上报

| 场景 | ownershipOf | reconcile |
|---|---|---|
| 无标记 | `foreign` | 保留 |
| 标记格式非法 | `suspect` | 保留 |
| 别的 scope | `suspect` | 保留 |
| 自洽 | `owned` | 进入删除决策（仍受白名单约束） |

实测 `observed` 为 `["foreign","suspect"]`，**不静默**；`deleted=0`，两条都在。

## A3 · 落盘 / 读失败降级

| 场景 | 结果 |
|---|---|
| `save` 抛错 | create 不阻塞（created=1），同进程再对齐仍幂等（unchanged=1） |
| `load` 抛错 | `deleted=0`，记录仍在，进 `kept` → **少删，绝不多删** |
| 白名单里只有 `"*"` | 不能授权删真实 identity（精确 `has` 匹配） |

**边界**：`save` 失败后若进程重启，白名单丢失 → 该提醒变成「删不掉的孤儿」。
这是 `02-delivery.md` §6.5 已明确披露的取舍（留孤儿可恢复，误删不可恢复），
**不是 blocker**。

## A4 · 跨进程恢复与 scope 隔离

| 项 | 输出 |
|---|---|
| 创建后落盘 | `["task:_:t1"]` |
| 全新实例读同一磁盘后对空数据 | `deleted=1`，记录被清理 |
| 删除后白名单 | `[]` |
| 两个 scope 落盘 | `[["task:projA:t1"],["task:projB:t1"]]`（不混） |
| projB 对空数据 | 只删自己的 `f2`；`f1`（projA）被判 `suspect/scope-mismatch` 进 `observed`，**保留** |

> **探针自身纠错记录**：A4.6 初版断言写成 `deleted===0 && rows.size===1`，
> 跑出 FAIL。加诊断探针 `/tmp/diag-a46.mjs` 复核后确认：
> projB **有资格删自己那条**（`deleted=1` 正确），projA 那条留在 catalog。
> **是探针预期写错，不是产品缺陷**。已修正断言并重跑，30/30 PASS。
> 这条如实保留，避免把「探针错误」包装成「审查发现问题」。

## A5 · 截断与格式演进

| 项 | 结果 |
|---|---|
| 3000 字正文 + 标记 | 截断到 2000，标记仍完整，`identityOfHostRecord` 仍解出 `task:_:t1` |
| `decodeIdentity('task:t1')` | 兼容旧两段格式 → `{kind:'task', scope:'', entityId:'t1'}` |
| WP5.1 旧格式（无不可见前缀） | 判 `foreign` → 保留孤儿 |

旧格式记录永远清不掉，属已披露取舍（§6.5），**不是 blocker**。

## 严重度汇总

| 级别 | 数量 | 内容 |
|---|---|---|
| P0 blocker | **0** | 无误删、无白名单绕过、无越权删除 |
| P1 | 0 | — |
| P2 已披露取舍 | 2 | 落盘失败/旧格式记录变孤儿（§6.5） |
| 探针自身问题 | 1 | A4.6 初版断言错误，已修正并重跑 |
