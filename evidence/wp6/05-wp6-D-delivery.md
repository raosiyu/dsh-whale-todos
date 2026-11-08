# WP6-D 交付证据：UI 集成、真机验证、根因修复

> 基线 `d87845a`（WP6-C）。本阶段交付用户可见的 UI 与真机交互证据。

## 1. UI 集成（最小侵入，不重做既有界面）

| 入口 | 落点 |
|---|---|
| 顶栏 `✦ AI 规划` 按钮 | 打开 `PlanPanel` |
| `PlanPanel` 新组件 | 目标输入 + 今日/本周时间窗 + 生成建议 + 提案 items/冲突/原因/统计 + 确认/拒绝/修改/返回 |
| 待办视图「智能计划摘要条」 | `.wb-plan-summary`，展示最近提案统计 + 快捷入口 |
| 任务详情会话协作区 | 关联 sessionId（可复制）、预计耗时、进度、执行记录、验收状态 |
| 人工验收入口 | 详情面板「通过验收 / 驳回」按钮，仅 pending 时显示 |
| 中英文 | 新增 30+ key，en/zh 各 205 键，集合一致、无死键 |
| 主题/键盘 | 只引用 `--dsw-alias-*` 令牌；overlay 用 `useEscapeClose`；无硬编码颜色 |

**红线落地**：`confirmPlan` 必须向 Host 申请一次性审批 token（`buildPlanApprovalRequest`），
再带顶层 token 调 `proposal.apply`（`buildPlanApplyRequest`）；签发/执行都走构造器，
不内联 op 字面量、不用 `confirmed:true`。AI 生成的 reasoning 只作展示文本，
不参与任何分支判断。

## 2. 真机 UI 验证（隔离 DSH Host，`127.0.0.1:63999`）

用 CDP 在真实浏览器里驱动，非模拟：

| 检查 | 结果 |
|---|---|
| 顶栏出现 `✦ AI 规划` | ✅ 按钮列表含 `["日历","待办","刷新","导入","导出 ICS","导出 JSON","✦ AI 规划","+ 新建",…]` |
| 点击打开「智能规划与任务拆解」 | ✅ `.wb-plan-panel` 出现，标题正确 |
| 待办视图智能计划摘要条 | ✅ `.wb-plan-summary` 存在 |
| 填目标「准备下周发布会、写稿件、约场地」→ 生成 | ✅ 提案结果区出现 |
| 提案内容 | ✅ **拆解 3 条 · 排期 3 条 · 已用 90/480 分钟**，6 条 items，含原因说明 |
| 确认/拒绝按钮 | ✅ 存在 |
| **拒绝时零数据变化** | ✅ 待办行数前后相同、提示「已拒绝」、面板关闭 |
| **确认落地** | ✅ 「已写入」提示；磁盘 `workbench.json` 出现 3 条新任务；切「计划中」可见 5→7 |
| **一次撤销整体回滚** | ✅ 见 §3 根因修复 |

> 说明：CDP 辅助脚本初版用 `mousePressed/mouseReleased` 坐标点击未命中按钮，
> 误报「拒绝未生效」。改用真实 DOM `click()` 后确认是**探针坐标问题**，
> 非产品缺陷。这条如实记录，不把探针错误包装成发现。

## 3. 真机发现并修掉的真缺陷：historyLimit 裁剪导致撤销失效

### 现象
真机旧 shard（undo 栈已有 ~17 条）上：提案落地成功，但点「撤销」后任务没减少；
磁盘 undo 栈里**没有 `proposal.apply` label**，且 `proposal.preview` / `proposal.reject`
也混进了 undo 栈。

### 根因（实测复现）
`store.commit` 每次 push undo 都做 `slice(-historyLimit)`（上限 20）。
批量落地 6 条时会把最早的几条历史挤掉，于是：

