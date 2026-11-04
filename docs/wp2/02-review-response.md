# WP2 独立 Review 响应：REQUEST CHANGES → 全部修复

Review 结论：**REQUEST CHANGES**（2 BLOCKER / 6 MAJOR / 6 MINOR-NIT）
处理结果：**逐条复现 → 逐条修复 → 逐条回归测试锁定**
最终：测试 **142 / 142 pass**，demo EXIT 0

## 一、先说最重要的一句

Reviewer 是对的，而且抓到的是**我报告里写错了的承诺**。

我在报告 §2.1 / §2.5 写了「重复对账不产生重复提醒」「重启恢复幂等」「避免醒来被 N 条历史提醒轰炸」。
这些**只在 memory 后端成立**；真实 host 后端每次重启都会多注册一条同 key 提醒，到点各投一次。
三场景证据全部用 memory 后端，**完全没覆盖这条路径**——这是测试盲区，不是偶发 bug。

我接受这个判定，没有辩解。

## 二、BLOCKER（2/2 已修）

### B1. host 后端 list() 不读宿主 → 每次重启多注册一条

| 项 | 内容 |
| --- | --- |
| 复现 | `scripts/wp2-check-b1.mjs` → 修复前：三次重启宿主侧 1→2→3 条，同 key 同时刻 |
| 根因 | `createHostBackend.list()` 只读内存 `recordByKey`，**从没调用 `hostSchedule.list()`**（该方法被校验为必需却成了死参数） |
| 修法 | `list()` 改为**以宿主为准**：读 `hostSchedule.list()`，用行上的 `key` 重建 `key→id` 映射并回填内存；宿主不回 key 时按 `title+scheduledAt` 生成合成键（`host:<sha256>`），保证「同一条提醒两次读到同一个键」 |
| 回归 | `host 后端：跨进程重启不重复注册（B1 回归）` |
| 现状 | ✅ 三次重启宿主侧恒为 1 条 |

### B2. 宽限期把「已投递」的提醒重新注册

| 项 | 内容 |
| --- | --- |
| 复现 | `scripts/wp2-check-b2.mjs` → 修复前：投递出队后 30 秒重启，`restored=1`，重新注册 `at=12:00`（**过去时刻**） |
| 根因 | 恢复逻辑只有时间比较，**没有「是否已投递」判定**。宿主「投递即出队」，于是已投递在恢复眼里就是「缺失 → 补建」 |
| 修法 | 两层：① 恢复前先读 `adapter.history()`，把出现过的 reminderKey 记为 `alreadyDelivered` 并跳过；② 宽限期内确实要补建的，**把 `fireAtMs` 钳到 `atMs + 1000`**，不把过去时刻交给宿主 |
| 附带修 | `host.historyList()` 原先把行映射成 `key: row.scheduleId ?? ''`，**丢掉 reminderKey** → 恢复判不出已投递。改为优先用行上的 `key`，否则用 `hostId → reminderKey` 反查 |
| 回归 | `host 后端：投递后再重启不重建（B2 回归）`、`host 后端：宽限期内补建的提醒，触发时刻被钳到未来` |
| 现状 | ✅ 已投递不再重投；补建时刻恒在未来 |

## 三、MAJOR

| # | 问题 | 状态 | 说明 |
| --- | --- | --- | --- |
| M1 | 等长 ICS 复用审批凭证 | ✅ **fae46c0 上成立，`9591ec1` 已修** | Reviewer 复验 HEAD 已被 `fingerprint-mismatch` 拦下；我的自我披露属实 |
| M2 | fae46c0 上合法调用姿势反而失败 | ✅ 同一根因，已修 | `requestApproval({text})` 现在从内容算摘要，正常姿势即可过审 |
| M3 | `reconcile` 不读 `opts.scope`，跨 scope 互相清空 | ✅ 已修 | `reconcile` 增加 `inScope()` 前缀过滤；不给 scope 时保持全量语义（向后兼容） |
| M4 | `compileReminder` 的 null 契约没实现 | ✅ 已修 | 增加 `nowMs` 参数并真正判过期；三个调用点都传入 `now()` |
| M5 | `planForEvents` 静默吞异常 | ✅ 已修 | 返回的 plans 上挂 `skipped: [{eventId, reason}]`（不可枚举，不破坏既有 `length` 语义） |
| M6 | 恢复没有投递历史概念 | ✅ 部分修 | 现在**有**「拿得到 history 就用它」的分支（B2 修复即此项）；history 不可用时降级为纯时间判定，并在返回值里给 `historyAvailable` 标志 |

