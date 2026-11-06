# WP5 交付记录

修订时间：2026-11-07
基线：`07255ee`（WP4 收口）→ HEAD `d88f751` + 本轮工作树变更
验证实例：隔离 DSH（`DSH_HOME=/tmp/dsh-iso-Jv2UeM`，端口 63224，`--profile rescue`）

> 本文件曾过早声称交付（写于 2026-11-06，当时独立审查尚未返回）。
> 审查结论为 **REQUEST CHANGES（2 BLOCKER + 4 MAJOR + 3 MINOR）**。
> 本次修订把审查项逐条落到「修了什么 / 怎么证明」，不保留未经证实的完成声明。

## 一、交付内容

| 能力 | 实现方式 | 复用服务端 op |
| --- | --- | --- |
| 日历拖拽改期 | 事件块 `draggable` → 日期格 `onDrop` | `event.move` |
| 跨日期移动 | 同上，目标日期由落点格决定 | `event.move` |
| 重复事件范围 | `MoveScopeDialog` 询问「只改这一次 / 改整个系列」 | `event.move` + `occurrenceDate` |
| 待办拖拽排序 | `wb-handle` 手柄拖拽 + ↑/↓ 键盘等价 | `task.reorder`（传完整顺序） |
| 项目分组 | 按 `project` 分组，组内按 `order` 排序 | `task.list` |
| 归档 / 恢复 | 归档区折叠面板 | `task.archive`（`{archived:true|false}`） |
| 导入预览 | `ImportPreview` 四类计数表 | `event.previewIcs` / `snapshot.preview` |
| 导入执行 | 用户确认 → Host 签发 token | `event.import` / `snapshot.replace` |
| 撤销 / 重做 | 工具栏按钮 + Ctrl/Cmd+Z | `history.undo` / `history.redo` |
| 失败回滚 | 失败即 `load(true)` 回真实值，无乐观更新 | — |
| 键盘替代 | 待办 ↑/↓；事件 ←/→ 改期 | 同 reorder / move |
| 到期时间校验 | `parseDueAt` 本地拦截坏值 | —（拦在落盘前） |

**`task.unarchive` 不是可调用的 op**：它在服务端只是 `task.archive` 内部的一个审计
`action` 标签。实测 `svc.execute('task.unarchive',{id})` → `unsupported`。
恢复的正确写法是 `task.archive` + `{id, archived:false}`。

## 二、独立审查项处置（本轮）

审查结论：**REQUEST CHANGES**。逐条处置如下。

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| B-1 | BLOCKER | `buildImportApprovalRequest` / `buildImportExecuteRequest` 是**死代码**，生产路径仍内联 | 已修：`confirmImport` 改调两个构造器；测试改为断言**调用点** |
| B-2 | BLOCKER | `buildArchiveRequest` 同为死代码 | 已修：`setArchived` 改调构造器 |
| M-1 | MAJOR | `pending.occurrenceDate ?? pending.dateKey` 变异存活 | 已修：显式守卫，缺源日直接报错不出请求 |
| M-2 | MAJOR | 服务端静默接受「落点冒充源日」 | 已修：`sameDayAsTarget && sameTime` 守卫 |
| M-3 | MAJOR | 新增 locale 键全为**死键**，`MoveScopeDialog`/`ImportPreview` 仍硬编码中文 | 已修：全部接 `t()`，`LOCALE` 48→**136** 键/语言，死键 0（白名单 `meta` 除外） |
| M-4 | MAJOR | `workbench_import_preview` 描述指向不存在的 `workbench_import_apply` | 已修：改为说明「预览只读，真正导入只在 UI 内由用户确认」 |
| m-1 | MINOR | `buildIcsCounts` 丢弃 `degraded`、硬写 `removed: 0` | 已修：两者都取服务端真实值 |
| m-3 | MINOR | `AgendaList.onDragStart` 不带 `occurrenceDate` | 已修 |

### 第二轮独立审查项处置

第二轮结论：**REQUEST CHANGES（1 BLOCKER + 1 MAJOR + 3 MINOR）**。

| 编号 | 级别 | 问题 | 处置 | 证据 |
| --- | --- | --- | --- | --- |
| B-1 | BLOCKER | 旧守卫 `sameDayAsTarget && sameTime` 允许「落点冒充源日 + 顺手改时刻」，服务端接受后静默损坏：`excludeDates` 记到落点日，源日实例还在，落点 09:00 被 10:00 顶掉 | 已修：`occurrenceDate === targetDate` 无条件拒绝 | 新测试 `复审 B-1…` 通过；变异 **W43 CAUGHT** |
| M-1 | MAJOR | `MoveScopeDialog`/`ImportPreview`/`StatusBar` 未接 `t`，回落英文后内部中文混排；**真机进一步暴露** `今日 & next 7 days` 等 22 处硬编码 | 已修：`LOCALE` 100→106 键/语言，死键 0，全部渲染点传 `t`，提示/提醒条/aria 全部本地化 | 测试 34/35/36；渲染路径中文硬编码扫描 **0 处** |
| m-1 | MINOR | `parseDueAt` 缺时区后缀校验，`'1'`/`'2026'` 等被 `Date.parse` 放行，落盘后被服务端拒 | 已修：加 `/(Z|[+-]\d{2}:?\d{2})$/` | 变异 **W48** |
| m-2 | MINOR | `buildIcsCounts` 用 `duplicate ?? c.skip` 兜底，把「跳过」显示成「重复」 | 已修：`skip` 独立字段，独立行 | 测试 362 + 变异 **W47** |
| m-3 | MINOR | `ImportPreview` 缺 `degraded` 行，降级解析条目混进「新增」 | 已修：独立 `degraded` 行 + 提示 | 测试 362 |

