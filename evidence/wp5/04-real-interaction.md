# WP5 真实交互验证记录（第二轮）

日期：2026-11-07
实例：隔离 DSH（`DSH_HOME=/tmp/dsh-iso-Jv2UeM`，端口 63224，`--profile rescue`）
插件：`@local/dsh-workbench-ui` → `link:<repo>/packages/workbench-ui`（软链，重启即加载最新源码）
数据分片：`workbench-data/s-bf0375b189d1ce0db01d93f9/workbench.json`

> 隔离实例的原因：正式 GUI（`http://127.0.0.1:62386`）属于红线区域，本轮不得改动其 profile 与数据。
> 插件走软链，所以每次重启隔离实例加载的就是当前工作树代码，验证结果对应 HEAD 后的工作树状态。

## 验证方法

每条都用同一个闭环：**UI 操作 → 立即读磁盘 `workbench.json` → 对比操作前后字段**。
磁盘是唯一真相源；界面显示不作为证据。

## 1. 键盘 ←/→ 改期（W35 回归）

W35 缺陷是：`nudgeEventDay` 首行判 `sel.kind !== 'event'` 而三处选中入口裸透传，
导致键盘方向键 **0 次触发**。修复后实测：

| 步骤 | 磁盘 `events[0].start` | 结论 |
| --- | --- | --- |
| 操作前 | `2026-11-07T09:00:00` | 基线 |
| 点选事件 + `ArrowRight` | `2026-11-08T09:00` | 日期 +1，真实改期 |
| `ArrowLeft` | `2026-11-07T09:00` | 日期 −1，可逆 |
| 裸 `z`（无 modifier） | `2026-11-07T09:00` | 无副作用，modifier 守卫正确 |

## 1.5 界面本地化（第二轮审查 M-1 的真机延伸）

审查 M-1 只指出两个弹窗没接 `t`。真机把范围扩到整个渲染路径，发现**中英混排远不止弹窗**：

| 位置 | 混排原文 | 根因 | 修法 |
| --- | --- | --- | --- |
| 视图 tablist | `View` | `aria-label: 'View'` 硬编码 | `t('view')` |
| 详情面板空态 | `Select an event or task to see details` | 硬编码字面量 | `t('selectToSeeDetails')` |
| 星期表头 | `Mon Tue Wed …` | 模块级 `WEEKDAYS` 英文常量 | `weekdayLabels(t)`，渲染时取 |
| 日期标题 | `Sat Nov 07 2026` | `cursor.toDateString()` 由引擎给英文 | `formatCursor(cursor, t)`，按 `dateLocale` |
| 事件 aria | `Open 键盘改期验证` | `'Open ' + title` 拼接 | `t('openLabel').replace('{title}', …)` |
| 审批弹窗摘要 | `Import ICS data` | 构造器内硬编码 | 构造器加可选 `summary` 参数，生产路径传本地化值 |

**验证**：改完后刷新真实页面，用 DOM 快照全量提取所有 `text`/`name` 字段，
过滤掉纯数字与快捷键提示（`N`）后，**英文残留 0 条**，其余全部中文
（含日历格 aria `2026-11-07, 1 个事件; 拖放可改期`、提醒条 `1 条算不出提醒时刻（数据有问题，不会响）`）。

> 注：`Mon`/`Sat Nov 07 2026` 这类由 JS 引擎生成的英文不会出现在源码里，
> 只靠源码扫描（连中文扫描器）都抓不到 —— **只有真机 DOM 能暴露**。
> 这也是本轮「368 全绿仍要真机复核」的直接理由。

### 1.6 真机白屏与归档报错（第二轮审查未覆盖，368 全绿时仍然崩的两个真缺陷）

上面 1.5 修完、`368/368` 全绿、变异 `98/98` 全捕获之后，真机仍然**崩了两次**：