M5 补充：Reviewer 指出的「1990 起 DAILY 触发 8000 次迭代上限」是 WP1 就有的行为，**不是 WP2 引入**；但「吞异常且零可观测」是 WP2 的写法问题，已修。

## 四、MINOR / NIT

| # | 问题 | 状态 |
| --- | --- | --- |
| N1 | `service.approvalGate` 暴露，isolated 下模型可自签 | ✅ 已修：**从返回对象移除 `approvalGate`**，调用方只能走 `requestApproval()`；同时纠正了 gate 里的威胁模型注释（nonce 防「构造 token」，不防「拿到 gate 实例」） |
| N2 | `consumed` 只增不减，注释与实现不符 | ✅ 已修：新增 `pruneConsumed(keep=1000)`，注释改为与实现一致 |
| N3 | `ids.join(',')` 指纹歧义（`['a,b']` vs `['a','b']`） | ✅ 已修：改为**长度前缀编码**（`len:value|...`），字段边界无歧义 |
| N4 | `store.rollback` 指纹只绑 `'latest'` → TOCTOU | ✅ 已修：先列 pre 备份，校验目标存在，**指纹绑定具体备份名** |
| N5 | `approvalRequiredError` 死代码 | ✅ 已删（含 `index.js` 的导出） |
| N6 | 报告里 96 / 93 两个基准混在相邻行，读起来矛盾 | ✅ 已修：见下文明细 |

## 五、关于 N6：测试数量的准确口径

Reviewer 说得对，我原报告两个数字基准不同却写在一起。准确事实：

| commit | 测试数 | 变化来源 |
| --- | --- | --- |
| `d43326a`（WP1-6 收尾） | 93 | WP1 交付 |
| `cebced2`（WP2-0） | 96 | +3：RRULE 月末两条策略 + 非法策略拒绝 |
| `f1fb509`（WP2-1） | 133 | +37：审批门/调度/恢复 |
| 本响应提交 | **142** | +9：跨重启回归、scope 回归、M4/M5 回归、攻击回归等 |

**「+37」只对 `cebced2 → f1fb509` 成立**，不是对 WP1 的 93。

## 六、Review 指出的流程问题（我接受）

1. **审查对象在漂移**：Reviewer 审查期间 HEAD 前进 5 次，导致「按指定范围是 blocker、按 HEAD 已修」的判读歧义。**这是我的流程错误**——应先冻结 commit 再派审查。本响应文档提交后，后续审查一律以该 commit 为唯一基准。
2. **三场景证据不可复跑**：`01-scenarios.log` 原先没有生成脚本。**已修**：脚本落盘为 `scripts/wp2-scenarios.mjs`（仓库内相对路径），并重新生成日志。

## 七、修复后复跑证据

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量测试 | `cd workbench-core && node --test test/*.test.mjs` | **142 / 142 pass，0 fail，0 skip** |
| 功能演示 | `node demo/demo.mjs` | EXIT 0 |
| 三场景 | `node scripts/wp2-scenarios.mjs` | 三场景全 ✅（见 `evidence/wp2/01-scenarios.log`） |
| B1 回归 | `node scripts/wp2-check-b1.mjs` | ✅ 三次重启宿主侧恒 1 条 |
| B2 回归 | `node scripts/wp2-check-b2.mjs` | ✅ 未重投，补建时刻在未来 |
| 审批攻击 | 四类攻击（payload confirmed / 重放 / 篡改 target / 等长内容） | ✅ 4/4 拦下 |

## 八、仍未闭环（不掩盖）

1. **真实宿主 delivery history 不可读**：本会话无对应工具。因此「只投递一次」的严格证明仍只在适配器层；宿主层只验证到「入站投递物 id/时刻匹配」。
2. **真实 OS 挂起/休眠未测**：三场景用固定基准模拟，非真实系统睡眠。
3. **多进程并发写未覆盖**。
4. **独立 Review 的第二轮**：本轮 Review 结论已逐条处理，但**修复后尚未再派一轮复审**。按 N6 的教训，复审应在冻结 commit 后进行。

## 九、我这一轮的自我判定

Review 判 REQUEST CHANGES 是**准确的**。我第一次交付时把「memory 后端成立」当成了「整体成立」，这是**证据覆盖不足却当成交付完成**——属于我自己的红线问题（空口完成），不是 Reviewer 苛刻。

已修的不是文档措辞，是代码与测试：两条跨重启回归测试是这次最实的产出，它们正是原先完全缺失的盲区。
