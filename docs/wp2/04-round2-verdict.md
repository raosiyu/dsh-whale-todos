# WP2 第二轮独立 Review — 结论

**结论：REQUEST CHANGES**

| 项 | 内容 |
| --- | --- |
| 审查基准 | commit `72e09ef`（已冻结） |
| 冻结副本 | `/tmp/wp2-freeze-72e09ef`（`git archive 72e09ef` 纯快照，无 `.git`，714 文件） |
| 冻结完整性 | `diff -rq` 副本 vs `72e09ef` → **逐字节一致** |
| 冻结期间仓库 | `HEAD` 恒为 `72e09ef`；**已跟踪文件零改动**（`git diff --name-only` 为空） |
| 唯一污染 | 新增未跟踪文件 `docs/wp2/03-round2-issues.md`（本清单本身，未提交、未改任何既有代码） |

## 一、基线复跑（我在冻结副本内自己跑）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 单元/集成测试 | `cd workbench-core && node --test test/*.test.mjs` | **142 / 142 pass，0 fail，0 skip** |
| 功能演示 | `node workbench-core/demo/demo.mjs` | **EXIT 0** |
| 三场景 | `node scripts/wp2-scenarios.mjs` | 9/9 ✅ |
| B1 跨重启 | `node scripts/wp2-check-b1.mjs` | ✅ 不重复 |
| B2 防重发 | `node scripts/wp2-check-b2.mjs` | ✅ 未重投 |

## 二、用户点名 7 项，逐项结论

| # | 要求 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 冻结代码，Review 期间禁止改 HEAD | ✅ 做到 | HEAD `72e09ef` 恒定；tracked-modified = 0；快照逐字节一致 |
| 2 | 独立 Agent 只读审查 | ✅ **已取得结论**（后续回传） | 复审 Agent 报回 REQUEST CHANGES，1 新 blocker + 多条 major，诊断脚本 `/tmp/wp2rev2/exp1..exp27`。**它抓到的比我自己的结论更重**——见 `03-round2-issues.md` 追加部分 |
| 3 | 复跑 142 测试与 B1/B2 | ✅ 做到 | 见上表（均在冻结副本内） |
| 4 | 跨重启去重 / 防重发 / 跨 scope / 审批安全 | ✅ 全过 | b1/b2 脚本；`/tmp/wp2lead/named-items.mjs`（scope 隔离、4 类伪造全拒、重放被拒、`approvalGate` 已不暴露） |
| 5 | `title+at` 备用键是否误合并 | ❌ **发现真缺陷** | 见下节 R2-1 / R2-2 / R2-3 |
| 6 | 无真实投递历史时标 UNVERIFIED | ✅ 已遵守 | 文档中 `exactly-once` 类断言 **0 处**；报告 R2 行明写「host 投递 history 未直接读到」 |
| 7 | 区分模拟与真实 macOS 验收 | ✅ 已区分 | 报告 R4：「休眠/退出用固定基准模拟，非真实系统睡眠，需 WP7 实机验收」 |

## 二之二、复审追加发现，最重一条：**host 后端从未真正接通**

复审 Agent 从 `app.asar` 读出一手源码，我用同源代码逐条核实：

| 真实契约 | 我的适配器 | 后果 |
| --- | --- | --- |
| `create(sessionId, request, signal)`，`at` 需 RFC3339 **字符串** | `create({at: number})` 单参 | 真实宿主下 **TypeError，一条都建不成** |
| `list({sessionId})`，返回 record，**无 `key`** | `list()` 无参 | 抛错被 `catch` **静默吞** → 退回内存视图 → B1 修复失效（5 次重启 1→2→3→4→5） |
| `history({sessionId,id,limit∈[1,100]})` 单任务分页 | `history()` 无参 | 抛错 + `length>=0` 恒真 → `historyAvailable` 谎报 true → B2 失效 |
| `delete({id, sessionId})` | `remove(id)` | 形状不符 |
| `catalog()` 无参，返回全部含 status | 未使用 | 丢失了最合适的对账数据源 |

**这是本轮最重要的结论**：我在两轮修复里两次宣布「B1/B2 已修」，两次都是**拿自造假宿主验证的**；真实契约就在 `app.asar` 里，我一次都没去读。**验证对象选错，不是实现疏漏。**

## 三、阻塞问题：合成键（用户第 5 项）

详见 `03-round2-issues.md`。摘要：

| 编号 | 严重度 | 问题 |
| --- | --- | --- |
| R2-1 | **BLOCKER** | 两条不同提醒若 title+时刻相同 → 合成键**完全相同** → `idByKey` 后写覆盖前写 → **取消一条后另一条成孤儿，仍会响** |
| R2-2 | MAJOR | 同一时刻不同 ISO 写法（`Z` vs `.000Z`）→ 生成**两个不同键** → 去重失效（B1 在合成键路径上复活） |
| R2-3 | MAJOR | 宿主不回报业务 key 时，合成键与业务 `reminderKey` **交集恒为空** → 每次 reconcile 退化为「全删再全建」，窗口期内可能**漏投** |
| R2-4 | MINOR | `title` 未归一化（前后空格/大小写）放大 R2-2 |

