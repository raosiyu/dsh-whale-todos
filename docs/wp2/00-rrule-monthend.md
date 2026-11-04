# RRULE 月末语义：RFC 合规路径 vs 自定义扩展路径

WP2 前置检查明确要求「检查 RRULE 月末语义与 RFC 5545 的差异；标准 ICS 遵循规范，自定义补齐规则必须显式区分」。
本文件记录**修正前后**的行为、依据与实现方式。

## 一、修正前（WP1 交付的行为）

MONTHLY 从 1/31 起重复，**clamp 到短月月末**并**计入 COUNT**：

```
1/31 → 2/28 → 3/31 → 4/30
```

这是项目自定的扩展，**不符合 RFC 5545**。

## 二、RFC 5545 的要求

RFC 5545 §3.3.10「Recurrence Rule」明确：

> Recurrence rules may generate recurrence instances with an invalid date (e.g., February 30) or nonexistent local time (e.g., 1:30 AM on a day where the local time is moved forward by an hour at 1:00 AM). Such recurrence instances MUST be ignored and MUST NOT be counted as part of the recurrence set.

要点三条：
1. 非法日期（如 2 月 31 日）产生的实例 **MUST be ignored**；
2. **MUST NOT be counted as part of the recurrence set** —— 即不占 COUNT 名额；
3. 该规则同样适用于不存在的本地时间（DST 空档），本项目在 `time.js` 里已按「前移到空档结束」处理并单独测试。

## 三、修正后（WP2）

### 默认 `rfc` 策略

```
1/31 count=4 → 1/31 → 3/31 → 5/31 → 7/31
```

2 月**整月跳过**，不计数；4 个实例全部合法。

YEARLY 闰日同理：

```
2024-02-29 count=2 → 2024-02-29 → 2028-02-29
```

2025/2026/2027 无 2/29 → 跳过且不计数。

### 可选 `clamp` 策略（本项目的显式扩展）

```
1/31 count=4 → 1/31 → 2/28 → 3/31 → 4/30
```

保留原有「收敛到月末」语义，用于「每月最后一天」这类**用户真实意图**。**必须显式传参启用**，不是默认行为。

## 四、实现方式

```js
expandEvent(event, { windowStart, windowEnd, monthEndPolicy: 'rfc' | 'clamp' })
```

| 策略 | 常量 | 默认 | 语义 |
| --- | --- | --- | --- |
| `rfc` | `DEFAULT_MONTH_END_POLICY` | ✅ | 非法日期实例跳过，不占 COUNT（RFC 5545 §3.3.10） |
| `clamp` | `MONTH_END_POLICIES` 之一 | — | 收敛到该周期最后一天（自定义扩展） |

未知策略值直接抛 `validation`，**不静默回退到某一个默认**——避免「以为在用 RFC 其实在用扩展」。

核心函数 `periodDatesFor()` 按**周期序号**算出该周期的日期列表：返回空数组即表示该周期没有合法实例，调用方跳过且**不消耗 COUNT**。这也顺带修掉了旧实现的漂移 bug（短月 clamp 会污染后续周期）。

## 五、测试锁定

`test/recurrence.test.mjs` 同时覆盖两条路径，互不混淆：

| 用例 | 断言 |
| --- | --- |
| `MONTHLY 31 号—RFC 策略跳过 2 月` | `1/31 → 3/31 → 5/31 → 7/31` |
| `MONTHLY 31 号—clamp 策略收敛到月末` | `1/31 → 2/28 → 3/31 → 4/30` |
| `YEARLY 闰日—RFC 策略跳过平年 2/29` | `2024-02-29 → 2028-02-29` |
| `YEARLY 闰日—clamp 策略收敛到 2/28` | `2024-02-29 → 2025-02-28` |
| `非法 monthEndPolicy 被拒绝` | 抛 `monthEndPolicy` 校验错误 |

全量：**96 / 96 pass，0 fail，0 skip**。

## 六、影响面

- 默认行为从 clamp 改为 RFC → **既有日历数据的重复展开结果会变**（2 月不再出现）。
- 这是**语义修正**，不是回归；需要「每月最后一天」的用户必须显式选 `clamp`。
- ICS 导入/导出不受影响：`buildIcs` 原样写出 `RRULE`，不内联展开结果；`parseIcs` 只解析规则本身。
