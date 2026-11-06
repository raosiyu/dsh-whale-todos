# WP5 契约与断点存档

> 状态：**进行中（已暂停）**。本文是 WP5 的开工契约 + 断点续跑指引。
> 基线 Commit：`ec58306`（WP5 授权时的 HEAD，dirty 0，0 remotes）
> 当前 HEAD：`4f534f8`
> 暂停时间：2026-11-06

## 一、开工前置核查（WP5-0）

### 1.1 Git 状态

| 项 | 值 |
| --- | --- |
| 基线 Commit | `ec58306` |
| 远端数量 | **0**（从未 push，授权要求不 push） |
| 基线 dirty | 0 |
| WP5 提交 | `1e1031f`(WP5-1) → `7855dab`(WP5-2) → `4f534f8`(WP5-3) |

### 1.2 既有能力盘点（复用，不重写）

WP5 授权明确「复用 WP1–WP4 的 Host Service / 数据模型 / 审批 / 审计，不得重写既有业务逻辑」。
开工前逐项核对，确认下列能力**已经存在**，WP5 只做增量：

| 能力 | 位置 | WP5 如何用 |
| --- | --- | --- |
| 统一业务门面 `execute(op,payload,meta)` | `workbench-core/src/service.js` | 所有新 op 挂在同一张 dispatch 表 |
| 审批门（指纹 + 一次性凭证） | `src/approval-gate.js` | 批量/覆盖类新 op 复用它，不新建门 |
| 审计日志 | `store.mutate` 内 `draft.audit.push` | 新 op 全部写审计 |
| 原子写 + journal 崩溃恢复 | `src/store.js` | 导入失败回滚靠 `store.rollback` |
| 备份 / 恢复 | `store.backup` / `listBackups` / `rollback` | 导入前自动备份 |
| ICS 解析 + 导出 | `src/ics.js` | 增强，不重写 |
| JSON 快照导出/解析 | `src/ics.js` `exportJson` / `parseJsonSnapshot` | 增强，不重写 |
| 重复展开 | `src/recurrence.js` | 增强（新增单次例外） |
| 冲突检测 | `src/conflict.js` | 直接复用 |
| AI 工具面 | `src/host-tools.js` | 增量加工具，危险 op 不加 |

### 1.3 测试与变异基线（授权要求「保留既有 283 项测试与 53 项变异测试」）

- 既有测试：**283/283** 通过（基线实测）
- 既有变异：**53/53** CAUGHT
- WP5 增量：**+20**（`move` 7 + `task-wp5` 6 + `import-wp5` 7）
- 当前合计：**303/303**

逐文件实测（不信任总数，每个文件单独跑）：

```
bypass                     16      import-wp5                  7
conflict                   13      move                        7
contract                   57      recurrence                 22
host-approval-real          2      reminder-recovery          10
host-service               11      schedule                   29
host-tools                 20      schema                     13
ics                        16      service                    21
store                      12      task-wp5                    6
workbench-ui-bridge        26      workbench-ui-render         5
workbench-ui-standards     10
---------------------------------------------
TOTAL                     303
```

## 二、设计决策（已落地部分）

### 2.1 重复日程的「单次 vs 系列」——必须显式，不允许猜

**问题**：开工核查发现 `recurrence.js` **没有 EXDATE / 例外模型**。重复事件只能整体
`status:'cancelled'`，无法表达「只改这一次」。而 WP5 授权原文要求：

> 重复日程必须明确区分「单次」与「整个系列」，不支持的操作必须明确拒绝。

**决策**：新增 `excludeDates`（RRULE EXDATE 语义）到 Event 模型，`event.move` 强制要求
调用方显式声明 `mode`：

| mode | 语义 | 非重复事件 | 重复事件 |
| --- | --- | --- | --- |
| `single` | 只改这一次 | **拒绝**（`validation`） | EXDATE + 新建独立事件 |
| `series` | 整个系列 | 整体移动 | 整体移动（`excludeDates` 随系列平移） |
| `thisAndFuture` | 此后所有 | — | **明确拒绝**（`unsupported`） |

`thisAndFuture` 拒绝的理由：本数据模型没有 RRULE 分段（没有「从此处拆成两条规则」的
表达），假装支持会写出一份语义错误的日历。这是授权要求的「不支持必须明确拒绝」，
而不是「静默近似」。

**`single` 的实现**：把被拖动的实例日期写进原事件 `excludeDates`，再新建一条**非重复**
事件承载新时间，其余字段（title/description/location/importance/tags）全部保留。
系列其余实例完全不动。

**过程中发现两个真实 bug（都是「静默丢字段」类，本项目此前踩过）**：

1. `event-repo.js` 的 `PATCHABLE` 白名单不含 `excludeDates` → patch 被静默丢弃 →
   被排除的实例又回来了。
2. `mergePatch` 的基准对象不含 `excludeDates` → 任何一次 update 都会让此前排除的
   实例全部「复活」。

两处均已修复并有测试覆盖。

### 2.2 待办排序：传全量顺序，不传「挪到谁前面」

**决策**：`task.reorder` 接收**完整目标顺序** `ids`，而不是「把 A 放到 B 前面」。

理由：移动指令要求服务端重建整个序列，一旦客户端状态陈旧或并发，就会算出用户
**没看见过**的顺序。传全量则幂等、可校验（重复 id、未知 id 一律整批拒绝）。

只写 `order` 字段，其它字段一个不碰（授权明令「排序或编辑不得丢失字段」）。
`project` 作为可选 scope，跨组排序直接拒绝，防止排一个组把另一个组重新编号。

### 2.3 归档 ≠ 软删

**决策**：归档用独立字段 `archived`，不复用 `deleted`。

