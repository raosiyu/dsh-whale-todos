# 第三轮 Review 结论与我的复核

复审：**REQUEST CHANGES**
基准：`4ae8455`（冻结完好，`diff -rq` 零差异）
复审产物：`/tmp/wp2r3rev/VERDICT.md`（304 行）、`probe/`（47 个探针）、`logs/`

## 一、我的复核结果（不整盘照抄，逐条自己验）

### 确认成立

| 编号 | 复审主张 | 我的复核 | 判定 |
| --- | --- | --- | --- |
| N-02 | 回执被 retention 裁剪 → `records=[]` 判成 `not-delivered` → 二次投递 | 判据是 `records.length > 0 ? DELIVERED : NOT_DELIVERED`，**确实不看 `earlierRecordsUnavailable`** | ✅ 成立，MAJOR |
| N-05 | `deny` 模式并非一律拒绝 | `DANGEROUS_OPS` 仅 5 项；`gate.writable` **从未被 service 读取** | ✅ 成立，MAJOR |
| N-06 | `event.restore` / `task.upsert` 是写操作却不在审批清单 | `DANGEROUS_OPS` 无这两项；deny 下可撤销软删 | ✅ 成立，MAJOR |
| M3' | scope 前缀与真实 key 永不匹配 | `reminderKeyOf(...)` = `9e053361aa2b03227756bf3e410d61e7`，`startsWith('events:')` / `startsWith('tasks:')` 均 false | ✅ 成立，**上一轮 R2-11 原样遗留** |
| N-14 | 报告「R3 前 161」不存在 | 实测各 commit：`d43326a`=93、`cebced2`=96、`f1fb509`=133、`58c0516`=142、`a23785c`=177、`4ae8455`=180。**无 161** | ✅ **我写错了** |
| N-01 | 「L4 不可达」不成立 | 复审用真 `Context` + 假 `storageDomain` 就 `new ScheduleService` 成功并跑通五方法 | ✅ **我说错了** |
| N-03 | hostMap 丢条目 → 宿主侧变 2 份、孤儿仍投递、`cancel` not-found | 代码 `catalog()` 对无映射宿主行 `continue`，静默跳过 | ✅ 成立，MAJOR |
| N-04 | 标题 >120 → 真宿主 `invalid_prompt` → 整轮中断且半截已建 | `upsert` 的 create 分支无 try/catch，主循环无 per-plan 捕获 | ✅ 成立，MAJOR |
| N-08 | 删除失败静默吞 | `reconcile` 删除分支只 `if (res.ok) removed.push`，失败不计入 `failed` | ✅ 成立，MINOR |
| N-09 | degraded 实为「不建不删」 | 降级时 `existingKeys` 为空 → 不会走删除分支，但也不会重建已存在的 | ✅ 成立，措辞需改 |

### 需要修正的表述

- 我在报告里写「catalog 失败 → 只建不删」。实际是**不建不删**（不知道存在哪些，就无法判断该建什么）。复审指出得对。

### 测试真空（复审自造 14 个变异，8 CAUGHT / 6 VACUUM）

VACUUM 的 6 处恰好对应缺陷点：
X6 degraded 盲目建 / X9 inactive 算幂等复用 / X11 UNKNOWN 纳入 future /
X12 删除失败记 failed / X13 回执裁剪判 UNKNOWN / X14 hostMap 保留上限（本轮已补）

**这意味着：我上一轮 16/16 的「0 VACUUM」只对我自己选的那 16 个保护点成立**，
覆盖面不足。这一点我接受——变异测试的盲区是「只测我想到的」。

## 二、本轮修复集（按复审建议的最小集 + 我判断必须加的）

| # | 问题 | 修法 |
| --- | --- | --- |
| 1 | N-02 回执裁剪误判 | `earlierRecordsUnavailable === true && records.length === 0` → **UNKNOWN**（不是 not-delivered） |
| 2 | N-08 删除失败静默 | 失败写入 `failed`，并计入返回值 |
| 3 | N-04 create 失败中断整轮 | `upsert` create 分支 try/catch → `{ok:false, reason}`；主循环 per-plan try/catch |
| 4 | N-03 无映射行静默跳过 | 采集为 `unmapped` 列表随 `catalog()` 返回，供上层告警 |
| 5 | N-05 deny 未生效 | service 读取 `gate.writable`；不可写时所有写操作直接拒绝 |
| 6 | N-06 写操作不在清单 | `event.restore` / `task.upsert` 纳入 DANGEROUS_OPS |
| 7 | M3'/N-11 scope 永不匹配 | **改成 scope 一等字段**：`hostMap` 存 `scope`，`reconcile` 按映射的 scope 过滤，不靠 key 前缀 |
| 8 | N-01 L4 | 把复审的 p19 升为 `scripts/r3-real-service.mjs` 入库，报告改为真实 L4 结论 |
| 9 | N-14 数字 | 报告改为实测序列 93/96/133/142/177/180 |
| 10 | 测试真空 X6/X9/X11/X12/X13 | 每处补一条测试 |

## 三、我这次真正该记住的

三轮 Review，我错了三次同一个模式：**用「我自己构造的验证」代替「真实约束」。**

1. 第一轮：自造宿主接口 → 契约不符
2. 第二轮：自造合成键 → 身份重复
3. 第三轮：自造变异集合 → 只覆盖我想到的 16 个点，漏掉 6 处真空；且明明能用真 Context 实例化，我却标了 BLOCKED

**共同点：我把「我的验证通过了」当成了「系统正确」。**
真正该做的是**让验证对象来自外部约束**（真实库签名、真实 Context、别人设计的变异），
而不是我自己想象出来的替代品。

---

## 四、自查过程中的两次误报（记录，供后续警惕）

修完 N-02 后我写脚本验证，连续两次得出「N-02 没修好」的结论，**两次都是假警报**：

| 次数 | 我当时看到的 | 真实原因 |
| --- | --- | --- |
| 1 | 「回执被裁剪 → 仍判 REBUILT」 | 脚本把四个用例塞进同一个 adapter/stub，**前一例设过的 `stub.history` 状态串到下一例** |
| 2 | 「`deliveryStateOf` 返回 unknown 但 recover 仍重建」 | 我从同一份污染状态里推的因果，实际 `recover` 的 UNKNOWN 分支本身就 `continue` |

用**每例独立环境**重写后，四种输入全部正确：

```
真未投递 (earlier=false, records=[])   → REBUILT   ✅ 不会漏提醒
已投递   (records 有值)                → DELIVERED ✅ 不重建
回执裁剪 (earlier=true,  records=[])   → UNKNOWN   ✅ N-02 修好
两者都有 (earlier=true,  records 有值) → DELIVERED ✅
```

### 这个教训比 N-02 本身更值得记

我的验证脚本存在**共享可变状态**（同一个 stub 反复改 `history`），
第一例污染第二例，于是「代码有 bug」和「脚本有 bug」长得一模一样。
两次我都先怀疑代码、照着自以为是的因果去“定位”，**其实定位对象本身是脏的**。

规则（写给自己）：
**验证一张判据表时，每一格必须有独立环境；共享 fixture 必须先重置再断言。**
