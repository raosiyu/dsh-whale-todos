# 真实宿主契约（DSH `ctx.schedule`）一手核实

核对方：本机 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js`
版本：`@deepseek-ai/dsh-schedule@0.2.1-rc.5`
核对方：逐行读源码，不依赖任何文档或第二手描述。

> 本文件是 WP2-R3 的**唯一契约依据**。任何与此不符的调用形状都是缺陷，不论测试是否通过。

## 一、五个方法（真实签名）

| 方法 | 签名（源码行） | 入参 | 返回 |
| --- | --- | --- | --- |
| `create` | `async create(sessionId, request, signal)` **L2083** | 第一参 `sessionId: string`；第二参 `request`；第三参 `AbortSignal?` | 冻结的 record 对象 |
| `list` | `async list(request)` **L2120** | `{ sessionId }` **必填** | active 记录的数组（`task.record`），**无 `key` 字段** |
| `catalog` | `async catalog()` **L2129** | 无参 | 全部记录（含 `sessionId` / `status` / `lastDelivery?`），按 `scheduledAt` 再 `id` 升序 |
| `history` | `async history(request)` **L2144** | `{ sessionId, id, limit }`，`limit` 必须是 **1..100 的安全整数** | `deliveryHistoryPage(...)` 结果（见下） |
| `delete` | `async delete(request, signal)` **L2164** | `{ id, sessionId }` | `{ id, deleted: true }` 或 `{ id, deleted: false, code: 'schedule_not_found' }` |

## 二、`create` 的 `request` 形状（L2084-2095）

**恰好一个** selector（多于一个抛 `invalid_selector`）：

```
at | after_seconds | every_seconds | daily | weekly | cron
```

外加两个必填字段：

| 字段 | 约束（L94-97） |
| --- | --- |
| `title` | **必填**，`trim()` 后非空，**≤120 字符**；否则 `invalid_prompt` |
| `prompt` | 必填，非空、已 trim（L268/L292） |

### `at` 必须是**显式偏移的字符串**（或 local calendar object）

> **用真实代码实测校正**（`scripts/r3-real-host.mjs` L3，见 `evidence/wp2-r3/02-real-host.log`）：
> 传数字的报错原文是 `at must be an explicit-offset string or local calendar object`。
> 即真实契约接受两种形态：**显式偏移字符串**，以及**本地日历对象**。
> 本项目只用字符串形态（跨机可复现），因此实现上按字符串处理即可；
> 但不能把契约描述成「只接受 RFC3339 字符串」——那是不准确的。

- 字符串格式：`YYYY-MM-DDTHH:mm:ss` + 可选 1-3 位小数秒 + **显式 `Z` 或 `±HH:MM`**（L186-206 `parseOffsetInstant`）
- 必须是**真实日历时刻**（L170 拒绝归一化，如 2 月 30 日）
- 必须**严格在未来**：`epoch <= now` → `not_future`（L180）
- 年份范围 `0001..9999`，否则 `time_out_of_range`（L179）

**实测确认**（真实代码，非 stub）：

| 输入 | 结果 |
| --- | --- |
| 合法 UTC 字符串 | ✅ 成功，record 为 `{id, kind:'at', title, prompt, scheduledAt}` 且 `Object.isFrozen` |
| 数字（epoch ms） | ✅ 被拒 `invalid_rule` |
| 过去时刻 | ✅ 被拒 `not_future` |
| 无时区（`2026-11-05T09:00:00`） | ✅ 被拒 `invalid_rule` |
| 不存在的日历日（2 月 30 日） | ✅ 被拒 `invalid_rule` |
| 空 / 空白 title | ✅ 被拒 `invalid_prompt` |
| 121 字符 title | ✅ 被拒 `invalid_prompt` |

且真实 record **不含 `key` 字段**（实测），这正是「身份必须本地持久化」的直接依据。

## 三、record 形状（L280-300 `decodeAtRecord`）

```
{ id, kind: 'at', title?, prompt, scheduledAt }
```

- `scheduledAt` 是**规范化 UTC 瞬时字符串**，必须字面等于 `new Date(epoch).toISOString()`（L151-154），即 `YYYY-MM-DDTHH:mm:ss.sssZ`
- `title` 在历史记录里可能不存在（L140-143），新写入必有
- 对象被 `Object.freeze`（L293）
- **没有 `key` 字段，没有 `prompt` 以外的业务标识**

## 四、`history` 返回形状（`deliveryHistorySchema` L1669-1673）

```js
{
  records: [{ scheduledAt, deliveredAt, messageId, prompt? }],
  earlierRecordsUnavailable: boolean,
  earlierRecordsPruned?: boolean,
}
```

失败分支（L2147-2150）：任务不存在或不属于该 session →

```js
{ id, code: 'schedule_not_found' }
```

`limit` 非法（非 1..100 安全整数）→ 抛 `ScheduleInputError('invalid_rule')`（L2145）。

**关键**：`history` 是**单任务**查询，返回的是**投递回执**，不是「计划中的提醒」。
判定「这条提醒投递过没有」只能看某任务 id 的 `records` 是否非空。

## 五、「投递即转 inactive」语义（L1599-1626）

一次性提醒投递成功后：

- `status` 变为 `inactive`（L1602）
- 写入 `lastDelivery` 与 `deliveryHistory`
- **行仍存在**于表中，因此 **`catalog()` 能看到，`list()` 看不到**（`list` 只过滤 `status === 'active'`，L2121）

这解释了历史现象：`schedule_list` 工具在投递后返回 `[]`（走 `list` → active only），但记录并未被删除。

**这是 B2 的根本机制**：若用 `list` 判断「是否已存在」，已投递的任务会被看成「从未存在」→ 重建 → 重复投递。

## 六、错误码表

| 错误类 | code | 触发 |
| --- | --- | --- |
| `ScheduleInputError` | `invalid_selector` | selector 数量 ≠ 1 |
| | `invalid_prompt` | title 缺失/空白/超 120 |
| | `invalid_rule` | `at` 形状非法、非真实日历时刻、`history.limit` 非法 |
| | `invalid_time_zone` | 时区非 UTC/IANA |
| | `time_out_of_range` | 年份越界 |
| | `not_future` | `at` 不在未来 |
| | `subagent_session` | 目标 session 归子代理所有，永不可投递 |
| `ScheduleLogError` | `corrupt_schedule_log` | 持久化数据损坏 |

## 七、对本项目的直接影响（对照旧实现的错误）

| 旧实现 | 真实契约 | 后果 |
| --- | --- | --- |
| `create({title, prompt, at: number, key})` 单参 | `create(sessionId, request, signal)` 两参，`at` 字符串 | 真实宿主下 TypeError，**一条都建不成** |
| `list()` 无参 | `list({sessionId})` | 抛错被静默吞 → 退回内存视图 → 跨重启重复注册 |
| `history()` 无参 | `history({sessionId, id, limit})` | 抛错 → `historyAvailable` 谎报 true |
| `remove(id)` | `delete({id, sessionId})` | 形状不符 |
| 用 `list` 判存在性 | 应用 `catalog()`（含 inactive） | 已投递任务被当「不存在」→ 重复投递 |
| 无 `sessionId` 概念 | 所有方法都绑 `sessionId` | 跨会话隔离无法实现 |

## 七之二、验证等级与结论（诚实分级）

| 等级 | 内容 | 结果 | 证据 |
| --- | --- | --- | --- |
| L1 取包 | 从 app.asar 解出真实 `lib/index.js` | ✅ | `evidence/wp2-r3/02-real-host.log` |
| L2 加载 | 真正 `import` 该模块（依赖从解出的整包解析） | ✅ 34 个导出 | 同上 |
| L3 行为 | 调用真实 `createAtScheduleRecord` 验证校验语义 | ✅ 8/8 | 同上 |
| L4 实例化 | `new ScheduleService(ctx)` | ❌ **BLOCKED** | 需运行中 Cordis Context（`static inject` 见日志） |

**L4 未取得 PASS，不计通过。** 原因：`ScheduleService` 继承 Cordis Service，构造需要
`agents / sessions / storageDomain / sessionController / sessionPersistence` 六个服务；
本会话没有启动完整 Host（启动 GUI 会挂起，且存在触碰真实 profile 的风险）。

**因此「真实 Service 端到端」仍是 UNVERIFIED**；L1-L3 能证明的是
**契约形状与校验语义**，不能证明「服务在真实 Host 里跑通」。

## 八、因此必须遵守的三条实现纪律

1. **不许用 `list` 判断存在性**，一律用 `catalog()`（唯一能看见 inactive 的接口）。
2. **不许静默 catch**：宿主异常必须透传或显式降级为 `degraded`，不得伪装「后端为空」。
3. **不许拿 `title + scheduledAt` 当身份**：身份只能是 `reminderKey`（本地持久化）↔ 宿主 `id` 的显式映射。