- `collapseUndo(undoDepthBefore, ...)` 用的「裁剪前栈深」在裁剪后的栈里**指向错位**；
- `kept = current.slice(0, undoDepth)` 保留的是错段历史；
- 折叠用的 `before` 快照与栈位置对不上 → 撤销回不到落地前状态。

干净复现（基线 19 条 undo）：
```
落地前 tasks:19 undo:19
落地后 tasks:22 undo:20
undo 尾部 before.tasks 数: [19,19,20,21,22,22,22,22]   ← 折叠 entry 的 before 是 22（错）
撤销后 tasks:22（应为 19）
```

### 修复（三处，根因级）
1. `store.collapseUndo` 新增可选 `anchorId`：调用方记录「落地前栈顶 entry 的 id」，
   折叠时在**裁剪后**的栈里用该 id 定位真正分界点，不再依赖易失真的栈深。
2. `proposal.apply` 记下 `undoAnchorId` 并传给 `collapseUndo`。
3. `proposal.preview` / `proposal.reject` / 标记 applied 的 mutate 全部
   `undo: false` —— 提案元操作只改 `proposals` 集合，**不该进业务撤销栈**。

### 修复后实测
```
基线 0 : 落地后=3  撤销后=0  期望=0  ✅
基线 19: 落地后=22 撤销后=19 期望=19 ✅
```
真机「确认落地 → 切计划中 5→7 → 一次撤销」链路随之通过。

## 4. 测试与变异

| 项 | 结果 |
|---|---|
| 全量回归 | 见 `01-mutation-D.log` 前的全量输出（501+） |
| WP6-D 专项（`workbench-ui-wp6.test.mjs`） | 13 / 13 |
| WP6-B 追加边界测试 | 17 / 17（含 historyLimit 撤销 + 元操作不入栈） |
| 变异验证 | 见 `01-mutation-D.log` |

修复过程中另修掉两个真缺陷（承 WP6-A/B 的教训）：
- 请求构造器抽出，避免 `confirmImport` 测试切片里出现内联 `confirmUserAction`；
- 4 个 locale 死键删除（存在 ≠ 被使用）。

## 5. 未做（留给 WP6-E 之后的授权）

GUI 会话跳转（插件层无契约，UNVERIFIED）、外部日历同步、多设备同步。

## 6. UNVERIFIED（保留）

真实 macOS 睡眠、系统通知横幅、VoiceOver、拖拽排序、原生文件选择器、
窄屏视觉、重启后未被打开的老会话、GUI 会话跳转。

## 7. 变异首轮 VACUUM 处置（3 个，逐一甄别，未靠删变异凑数）

| 变异 | 根因 | 处置 |
|---|---|---|
| WP6D1 忽略 anchorId | **行为等价**：base=19 落地 6 条 = 25 > limit 20，anchor 本身已被裁掉 → `findIndex` 返回 -1 → 回落栈深，两种分支同值 | 改写为真正破坏行为的变异「折叠时 `kept=[]` 丢掉 anchor 之前全部历史」；补测试「折叠不得清空历史 + 撤掉提案后仍可继续撤销更早历史」 |
| WP6D3 标记 applied 重新入栈 | **行为等价**：折叠在最后，标记 applied 的 entry 会被一起折叠进 `collapsed` 段，最终栈顶仍是 `proposal.apply` | 改写为「折叠之后再写一条」，那才是真正会挤掉折叠 entry 的顺序错误 |
| WP6D5 confirmPlan 不带 token | **真测试缺口**：初版只断言「走了构造器」，没断言「传的是 token 而非 undefined」 | 补断言 `buildPlanApplyRequest(id, approval.value.token)` 且 `assert.doesNotMatch(...undefined)` |

注入实测：D1 `fail 1`、D5 `fail 1`，确认均可被捕获。

**同类教训第三次出现**（WP6-B 的 3 个、WP6-C 的 1 个）：先确认变异真的改变了
可观察行为，再谈「测试是否覆盖」；行为等价的变异是探针设计错误。