| 现象 | 真机证据 | 根因 | 修法 |
| --- | --- | --- | --- |
| 「待办」视图整块白屏 | console `TypeError: t is not a function`，`slot entry crashed in 'main'` | `g.rows.map((t) => …)` 用 `t` 当行变量，同作用域把本地化**函数** `t` 覆盖成行对象，`t('archive')` 于是调不动 | 行变量改名 `row`，归档区 mapper 同步改名 |
| 点「归档」报 `错误: id 或 ids 必须提供` | 状态栏原文，Host 拒收 `id: undefined` | 行变量已改名，但按钮里残留 `setArchived(t.id, true)`、`...t`（`t.id` 恒为 undefined） | 改 `setArchived(row.id, true)`、`...row` |
| 归档折叠区标题 `分组（1）` | 语义错误：里面装的是**已归档**待办 | 误用 `t('grouped')`（「分组」）当折叠区标题 | 新增 `t('archivedSection')`（已归档 / Archived），并删掉变死键的 `grouped` |

另修真机才看得见的英文残留，分三批：

| 批次 | 残留 | 位置 |
| --- | --- | --- |
| 第一批 | `Complete`/`Reopen`、`Details of …` | 待办行的完成按钮、详情按钮 aria |
| 第二批 | `Task`/`Event`/`(untitled)`/`ID`/`Due`/`Start`/`Description`/`Repeats`/`Subtasks`/`Conflict`/`AI session` | 右侧详情面板整块标签 |
| 第三批 | `Title`/`All day`/`Time`/`Date`/`Description`/`Priority`/`Low`/`Normal`/`High`、`Due (ISO instant)`、`Repeat`/`Conflict` 徽标、`Confirm delete`、`Host approval was not granted`、`Task reopened`/`Task completed`、`Deleted after Host approval`、`Edit`/`New` | 两个表单的全部标签、AgendaList 徽标、删除确认、审批失败提示、操作回执 |

`LOCALE` 从 119 键扩到 **154 键/语言，死键 0（除白名单 `meta`）**。
最后用三条精确扫描确认渲染路径零英文：`h(…, null, '英文')` 标签、`'aria-label': '英文'`、`setNotice/setError('英文')` —— 均 0 条。

> 第三批里挖出一个**和前面同源的 `t` 遮蔽**：`const toggleTask = async (t) => { … }`
> 形参又叫 `t`，里面 `t.done` 是拿字段（合法），但一旦有人在这个函数里加一句
> `t('…')` 就会立刻崩 —— 而 `setNotice` 的两个分支正好写成了英文硬编码，
> 说明当时的改动已经踩在这条边界上。已改名 `task` 并把文案接 `t`。

**这三条为什么 368 全绿没抓到**：没有任何测试**真的渲染**组件。`makeReact()` 的 `useState`
返回 no-op setter、`useEffect` 是空函数，组件树根本跑不起来，所以「渲染时 `t` 被遮蔽」这类
缺陷只能靠源码结构扫描或真机。已补两条结构性守卫（见 `03-delivery.md` 的 W53–W56）：
一条扫「行渲染区间内 `t.xxx` 属性访问 / `...t` 展开」，一条扫「`t` 被当回调形参」。

> 教训再确认一次：**字符串存在 ≠ 行为正确，测试全绿 ≠ 界面能用。**
> 这三条里，白屏会让整个功能不可用，归档报错会让「归档」这个 WP5 验收项直接失败 ——
> 而它们在修复前的全量测试里全是绿的。

## 1.8 主路径真机复验（修复后，同 session 不重导航）

第三轮审查的 BLOCKER 修完后，逐条在真机走了一遍，每步都对照磁盘。
**全部在同一个 session 内完成**（重导航会换 shard，数据看不见）。