**真机发现比审查更深一层**：M-1 修完弹窗后页面仍中英混排。审查只看了两个弹窗，
真机把范围扩到整个渲染路径——这正是「字符串存在 ≠ 行为正确」的又一次复现。

### 审查之外，本轮还挖出两个真 bug

1. **`event-repo.js` 的 `mergePatch` 无条件 `delete merged.timeZone`。**
   与 `event.js:169` 注释「全天事件也保留 timeZone」直接冲突。
   后果：全天事件的 `timeZone` 永远被抹成 `null`，母体**第二次**单次移动必然抛
   `event.timeZone 必须是字符串`。
   修法：删掉那行 `delete`（只清 `start`/`end` 墙钟，时区不参与表达切换）。

2. **`TaskForm` 的 `dueAt` 完全无校验。**
   空串和任意文本直接落盘，随后提醒层对该任务报「算不出提醒时刻（数据有问题，不会响）」。
   修法：`parseDueAt` 本地拦截；空串表达为**省略字段**而非写 `''`。

## 三、验证证据

### 测试

```
cd workbench-core && node --test test/*.test.mjs
# tests 368
# pass  368
# fail  0
```

WP5 专项：

```
node --test workbench-core/test/workbench-ui-wp5.test.mjs
# pass 40
# fail 0
```

### 变异测试

```
node scripts/r3-mutate.mjs /tmp/mut-wp5-round28.log
CAUGHT: 102   VACUUM: 0    SKIP: 0
```

**102 个变异全部被捕获，0 真空、0 跳过。** 这是「保护点真的有测试约束」的硬证据，
不是测试数量本身。日志：`evidence/wp5/01-mutation.log`。

### 真空补测（第二轮审查之外的自我发现）

第一轮跑完变异后出现 **VACUUM: 3** —— 三个变异「改了代码、测试仍全绿」。
这不是测试数量问题，是保护点没被真正压住：

| 变异 | 真空原因 | 补测 |
| --- | --- | --- |
| W39 TaskForm 跳过 dueAt 校验 | 只测了 `parseDueAt` 纯函数，「函数正确」被当成「界面正确」；`submit` 里整段守卫删掉仍全绿 | 新测试压 `submit`：必须判 `!parsed.ok`、必须 `setFormError`、`return` 必须在 `onSave` 之前 |
| W47 `duplicate ?? c.skip` | 用 `duplicate: 0` 断言时，`0 ?? x` 不兜底（`??` 只吃 null/undefined）→ **等价变异**，行为不变 | 新断言用 **`duplicate` 字段缺失** 的输入，兜底实现会把 skip 顶成重复 |
| W48 `parseDueAt` 退回宽松 `Date.parse` | 三个坏值都被 `Date.parse` 判成 NaN，没覆盖「`Date.parse` 认为合法但无时区后缀」这一真风险 | 新断言 `'1'`/`'12'`/`'2026'`/`'2026/11/10'`/`'2026-11-10T09:00:00'` 等必须被拒 |

三条补测逐条做了「注入变异 → 确认红 → 还原」的闭环验证，
且 W39 由**正确的测试**（TaskForm 校验）捕获，不是被死键测试顺带抓到。

### 真机发现的真空（第三批，368 全绿时仍然全绿）

上一批补完、`368/368` 全绿、`98/98` 全捕获之后，**真机还是白屏了**。
根因不在业务逻辑，在「没有任何测试真的渲染组件」——`makeReact()` 的 `useState`
返回 no-op setter、`useEffect` 是空函数，组件树根本跑不起来。于是这类缺陷只能靠
**源码结构扫描**补：

| 真机缺陷 | 真空原因 | 新守卫 | 新变异 |
| --- | --- | --- | --- |
| 「待办」视图白屏，console `TypeError: t is not a function` | 行变量 `(t) =>` 遮蔽了本地化函数 `t`；没有渲染测试，`t('archive')` 调不动也无人发现 | 扫「`t` 被当回调形参」的回调区间，且区间内真的出现 `t('…')` 才判红 | **W53** 待办行 / **W54** 归档行 |
| 点「归档」报 `id 或 ids 必须提供` | 行变量改名 `row` 后残留 `setArchived(t.id, true)`、`...t`（`t.id` 恒 undefined），请求带着 undefined 打到 Host | 扫「行渲染区间内 `t.xxx` 属性访问 / `...t` 展开」 | **W55** 归档 id / **W56** 详情展开 |

