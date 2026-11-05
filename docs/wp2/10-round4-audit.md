# WP2-R3 第四轮审查结论（自审，第三方未产出结论）

基准：`6626b8e`（冻结，739 文件，逐字节一致）
结论：**修复项全部通过；但存在已知限制，且第三方复审第四次未产出结论**

## 一、先说流程事实：连续四轮里三次没拿到第三方结论

| 轮次 | 基准 | 第三方结论 |
| --- | --- | --- |
| 第一轮 | `cebced2..fae46c0` | ✅ REQUEST CHANGES |
| 第二轮 | `72e09ef` | ✅ REQUEST CHANGES |
| 第三轮 | `4ae8455` | ✅ REQUEST CHANGES（304 行 VERDICT + 47 探针） |
| **第四轮** | `6626b8e` | ❌ **未产出**（Agent 跑过：`/tmp/wp2r4rev/mut.log` 显示它复跑了 25/25 变异，`reexport/` 是它解的冻结副本；但 `VERDICT.md` 从未写出） |

**本轮结论由主会话自审得出，不是独立审查。** 我不把它写成「已通过第三方复审」。

## 二、上一轮 9 项复核（每例独立环境）

脚本：`/tmp/wp2r4lead/round4-audit.mjs` → **19/19 PASS**

| 编号 | 项 | 结果 |
| --- | --- | --- |
| N-02 | 真未投递 → 重建 | ✅ `R`（不会漏提醒） |
| N-02 | 有回执 → 已投递 | ✅ `D` |
| N-02 | 回执被裁剪 → UNKNOWN | ✅ `U`（不会二次投递） |
| N-02 | 有回执+有更早记录 → 已投递 | ✅ `D` |
| N-03 | 无映射行不认领 | ✅ 0 条 |
| N-03 | 上报 unmapped | ✅ 1 条 |
| N-03 | needsAttention 标志 | ✅ true |
| N-04 | 单条失败不中断整轮 | ✅ 建 2 条 |
| N-04 | 失败计入 failed | ✅ 1 条 |
| N-04 | 失败带 code | ✅ `invalid_prompt` |
| N-05 | deny 拦截全部 10 个写操作 | ✅ 10/10 |
| N-06 | `event.restore` 入审批清单 | ✅ |
| N-06 | `task.upsert` 入审批清单 | ✅ |
| M3'/N-11 | 两 scope 各 1 条 | ✅ 2 |
| M3'/N-11 | 只删该 scope 的 | ✅ `['ev1']` |
| M3'/N-11 | 另一 scope 保留 | ✅ 1 |
| N-08 | 删除失败计入 failed | ✅ 1 |
| N-08 | 标记 `op=remove` | ✅ |
| 保留上限 | 上限内全部建立 | ✅ 8 |

## 三、自查发现的已知限制（不掩盖）

### L-1（已知限制，非本轮引入）：映射丢失会产生孤儿

复现：建立提醒 → 清空本地 `hostMap`（模拟文件丢失）→ 再对账。

```
宿主 2 条，created=1，unmapped=1
```

**行为**：宿主侧旧行成为**孤儿**（仍会投递），新行是本次建的；`unmapped` 有告警但**不自动清理**。

**为什么不清**：清它就要删宿主行，而我们无法确认那条行是不是本应用建的（映射正是唯一凭据）。猜错的代价是删掉别人的提醒，比留孤儿更严重。

**结论**：这是**用可观测性换安全性**的有意取舍，已作为已知限制记录。上层 UI 应展示 `needsAttention`。

## 四、变异验证

`scripts/r3-mutate.mjs`（Node + JSON 定义，取代有引号 bug 的 shell 版）
**25 变异 / 25 CAUGHT / 0 VACUUM / 0 SKIP**

包含第三轮 Review 指出的 6 处真空点（X6/X11/X12/X13/X14 及 X15~X18 新增守卫）。
其中 X6 首版是**等价变异**（degraded 时 active 集本就为空），我换成了真正改变行为的版本才计入 CAUGHT。

## 五、测试与门禁

| 项 | 结果 |
| --- | --- |
| 单元/集成测试 | **191 / 191 pass，0 fail，0 skip** |
| demo | EXIT 0 |
| 真实 Service L4（`scripts/r3-real-service.mjs`） | EXIT 0 |
| 8 项验收（`scripts/r3-acceptance.mjs`） | 26/26 PASS |
| 变异 | 25/25 CAUGHT |

## 六、口径（能说与不能说）

**能说**：
- 第二轮、第三轮 Review 的全部 blocker / major 已修，并有测试与变异双重锁定；
- 真实契约已用**真实代码**验证（L1-L3 + L4 真 Context 实例化）；
- 审批旁路（store/events）、deny 失效、scope 永不匹配三处实质安全缺陷已闭合。

**不能说**：
- ❌「已通过第三方复审」——第四轮第三方结论未产出；
- ❌「生产环境端到端已验证」——L4 用的是假 storageDomain，非真实 Host 生命周期；
- ❌「macOS 系统级已验收」——休眠/唤醒/重启完全未测。