| 交互 | 真机表现 | 磁盘证据 |
| --- | --- | --- |
| 待办「完成」 | 点 checkbox 后行移出「计划中」，提示「已完成」 | `排序验证B.done: false → true`（mtime 11:07:58） |
| 详情面板按钮 | 三个按钮从 `Edit` / `Delete…` / `Close` 变「编辑 / 删除… / 关闭」 | — |
| 删除确认框 | 「This requires Host approval…」→「删除“排序验证D”需要宿主审批。」；按钮「申请审批并删除」 | — |
| 删除（走审批） | 提示「已通过宿主审批删除」，列表 3→2，撤销 13→14 | `D.deleted=true`，`deletedAt` 有值，undo 深度 +1 |
| 撤销 | 提示「已撤销上一步」，D 回列表，2→3，重做按钮由灰变亮 | `D.deleted` 回到 `undefined`；`undo=13 / redo=1` |
| 重做 | 提示「已重做」，D 再次消失，撤销 14 | `D.deleted=true`，`deletedAt` 与原值**逐字节一致**；`undo=14 / redo=0` |
| 键盘下移排序 | A 从第 1 行挪到第 2 行 | `A.order: 0→1`、`B.order: 1→0`、`C.order: 2`；undo 新增 `task.reorder` |
| 刷新后一致性 | 撤销步数 15、顺序 A/C 与磁盘一致 | 与磁盘 `undo=15`、order 值完全对齐 |
| 归档 | 提示「已归档」，A 移出主列表，出现「▸ 已归档（1）」 | `A.archived=true`；undo 新增 `task.archive` |
| 展开归档区 + 恢复 | 归档行显示「恢复」按钮，点击后 A 回主列表 | `A.archived` 回到 `undefined`；undo 新增 `task.unarchive` |

> **归档恢复走的是 `task.archive` + `{archived:false}`**，不是不存在的
> `task.unarchive` handler。undo 的 label 是 `task.unarchive` 但 op 是
> `task.archive` —— 这正是 `service.js:902/909` 的设计，两者不能混为一谈。

### 本轮真机又抓到的残留（第 8、9 批）

审查和测试都没发现，只有真机看得到：

| 批次 | 位置 | 问题 |
| --- | --- | --- |
| 第八批 | 详情面板操作区 | `Edit` / `Delete…` / `Close` 三个按钮硬编码英文；`Delete ${kind} ${id}` 的审批摘要也是英文，会原样弹给用户看 |
| 第九批 | 删除确认框 | `This requires Host approval before deleting “…”`、`Requesting approval…`、`Request approval & delete` 三处英文 |

处置：全部接 `t()`，新增 6 个 locale 键（`edit` / `deleteAction` / `close` /
`deleteSummary` / `confirmDeleteHint` / `requestingApproval` / `requestApprovalDelete`），
`LOCALE` 154→**163** 键/语言，死键仍只有 `meta`。

### 导入预览的计数重复（真机 + 服务端双向确认）

准备了一份含「1 条重复 UID + 1 条新增 + 2 条冲突」的 ICS，
先用服务端 `event.previewIcs` 直接跑：

```
counts: {"create":1,"duplicate":0,"conflict":2,"degraded":0,"unsupported":0,"skip":2}
```

问题在 `skip` 的定义：`service.js:568` 是
`plan.filter((x) => x.action !== 'create').length`，也就是
**skip = duplicate + conflict + unsupported**，是个兼容字段。
而 UI 把 duplicate / conflict / unsupported 各自单独成行后，又把原始
`skip` 原样显示 —— 同一条被数两次：2 条冲突显示成「冲突 2」+「跳过 2」，
用户以为 4 条有问题。

处置：`buildIcsCounts` 里从 `skip` 扣掉已单独展示的三类，钳到 0；
新增测试锁住「新增+冲突+重复+不支持+跳过 = 服务端总条目数，不得翻倍」，
并加变异 **W60**（原样透出 skip）与 **W61**（漏扣 conflict）防止回退。

## 1.7 第三轮独立审查：主路径上又漏了两次（冻结副本实证）

第三轮审查（`git archive 8d95491` 冻结副本）判 **REQUEST CHANGES / 1 BLOCKER**。
它没靠读代码猜，而是把 payload 打到真实 service 复现：