| | 归档 `archived` | 软删 `deleted` |
| --- | --- | --- |
| 语义 | 做完了、收起来 | 删掉 |
| 仍在 `task.list` | 是 | 否（除非 `includeDeleted`） |
| 需要审批 | **否**（非破坏性） | 是 |
| 恢复 | 清掉字段，无残留 | `event.restore`/`task.upsert` 需审批 |

两者同时为真时以 `deleted` 为准，避免「归档后删掉、恢复归档时又冒出来」。

### 2.4 导入预览必须分四类

**决策**：`event.previewIcs` 与 `snapshot.preview` 逐条给出 `action`，并统计
`create / duplicate / conflict / unsupported` 四类。

**过程中发现两个真实 bug（都是「静默丢弃」类，正是授权明令禁止的）**：

1. **不支持的组件检测从来没有执行过**。`ics.js` 里
   `if (!inEvent) continue` 排在 VTODO 检测之前，而 VTODO 永远出现在 VEVENT 之外
   → 该分支一次都没跑到。含 VTODO 的日历会「导入成功」但任务全部消失且无警告。
2. **`parseRRule` 不校验 `FREQ`**。`RRULE:FREQ=BOGUS` 静默产出一个非法规则，
   导入后要么抛错要么干脆不重复，用户看不到原因。现在显式抛错并进结构化
   `unsupported`。

`unsupported` 是**结构化**的 `{kind, detail, reason}`，不是自由文本 —— 机器能逐条核对。
被拒 RRULE 的事件本身仍有效，会导入但标记 `degraded`（规则丢了，事件还在），
预览把这条也计进 `counts.degraded`。

`snapshot.preview` 额外报告覆盖式导入**会删掉哪些**既有条目（`removedEvents`/
`removedTasks`）—— `snapshot.replace` 是破坏性的，用户确认前有权知道代价。

### 2.5 审批红线：导入执行不进 AI 工具面

**过程中犯的错，已纠正**：一开始把 `workbench_import_apply` 暴露给了模型，
被 WP3 的既有测试当场拦下（`event.import` 属于危险 op，不得出现在工具面）。

现在工具面只有 `workbench_import_preview`（只读）和 `workbench_export`（只读）；
**导入执行仍然只能走 UI + Host 审批**。模型可以预览、可以告诉用户要导入什么，
但不能自己按下导入。

顺带修了那条测试的**子串匹配缺陷**：它用 `name.includes('import')` 判断，会把
只读的 `workbench_import_preview` 误判成危险 op —— 而它恰恰是要求模型先调的那个。
改成精确名单匹配。

## 三、断点：已完成 / 未完成

### 已完成并各自独立提交

| 包 | Commit | 内容 | 测试 |
| --- | --- | --- | --- |
| WP5-1 | `1e1031f` | `event.move`（单次/系列/明确拒绝）、`excludeDates` 模型 | +7 |
| WP5-2 | `7855dab` | `task.reorder`、`task.archive`、分组、父子保持 | +6 |
| WP5-3 | `4f534f8` | ICS/JSON 预览四分类、结构化 unsupported、两个静默丢弃 bug | +7 |

### 未完成（续跑时从这里接）

1. **WP5-4 撤销/重做与错误恢复**：`undo` 栈尚未设计。仓库已有 `store.backup`/
   `rollback` 与 journal，可以在此基础上做「操作级撤销」，但**没有**做成 op。
   - 待定问题：撤销粒度（单 op 还是事务）、撤销后 AI 与 UI 视图如何一致、
     跨进程是否持久。
2. **WP5-5 UI 层**：`packages/workbench-ui/client.js`（862 行）**尚未改动**。
   WP5-1/2/3 目前只有 Host 侧 + AI 工具侧能力，UI 还没有拖拽、排序、导入预览面板。
   这是 WP5 最大的剩余工作量。
3. **WP5-6 变异测试增量**：既有 53 项未动，WP5 新增变异（至少覆盖
   `excludeDates` 被丢、`event.move` 的 mode 判定、预览四分类、`archived` 判定）
   尚未编写。**必须重跑 53/53 确认无回归**。
4. **WP5-7 视觉与真实交互验证**：Client Inspect 在 WP4 全程不可用
   （provider 拒绝合法 `{}`）。WP5 需**先重试**，仍不可用则按
   `references/verification.md` 明确记录 UNVERIFIED，**不制作模拟截图**。
5. **WP5-8 独立审查 + 交付报告**：冻结后独立 Agent 审查，证据放固定目录。

### 续跑第一步建议

先补 WP5-5 的 UI（拖拽 + 排序 + 导入预览面板），因为 UI 是「真实交互验证」的
前提；同时补 WP5-6 的变异测试，避免 Host 侧逻辑在 UI 接线过程中被悄悄改坏。

## 四、当前未验证项（必须原样带入最终报告）

- Client Inspect 通道不可用（WP4 全程如此），视觉/真实点击**未验证**
- 浏览器网络层 `ctx.remote.commands.execute` 端到端未验证
- 明暗主题截图、窗口缩放、真实键盘操作未验证
- macOS 通知 / 挂起未验证
- 多进程并发写未验证
- 真实 Host fiber/effect 生命周期未验证
- O(N²) 提醒对账性能问题仍 **UNRESOLVED**（见 `docs/wp3/01-on2-registry.md`）

## 五、红线自查

| 红线 | 状态 |
| --- | --- |
| 不修改正式 DSH profile | 待核验（`~/.dsh/profiles/desktop` 内容 grep = 0） |
| 不修改既有用户数据 | 是（所有测试用临时目录） |
| 不修改其它项目 | 是 |
| 不 push | 是（0 remotes） |
| 不调用 Codex | 是 |
| 不使用假数据冒充真实功能 | 是（全部来自 Host Service） |
| 不制作模拟截图 | 是（无任何截图） |