## 七、UNVERIFIED 清单

| 项 | 原因 |
| --- | --- |
| 真实 Host 的 fiber/effect 生命周期 | L4 用假 storageDomain |
| 真实宿主投递历史真值 | 无工具可读，仅契约 stub 层验证 |
| 真实 macOS 休眠 / 唤醒 / 退出 / 重启 | 未执行 |
| 系统通知是否真正弹出 | 未验证 |
| 多进程并发写 | 文件存储非多进程安全 |
| 第四轮第三方审查结论 | 未产出 |

## 八、STOP

未进入 WP3。

**建议**：第三方复审连续三/四轮回传失败，不应再靠消息回收结论。
若要继续用 Agent 复审，应改为「Agent 必须写指定文件 + 主会话轮询读取」并把
`VERDICT.md` 的存在作为流程门禁；否则应由人工审查收口。

---

## 九、第四轮复审失败，但它留下的探针抓到了真 bug

第四轮 Reviewer **失败退出**（`failed before it finished, no closing message`），
`VERDICT.md` 未产出。但它在 `/tmp/wp2r4rev/probe/` 留下了一个探针，
**这个探针抓到了一个我自己漏掉的严重回归**：

`p1-n02-recover-deletes-active.mjs` —— 探针标题就是答案：
「N-02 修复后的真实行为：UNKNOWN 的 plan 会不会同时把『宿主上仍 active 的那行』删掉？」

### 探针输出（它跑出来的）

```
--- A. history 抛错（宿主读不到投递状态），提醒仍是 active
  宿主 before = ["schedule-1/active"]
  recover = {"restored":[],"unknown":[{"reminderKey":"k","reason":"history-unavailable"}],"removed":["k"],...}
  宿主 after  = []   ❌ 行被删掉 → 用户再也收不到这条提醒

--- B. 回执被 retention 裁剪（records=[] + earlierRecordsUnavailable=true），行仍 active
  宿主 before = ["schedule-1/active"]
  recover = {"restored":[],"unknown":[{"reminderKey":"k","reason":"history-pruned"}],"removed":["k"],...}
  宿主 after  = []   ❌ 行被删掉 → 用户再也收不到这条提醒
```

### 我复现确认：成立

同一脚本在当前代码上重跑，**同样复现**（`removed:["k"]`，宿主行被删）。

### 根因：把「不重建」写成了「删掉」

我修 N-02 时，让 UNKNOWN 的 plan **不进入 `future`**。但 `reconcile` 的语义是
「不在 desired 里的 active 记录 = 多余项 → 删除」。于是：

```
投递状态 UNKNOWN → 不进 future → 不在 desired → 被判多余 → 删除
```

**投递状态未知，只意味着「我们不知道它投递过没有」，不意味着「它不该存在」。**
宿主上那条提醒仍然 active、仍然有效，删掉它等于让用户永远收不到。

### 修法

1. `reconcile(plans, { protect: [...] })`：受保护的 key **不得删除**；
2. `recover` 把 UNKNOWN 的 key 传进去：`protect: unknown.map(u => u.reminderKey)`；
3. 返回值增加 `protected` 字段，让上层看得见「哪些被保住了」。

修复后：

```
--- A. history 抛错 → UNKNOWN
  restored=[] unknown=[...] removed=[]      ✅ 行仍在（schedule-1/active）
--- B. 回执被裁剪 → UNKNOWN
  restored=[] unknown=[...] removed=[]      ✅ 行仍在
```

### 回归锁定

- 两条测试（每例独立环境）：`N-17 守卫：投递状态 UNKNOWN 时不得删除宿主上仍然 active 的提醒`
  （覆盖 history 抛错与回执裁剪两种来源）、`N-17 守卫：protect 集合里的 key 不会被 reconcile 删除`
- 两个变异点：`X19`（reconcile 忽略 protect）、`X20`（recover 不传 protect）——**两者都被捕获**

### 这次故障的额外收获：探针脚本比结论更有价值

复审 Agent **没写成结论就崩了**，但它写下的探针把一个我漏掉的严重 bug 钉了出来。
**过程材料（探针/日志）比结论更可靠**——结论靠消息回传，探针在磁盘上。
以后复审必须要求把探针和日志一并留在固定目录。

## 十、变异脚本的两处自身缺陷（已修）

| 缺陷 | 现象 | 修法 |
| --- | --- | --- |
| 锚点漂移 | M5、X12 因代码改动后锚点文本变了 → **SKIP**，而 SKIP 不算失败 → 这两个保护点**根本没被检验**却混在结果里 | 修正锚点；并把 **SKIP 视为失败**（`vacuum=0 且 skip=0` 才算验证充分） |
| 等价变异 | 我一度把 X6 写成等价变异（degraded 时 active 集本就为空） | 换成真正改变行为的版本才计入 CAUGHT |

最终：**27 变异 / 27 CAUGHT / 0 VACUUM / 0 SKIP**。