| 项 | 结论 | 实证 |
| --- | --- | --- |
| 待办完成/重开 100% 失败 | **BLOCKER** | `toggleTask(t)` 把本地化**函数**当待办传，实际发出 `{"task":{"done":true}}`，Host 回 `task.id 必须是非空字符串`；改成 `toggleTask(row)` 即成功 |
| 删除路径同样遮蔽 | 同源第六处 | `const t = tasks.find(...)` 用 `t` 作局部变量，同作用域 `t('approvalNotGranted')` / `t('deletedAfterApproval')` 全崩 |
| 3 个 locale 键未定义 | MINOR | `nothingToUndo` / `nothingToRedo` / `archiveHint` 被 `t()` 调用但 LOCALE 里没有，`defaultT` 回落成键名 → 真机直接显示字面量 |
| 两条结构守卫覆盖不足 | MAJOR | 只认 `(t) =>` 与 `t.xxx`，抓不到「把 `t` 当实参传递」「`const t =` 遮蔽」；`toggleTask(t)` 在切片内却漏判 |
| 证据不同步 | MAJOR | 提交的 `01-mutation.log` 停在 `CAUGHT: 100`，W55/W56 缺席，与 `03-delivery.md` 声称的 102 不符 |

处置不是再补三个特例。同类缺陷已经出现 **七次**，每次守卫都只覆盖刚看到的那一种写法。
这次改成**语法约定 + 无条件判据**：全文件 `t` 只允许表示翻译函数；
数据变量一律叫 `task` / `row` / `target`。据此把 11 处纯数据函数的 `t` 全部改名，
再写一条不依赖作用域分析的全文件守卫（含 `used ⊆ defined` 反向断言，
堵住「用了没定义的键」这个洞）。五种形态逐一注入验证全部捕获：
`toggleTask(t)` / `const t = tasks.find` / `setArchived(t.id)` / `...t` / mapper 形参退回 `t`。

> 这一轮的教训比前两轮更硬：**前两轮把「字符串存在」当行为正确，
> 第三轮的 370/370 + 102/102 又把「结构扫描」当行为正确。
> 真机主路径（点完成、点删除）依然是唯一能证伪的 oracle。**

## 2. 撤销 / 重做（真实按钮，含归档语义回滚）

第一轮验证了「改期 → 撤销 → 重做」；本轮再验一遍**归档/恢复**语义的撤销，
因为归档不是改字段而是加/删 `archived`，撤销写错会静默把待办弄丢：

| 步骤 | 磁盘 `undo` | 磁盘 `redo` | `排序验证B.archived` |
| --- | --- | --- | --- |
| 初始 | 10 | 0 | `null` |
| 点「归档」 | 11 | 0 | `true` |
| 展开 + 点「恢复」 | 12 | 0 | `null` |
| 点「撤销」 | 11 | **1** | **`true`**（回滚成归档） |
| 点「重做」 | 12 | **0** | **`null`**（恢复回来） |

双向都动、`redo` 在重做后被清空、`archived` 字段被精确加删 —— 与 `history.status`
契约一致。磁盘 `undo` 标签依次为 `…,task.archive,task.unarchive,…,task.reorder,task.archive`，
证明「恢复」和「归档」各自入栈一次，没有合并成一条（合并会让用户撤不回去）。

界面同时显示 `可撤销步数：12`。

## 3. 归档 / 恢复（归档 ≠ 软删）

| 步骤 | `archived` | `deleted` |
| --- | --- | --- |
| 点「归档」 | `true` | `undefined` |
| 点「恢复」 | `undefined` | `undefined` |

关键点：**归档只写 `archived`，从不碰 `deleted`**（契约 §2.3）。
恢复走 `task.archive` + `{archived:false}` —— 不是 `task.unarchive`（后者在服务端只是审计标签，不是 op）。

界面侧证据：归档后主列表显示「当前视图没有待办」，折叠区出现 `已归档（1）`；
展开后行内出现「恢复」按钮；恢复后状态条显示「已恢复」。

## 4. 排序落盘（task.reorder）