两条守卫都做了「注入 → 确认红 → 还原」验证；W55 第一次注入时**没红**，
查明是我按行号改到了偏移后的错误行（真实位置 1998 而非常数的 1991），
按真实锚点重注入后**准确红在 `not ok 42`**。这条弯路本身也是证据：
按行号打补丁在长文件里必错，锚点必须每次现查。

### UI 契约脚本

```
node scripts/verify-wp5-ui.mjs /tmp/verify-wp5-data
结果：9 通过 / 0 失败
```

覆盖：排序落盘、归档≠软删、撤销可用、ICS 预览分类与冲突识别、计数来自服务端、
导入不得绕过审批、审批判据不得过宽、AI 面只有预览无 apply。

### 真机交互

详见 `evidence/wp5/04-real-interaction.md`。摘要（每条都以**磁盘字段**为准）：

| 操作 | 磁盘证据 |
| --- | --- |
| 键盘 ←/→ 改期 | `start` `2026-11-07T09:00:00` ⇄ `2026-11-08T09:00` |
| 撤销 / 重做 | `undo` 5→4→5，`redo` 0→1→0，`start` 同步回退/前进 |
| 归档 | `archived=true`，`deleted=undefined` |
| 恢复 | `archived=undefined`，`deleted=undefined` |
| 排序 | `order` 整组重排为 0/1/3/2，刷新后不变 |
| 到期时间坏值 | Host 里**没有**该任务；界面给出 ISO 提示，表单不提交 |

## 四、未验证项（如实记录，不用模拟结果冒充）

1. **真实 HTML5 拖拽手势未触发。** `browser_click` 产生不了 dragstart/dragover/drop
   序列，CDP 9222 已关闭。已用等价路径（↑/↓ 按钮）验证 `task.reorder` 落盘；
   拖拽源头的 `setDrag` 形状由单测 + 两个变异（B3）锁定。**手势本身未验证。**
2. **文件选择器未走通整条链路。** 原生文件对话框不可驱动。
   预览分类、审批拒绝、计数来源已独立验证；「点导入 → 选文件 → 出预览」未真机走通。
3. **真实 Cmd+Z / Cmd+Shift+Z 未触发。** `browser_press` 不支持 modifier 组合。
   已用「撤销/重做」按钮验证同一底层 `history.undo/redo` 路径。
4. **截图未落盘。** 浏览器工具只回图像内容，不返回文件路径。
   `evidence/wp5/screens/` 保持为空是如实结果，不用重绘图片冒充。
5. **明暗主题、窗口尺寸未截图验证。** 未找到可信的主题切换入口，宿主未提供改窗工具。
   组件全部使用 `--dsw-alias-*` 令牌、无硬编码颜色；代码有 `@media (max-width:800px)`
   断点。**均未实际观察。**
6. **`ctx.schedule` 提醒接线仍未完成**，`reminder.plan` 目前只走 `backend:'memory'`。
   WP3 遗留，不在 WP5 范围内。提醒条在真实页面已渲染并正确降级。
7. **全历史本机用户名 437 处**（本机用户目录前缀），改写需 force push，授权禁止，
   留待人工决定。`public-01-audit.sh` 为 PASS（退出 0，7 项检查）。
8. **`O(N²)` 的 reminder-reconcile** 已单独登记（`docs/wp3/01-on2-registry.md`），
   **未解决**，真实 Host 路径未测。不得在缺乏证据时宣称已解决。

## 五、关键教训

1. **字符串存在 ≠ 行为正确。** 构造器写成纯函数、测试断言它，看起来完美 ——
   但只要**生产路径不调用它**，它就是死代码，变异注回 bug 也全绿。
   B-1/B-2 就是这么被审查抓到的。修法是断言**调用点**，不是断言函数体。
2. **护栏只锁一个入口 = 真空变异。** 拖拽有两个源（MonthView、AgendaList），
   只锁一个，另一个被变异改坏也全绿。护栏必须覆盖所有源。
3. **断言只覆盖「第一次」就漏掉「第二次」。** `withDefaultZone` 与 `mergePatch`
   的 bug 都只在**第二次**操作时暴露。测试必须做连续两次。
4. **locale 键「存在」不等于「被使用」。** M-3 的死键就是这么来的：
   补了 7 个键，渲染路径却还写死中文。必须确认 `t()` 在渲染路径上被调用。
5. **同一条件抄多份、只测一份 = 假绿。** W4 变异把「已软删不进列表」删掉后全绿，
   因为该条件抄了 3 遍而测试只覆盖 1 处。修法是抽成唯一的 `isSoftDeleted` 并做行为断言。
6. **变异存活优先于测试数量。** 362 个测试全绿不等于保护有效；
   VACUUM 计数才是保护是否真被约束的证据。
7. **检查器不能与被检查对象共用硬编码事实。** 审计脚本一度自己写死本机用户名，
   导致「检查器自身成为污染源」；改为从路径推导。
