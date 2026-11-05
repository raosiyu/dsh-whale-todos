# WP2-R3 最终验收记录

日期：2026-11-05
最终 HEAD：`4df7763`
冻结基准（经受审查）：`4ae8455`

## 一、用户点名 8 项验收：结果

脚本：`scripts/r3-acceptance.mjs` → `evidence/wp2-r3/03-acceptance.log`
**PASS 26 / FAIL 0 / UNVERIFIED 0**

| # | 验收项 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 创建真实宿主提醒，核实实际返回记录 | ✅ | 记录形状 `kind=at`、`scheduledAt` 为 canonical UTC、**零契约违规** |
| 2 | 连续重启五次不新增重复 | ✅ | 五次重启后宿主仍 **1 条** |
| 3 | 同标题同时刻、不同 ID 独立存在 | ✅ | 宿主两条不同 `id`；取消 A 后 B 仍在（无孤儿） |
| 4 | 修改 / 取消 / 删除后宿主状态正确 | ✅ | 改时刻后仍 1 条且**换了新 hostId**（删旧建新）；取消后为空 |
| 5 | 不同 sessionId 不互相删除或修改 | ✅ | sA 对账 `removed=0`，两 session 各 1 条不变 |
| 6 | 宿主抛错或历史不可用 → 明确失败或降级 | ✅ | `catalog` 失败 → `UNAVAILABLE` + `degraded` + **只建不删**；`history` 失败 → `UNKNOWN` + 记入 `unknown` 不删不建 |
| 7 | 四类审批绕过全部拦截 | ✅ | 伪造布尔 / 伪造复用凭证 / 底层写方法不可达 / target 歧义 —— 6 项断言全过 |
| 8 | 关键测试变异验证 | ✅ | `scripts/r3-mutate.sh`：**16 变异 / 16 CAUGHT / 0 VACUUM** |

## 二、四类测试分级（用户要求分别报告）

| 层级 | 数量 / 结果 | 说明 |
| --- | --- | --- |
| **T1 单元** | **183 / 183 pass，0 fail，0 skip** | `node --test test/*.test.mjs` |
| **T2 模拟宿主** | 契约 stub 12 项 + 攻击 16 项 + 契约 32 项 | stub **严格校验真实签名**，形状不对当场 `invalid_rule` |
| **T3 真实隔离 Host** | L1 取包 ✅ / L2 加载 ✅（34 导出）/ L3 真实函数 8/8 ✅ / **L4 实例化 BLOCKED** | 见 `evidence/wp2-r3/02-real-host.log` |
| **T4 macOS 系统级** | **未执行** | 见 UNVERIFIED |

## 三、变异验证（判断测试是否真有约束力）

`evidence/wp2-r3/01-mutation.log`

| 轮次 | 结果 |
| --- | --- |
| 首轮（14 变异） | **CAUGHT 12 / VACUUM 2** —— 两处测试真空被自己抓出 |
| 补齐 3 条测试后 | CAUGHT 14 / VACUUM 0 |
| 加有界保留后（16 变异） | **CAUGHT 16 / VACUUM 0** |

首轮那两处真空：
- `catalog` 退化成只看 `active` → 全绿（没有测试验证「已投递必须可见」）
- 恢复层不传 `scope` → 全绿（scope 隔离在恢复路径无约束）

## 四、第三方独立复审：未取得结论（如实记录）

这是本轮**唯一未闭环的流程项**，我必须明说：

| 轮次 | 基准 | 结果 |
| --- | --- | --- |
| 第一轮 | `cebced2..fae46c0` | ✅ 取得 REQUEST CHANGES（2 blocker / 6 major / 6 minor） |
| 第二轮 | `72e09ef` | ✅ 取得 REQUEST CHANGES（1 新 blocker + 多条 major） |
| **第三轮** | `4ae8455` | ❌ **未取得结论** |

第三轮复审 Agent 确实运行过（`/tmp/wp2r3rev/` 内有它解出的 `asar/`、`asar_full/`、
以及冻结副本 `fresh/`），但我要求它写入的 `/tmp/wp2r3rev/VERDICT.md` **不存在**，
结论也未回传。**连续三轮中两轮出现同一故障。**

**处理方式**：
- 不以「我自己验过了」冒充第三方复审；
- 本轮结论由**主会话自行完成**（即第九节的自检与本文档），属于**实施方自检**，
  不是独立审查；
- 建议下轮改为：给 Reviewer 一个必写的文件路径 + 超时后主会话读文件，
  或改用人类审查。

## 五、UNVERIFIED 清单（不宣称通过）

| 项 | 原因 |
| --- | --- |
| 真实 `ScheduleService` 端到端（L4） | 需运行中 Cordis Context；未启动 Host |
| 真实宿主投递历史明细（`history` 真值） | 无对应工具可读；只在契约 stub 层验证 |
| **真实 macOS 休眠 / 唤醒 / 退出 / 重启** | **完全未执行** |
| 系统通知是否真正弹出 | 未验证 |
| 多进程并发写 | 文件存储非多进程安全 |
| 生产语义下的跨重启去重 | 取决于 L4；当前由 T2 + L3 支撑 |

## 六、红线合规

| 红线 | 结果 |
| --- | --- |
| 不修改正式 DSH profile | ✅ `~/.dsh/profiles` 零改动（`find -newermt` 无输出） |
| 不碰用户数据 | ✅ 未读写 workbench 用户数据 |
| 不碰其他项目 | ✅ 鲸鱼娘 `79d7e24` dirty 0 |
| 不 push | ✅ 0 remote |
| 隔离 | `DSH_HOME=/tmp/dsh-iso-*` 建 profile；真实 profile 未参与 |

## 七、本轮修复清单（对第二轮 Review 的回应）

| 原编号 | 问题 | 状态 |
| --- | --- | --- |
| B1' | 真实契约不匹配（单参 + 数字 at） | ✅ 改两参 + `toHostInstant()` canonical 字符串 |
| B2' | 真实 `history` 形状下防重发失效 | ✅ `history({sessionId,id,limit:100})` 单任务查询 + 三态 |
| M3' | 恢复层不传 scope | ✅ `recover` 透传 `scope`，2 条测试锁定 |
| M5' | `skipped` 经 spread 丢失 | ✅ 改为 `{plans, skipped}` 普通对象 |
| N1' | `store`/`events` 审批旁路 | ✅ 冻结只读投影，7 个写方法不可达 |
| N3' | bulkDelete target 歧义 | ✅ `JSON.stringify(sortedIds)` 双侧一致 |
| 合成键 | `title+at` 重复 | ✅ 删除合成键，改本地持久化 `hostMap` |
| — | 审批先于数据读取 | ✅ `rollback` 先校验再查库 |
| — | **R3-1 无界保留（自查新发现）** | ✅ `maxEntries=500` 有界裁剪，只删本地映射 |

## 八、口径声明（不夸大）

**可以说的**：
- 契约形状与校验语义已用真实代码验证（L1-L3）；
- 跨重启去重、已投递防重发、审批安全在**契约层与逻辑层**已 PASS；
- 测试有真实约束力（16/16 变异被捕获）。

**不能说的**：
- ❌「WP2 已通过最终验收」——L4 与 T4 未验证；
- ❌「已取得独立复审」——第三轮结论未取得；
- ❌「真实宿主上不会重复投递」——这依赖 L4，目前只是推断。

## 九、STOP

按要求：仅修复第二轮 Review 确认的问题，**未进入 WP3**。