新建 `排序验证C`、`排序验证D` 后，在「计划中」视图点 D 的上移箭头：

| 任务 | 操作前 `order` | 操作后 `order` |
| --- | --- | --- |
| 排序验证A | `undefined` | 0 |
| 排序验证B | `undefined` | 1 |
| 排序验证C | `undefined` | 3 |
| 排序验证D | `undefined` | 2 |

`order` 是**整组重排**（0..3 连续），D 从 3 提到 2，C 顺延到 3。
刷新页面后重新读盘，四个 `order` 值不变 —— 持久化确认，不是内存幻象。

## 5. 刷新后一致性

`browser_navigate` 重新加载同一 URL 后：

- 磁盘：4 个任务 `order` 全保留，`archived` 全为 `undefined`，`undo=10`、`redo=0`
- 界面：面板重新打开，`键盘改期验证` 仍在 7 号格，提醒条正常，状态条 `Loaded from Host Service`

## 6. 到期时间校验（本轮新修缺陷）

缺陷：`TaskForm` 的 `dueAt` **完全无校验**，空串和任意文本都会直接写进 Host。
真实后果：提醒编译对该任务报「算不出提醒时刻（数据有问题，不会响）」——
一条永远不会响的待办，比没有待办更危险。

实测（输入标题 `校验验证E`、Due 填 `排序验证`、点 Save）：

| 检查 | 结果 |
| --- | --- |
| Host 里是否出现该任务 | **没有**（任务总数仍为 4） |
| 输入框下方是否给提示 | **有**：`到期时间必须是合法的 ISO 时刻（例如 2026-11-10T09:00:00Z），或者留空。` |
| 表单是否提交 | 否，留在原表单 |

对照：修复前同样的输入会落盘，磁盘上留下 `dueAt: "排序验证"`（该脏数据仍在
`排序验证A` 上，是本轮之前留下的实证）。

## 7. 提醒条（真实渲染 + 坏数据降级）

`⏰ 提醒  08:45 键盘改期验证  08:45 排序验证B  1 条算不出提醒时刻（数据有问题，不会响）`

- 提醒编译在真实页面确实运行（两条正常提醒带时刻）
- 对坏数据（`排序验证A` 的 `dueAt: "排序验证"`）采取 **安全降级：不响并明示**，
  而不是静默吞掉

## 未验证项（如实披露，不用模拟结果冒充）

| 项 | 原因 |
| --- | --- |
| 真实 HTML5 拖拽手势（MonthView/AgendaList 拖拽改期） | `browser_click` 无法产生 dragstart/dragover/drop 序列；CDP 9222 已关闭 |
| 真实拖拽排序手势 | 同上；已用等价路径「上移/下移」按钮验证 `task.reorder` 落盘 |
| 文件选择器导入（原生 `<input type="file">`） | 原生文件对话框不可由浏览器工具驱动；预览/审批/执行逻辑已由 `verify-wp5-ui.mjs` 与单测覆盖 |
| 真实 Cmd+Z / Cmd+Shift+Z | `browser_press` 不支持 modifier 组合；已用「撤销/重做」按钮验证同一底层路径 |
| 明暗主题截图对比 | 未找到可信的主题切换入口；组件全部使用 `--dsw-alias-*` 令牌、无硬编码颜色，跟随宿主主题 |
| 窗口尺寸响应式截图 | 宿主未提供改窗工具；代码有 `@media (max-width:800px)` 断点，未做真实缩窗验证 |
| 屏幕阅读器 / 焦点顺序 | 无可用读屏工具；`role=status`、`aria-live=polite`、`aria-label` 已在源码层就位 |
| 真实交付回执 / 恰好一次、macOS 通知、多进程写入 | 与本轮 WP5 范围无关，结转 |

## 截图

浏览器截图仅内联返回，不落盘（工具不提供保存路径）。因此本记录以
**磁盘字段对比**为主证据，界面描述为辅。`evidence/wp5/screens/` 保持为空是
如实结果，不用重绘图片冒充。