**为什么这是 blocker 而不是 minor**：用户可感知的失败模式是「点了取消，提醒还在响」以及「重启后提醒消失/重复」。这是日历提醒的核心信任，不能带着上线。

**根因一句话**：我把「合成键」当成了「业务幂等键」的替身，但它既**不唯一**（同标题同刻），也**不稳定**（格式差异），还不**对齐**（与 `reminderKey` 语义不同）。三者任意一条成立，reconcile 的判断就是错的。

**修法方向**（供修复轮）：
1. 宿主条目有 `id` → 用 `host-id:<id>` 作**宿主侧唯一键**，不复用 title+at；
2. `reminderKey → hostId` 必须**持久化**（与 `store.js` 同一套原子写），重启后从磁盘恢复，而不是靠猜；
3. 若仍需时间参与哈希，先 `Date.parse` 归一；
4. 宿主不回报业务 key 时，reconcile 降级为**安全模式**：只 create 不 remove，返回 `degraded: true` 让上层告警——宁可有重复，不可删用户提醒。

## 四、必须记入的自我误判（R2-0）

冻结后我在副本**根目录**跑 `node demo/demo.mjs` → `MODULE_NOT_FOUND`，一度断言「demo.mjs 没进 git、我报的 EXIT 0 是假的」。
**该断言错误。** 实测：`git ls-files` 显示 `workbench-core/demo/demo.mjs` **已跟踪**，`72e09ef` 内 12 个 demo 条目；正确路径下 **EXIT 0**。
真实原因是我自己的相对路径写错。这属于**未验证归因**，已更正，不留结论不记过程。

## 四之二、我对复审结论的裁决（不整盘照抄）

**采信**：R2-5 契约不匹配（blocker）、R2-6 审批旁路（blocker）、R2-7 恢复层 scope、R2-9 `skipped` 经 spread 丢失、R2-10 `historyAvailable` 恒真、R2-11 scope 前缀与真实 key 永不匹配、R2-12 脚本退出码、R2-13 `skipped` 非枚举致可观测性丢失、R2-14 测试真空（4 项变异回退仍全绿）。

**复核后推翻 2 条**（各自给了我的复跑证据）：
- N3'「bulkDelete 逗号 id 可绕过」→ 我用等价构造实测 **`fingerprint-mismatch` 被拦**，通用不可利用；但**仍会改**（当前依赖「id 不含逗号」太脆弱）。
- M2'「missed 恒 0、lookback 失效」→ 生产时钟复跑得到 `missed=1`，**能识别**；但其「文档易被误读」的批评采纳，需写清两段语义。

## 五、UNVERIFIED 清单（明确标记，不宣称严格 exactly-once）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 宿主侧严格 exactly-once（只投递一次） | **UNVERIFIED** | 本机 `schedule_list` 只回 `{id,kind,title,prompt,afterSeconds,scheduledAt,state,deliveryMode}`，**无投递历史明细、无业务 key**；无法从宿主侧核对投递计数 |
| 宿主跨重启去重（生产语义） | **UNVERIFIED** | 当前实现依赖合成键，而本机宿主不回报业务 key（见 R2-3） |
| 真实 macOS 休眠 / 退出 / 重启 | **UNVERIFIED** | 三场景用固定时间基准模拟，未做真实 OS 挂起 |
| 多进程并发写 | **UNVERIFIED** | 文件存储非多进程安全，未测 |
| 第二轮独立 Review 的第三方结论 | **未取得** | 复审 Agent 结论未回传；本轮结论由主会话独立验证得出，**不是第三方结论** |

## 六、剩余风险

1. 合成键缺陷未修前，**「取消提醒」与「重启去重」在真实宿主语义下不可信**。
2. 复审的第三方结论缺口依旧存在（连续两轮同一故障），需要人工或换机制补。
3. 三场景与真实 OS 行为之间仍无对照实验。

## 七、流程改进（本轮已做到 / 待做）

- ✅ 做到：**先冻结 commit 再派审查**（上轮教训），全程 HEAD 未动。
- ✅ 做到：证据脚本入库（`scripts/wp2-*.mjs`），日志可复跑。
- ⬜ 待做：独立 Review Agent 结论回传机制连续两轮失败，建议下轮改为「Agent 把结论写入指定文件」，由主会话读取，避免依赖消息回传。

## 八、STOP

Review 完成，结论 **REQUEST CHANGES**。修复后需：
1. 修复合成键（R2-1/2/3/4）；
2. 新开 commit 并**重新冻结**；
3. 再安排复审（建议用「写文件」方式取结论）。

**不自动进入 WP3。**
