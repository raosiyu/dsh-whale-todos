# WP2-R3 交付报告：真实宿主契约与安全修复

状态：**修复完成，四类测试分级报告如下；真实 Service 端到端仍 UNVERIFIED**
测试：**180 / 180 pass，0 fail，0 skip**（R3 前 161）
演示：`node workbench-core/demo/demo.mjs` EXIT 0
变异：**14 / 14 被捕获，0 真空**

## 一、真实契约验证（用户第一节要求）

以 `app.asar` 一手源码为准，逐项核实并实现：

| 方法 | 真实签名（源码行） | 本实现 | 状态 |
| --- | --- | --- | --- |
| `create` | `create(sessionId, request, signal)` L2083 | 两参调用，`at` 传 canonical UTC 字符串 | ✅ |
| `list` | `list({sessionId})` L2120 | 仅用于取 active，**不用于判存在性** | ✅ |
| `catalog` | `catalog()` L2129（无参，含 inactive） | **存在性判断只用它** | ✅ |
| `history` | `history({sessionId, id, limit 1..100})` L2144 | 单任务查询，`limit: 100` | ✅ |
| `delete` | `delete({id, sessionId})` L2164 | 两字段对象 | ✅ |

`at` 的实测校正：真实报错是 `at must be an explicit-offset string or local calendar object`，
即接受**显式偏移字符串**或**本地日历对象**。本项目只用字符串（跨机可复现），
文档已改为准确措辞，不再写成「只接受 RFC3339 字符串」。

## 二、提醒管理修复（第二节）

| 要求 | 实现 | 证据 |
| --- | --- | --- |
| 持久化 reminderKey/hostId/sessionId 映射 | `src/host-map.js`，tmp+fsync+rename 原子写 | `hostMap：持久化并在重启后恢复映射` |
| 重启先查宿主再差量恢复 | `reconcile` 每条先 `catalog()` 判存在 | `跨 5 次重启不重复注册` |
| 无法识别归属时禁止盲目补建/删除 | `catalog` 读不到 → `degraded: true`、**只建不删** | `宿主 catalog 抛错时显式降级，只建不删` |
| 禁止 `title+at` 作唯一身份 | 身份只来自 hostMap；同名同刻两条独立 | `同标题同时刻的两条提醒独立存在` |
| 用真实 `history` 查投递状态 | `historyFor()` → `history({sessionId,id,limit})` | `已投递后重启不重建` |
| 无法确认历史 → UNKNOWN/UNVERIFIED | 三态 `DELIVERED / NOT_DELIVERED / UNKNOWN` | `history 读不到时返回 UNKNOWN，不谎报未投递` |
| 严格按 sessionId 隔离 | 所有方法带 sessionId；跨会话不互删 | `不同 sessionId 之间不互相影响` |
| 宿主异常可观察 | 错误上抛或返回 `unavailable`，**无静默 catch** | 变异 M4 被捕获 |

**关键修复（本轮新发现）**：`reconcile` 原先会把 `inactive`（已投递）记录当「多余」删掉。
删掉后投递记录随之丢失 → 重启无法判定「已提醒过」→ 重建 → 重复投递。
现只把 **active** 纳入可删除范围。

## 三、审批旁路封闭（第三节）

| 要求 | 实现 |
| --- | --- |
| 不暴露底层可写 store/repo | 返回**冻结的只读投影**：`store.{listBackups,listPreBackups}`、`events.{list,get}`；`replace/rollback/commit/backup/remove/create/update` **全部不可达** |
| 所有写操作走受控入口 | 仅 `execute()`；实测 7 个写方法均 `undefined` |
| 删除/替换/回滚必须经审批 | 5 个危险操作无凭证一律 `confirmation-required` |
| 禁止 AI 自造布尔授权 | `payload.confirmed` / `meta.confirmed` / 嵌套 `meta.confirmed` 三种位置全拒 |
| 审批绑定操作+参数+版本，防 TOCTOU | 指纹含 op+target+**内容 SHA-256**；`bulkDelete` 用 `JSON.stringify(sortedIds)`；`rollback` 绑定**具体备份名**且**必须显式指定** |
| 审批先于数据读取 | `rollback` 先校验审批再查备份——否则无凭证者能从 `not-found` vs `confirmation-required` 推断库内状态 |

**N1 之外还封了两道门**：上一轮只摘了 `approvalGate`，本轮才发现 `store`/`events` 仍是旁路。

## 四、四类测试分级报告（第四节，分别报告）

### T1 单元测试

| 项 | 结果 |
| --- | --- |
| `node --test test/*.test.mjs` | **180 / 180 pass，0 fail，0 skip** |
| 其中 domain（schema 13 / recurrence 22 / conflict 13 / store 12 / ics 16 / service 20） | 96 项全部通过 |
| 其中审批与调度（schedule 29 / recovery 10 / bypass 16 / contract 29） | 84 项全部通过 |

### T2 模拟宿主（契约 stub）

`test/helpers/contract-stub.mjs` 严格复刻真实签名，**形状不对当场抛 `invalid_rule`**：

| 覆盖点 | 测试 |
| --- | --- |
| `create` 必须两参、`at` 必须字符串 | `契约 stub：create 必须两参，单参会失败` / `at 传数字会失败` |
| `list` 必须带 sessionId | `契约 stub：list 必须带 sessionId` |
| `history` limit ∈ [1,100] | `契约 stub：history 的 limit 必须在 1..100` |
| 跨 5 次重启去重 | `跨 5 次重启不重复注册` |
| 已投递后不重建 | `已投递后重启不重建` |
| 同名同刻独立 | `同标题同时刻的两条提醒独立存在` |
| 取消无孤儿 | `取消一条不影响另一条` |
| 跨 session 隔离 | `不同 sessionId 之间不互相影响` |
| 降级只建不删 | `宿主 catalog 抛错时显式降级` |
| UNKNOWN 不谎报 | `history 读不到时返回 UNKNOWN` |
| scope 隔离 | `reconcile 带 scope 时不误删` + `恢复层必须把 scope 透传` |
| 审批四类绕过 | `bypass.test.mjs` 16 项 |

### T3 真实隔离 Host 测试

`scripts/r3-real-host.mjs`，用 **app.asar 里的真实代码**，分级：

| 等级 | 内容 | 结果 |
| --- | --- | --- |
| L1 取包 | 从 asar 解出真实 `lib/index.js` | ✅ PASS |
| L2 加载 | 真正 `import`（依赖从解包解析） | ✅ PASS，34 个导出 |
| L3 行为 | 调用真实 `createAtScheduleRecord` 8 组输入 | ✅ PASS 8/8 |
| L4 实例化 | `new ScheduleService(ctx)` | ❌ **BLOCKED** |

L3 实测结论（真实代码，非 stub）：

| 输入 | 真实结果 |
| --- | --- |
| 合法 UTC 字符串 | record `{id,kind:'at',title,prompt,scheduledAt}`，**frozen**，**无 `key` 字段** |
| 数字 epoch | `invalid_rule` |
| 过去时刻 | `not_future` |
| 无时区字符串 | `invalid_rule` |
| 2 月 30 日 | `invalid_rule` |
| 空白 / 121 字符 title | `invalid_prompt` |

**L4 BLOCKED 原因**：`ScheduleService` 继承 Cordis Service，`static inject = ["agents","sessions","storageDomain","sessionController","sessionPersistence"]`，需运行中 Host 才能构造。启动 GUI 会挂起，且存在触碰真实 profile 的风险，故未执行。**该项不计 PASS。**

### T4 macOS 系统级测试

**未执行，标记 UNVERIFIED。** 真实 OS 休眠 / 唤醒 / 退出 / 重启与系统通知投递均未验证。

## 五、变异验证（删除保护代码，测试必须失败）

`scripts/r3-mutate.sh` → `evidence/wp2-r3/01-mutation.log`

**首轮结果：CAUGHT 12 / VACUUM 2**，两处测试真空：
- `catalog` 退化为只看 active → 全绿（没有测试验证「已投递必须可见」）
- 恢复层不传 scope → 全绿（scope 隔离在恢复路径无约束）

**补了 3 条测试后：CAUGHT 14 / VACUUM 0。**

| 变异 | 结果 |
| --- | --- |
| M1 catalog 只看 active | CAUGHT |
| M2 reconcile 删除 inactive | CAUGHT |
| M3 create 退回单参+数字 at | CAUGHT（13 红） |
| M4 catalog 失败静默当空 | CAUGHT |
| M5 恢复层不传 scope | CAUGHT |
| M6 已投递判定失效 | CAUGHT |
| M7 UNKNOWN 也重建 | CAUGHT |
| M8 审批门不校验 token | CAUGHT（17 红） |
| M9 service 重暴露 store | CAUGHT（3 红） |
| M10 bulkDelete 逗号拼接 | CAUGHT |
| M11 hostMap 不持久化 | CAUGHT（3 红） |
| M12 hostMap 允许 hostId 重复 | CAUGHT |
| M13 损坏映射静默重建 | CAUGHT |
| M14 compileReminder 不滤过期 | CAUGHT |

## 六、UNVERIFIED 清单

| 项 | 原因 |
| --- | --- |
| 真实 `ScheduleService` 端到端（L4） | 需运行中 Cordis Context；未启动 Host |
| 真实宿主投递历史明细 | 子会话无 `schedule_*` 工具；主会话只有 `list` 视图 |
| 真实 macOS 休眠/退出/重启 | 未执行 |
| 系统通知是否真正弹出 | 未验证 |
| 多进程并发写 | 文件存储非多进程安全 |
| 生产语义下的跨重启去重 | 依赖 L4；目前只在契约 stub（T2）与真实函数（L3）层验证 |

## 七、红线合规

| 红线 | 结果 |
| --- | --- |
| 不修改正式 DSH profile | ✅ `~/.dsh/profiles` 零改动（`find -newermt` 无输出）；`~/.dsh` 目录 mtime 变化仅因**本会话自身日志**（`logs/`、`dsh-usage/`、`.dshw-usage.json`），非 `dsh rescue` 写入 |
| 不碰用户数据 | ✅ 未读写任何 workbench 用户数据 |
| 不碰其他项目 | ✅ 鲸鱼娘 `79d7e24` dirty 0 |
| 不 push | ✅ `git remote` 为空 |
| 隔离手段 | `DSH_HOME=/tmp/dsh-iso-*` 下建 profile（`dsh rescue --from-default-profile web`），真实 profile 未参与 |

## 八、剩余风险

1. **L4 未验证**意味「接上真实 Host 后是否真能跑」仍是推断；本轮只证明了契约形状与校验语义。
2. `inactive` 记录永久保留，长期会累积（无限增长）；需后续加保留策略（宿主自带 `retention`，本项目未接）。
3. 文件存储非多进程安全。
4. macOS 系统级行为完全未验证。

## 九、STOP

按授权：仅修复第二轮 Review 确认的问题。**未进入 WP3。**

**结论口径**：跨重启去重、已投递防重发、审批安全的**逻辑与契约层**已 PASS；
**真实 Service 端到端**（L4）与 **macOS 系统级**（T4）仍 UNVERIFIED，
故不宣称 WP2 整体「已通过最终验收」。
