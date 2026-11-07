# WP5.1 交付说明：提醒投递与数据安全修复

## 0. 一句话

把「提醒」从**内存模拟**换成 **Host `ctx.schedule` 持久化投递**，把「重复导入」从**产生重复事件**修成**按 UID 幂等**，补齐**导出入口**与**窄屏/坏数据展示**。

---

## 1. 核实的真实接口（不是自造契约）

### 1.1 `ctx.schedule` 从哪来

| 事实 | 证据 |
|---|---|
| 包名 | `@deepseek-ai/dsh-schedule` v0.1.7-rc.2，描述原文 "Host-wide durable reminders" |
| 挂载点 | `dsh-web-app/cordis.patch.yml:125-126`，`id: schedule`，**`disabled: true`** |
| 服务名 | `lib/index.js:2612` `super(ctx, "schedule")` |
| 硬依赖 | `static inject = ["agents","sessions","tools","storageDomain","sessionController","sessionPersistence"]` |

**必须显式启用**：profile 的 overlay 行 `- id: schedule` / `disabled: false`。

### 1.2 实测到的坑：`ctx.get` 拿不到，必须 `ctx.inject`

隔离实例（`/tmp/dsh-iso-Jv2UeM`）实测，纯 `ctx.get` 版本：

```
[svc] schedule → undefined
[svc] sessions → undefined
[svc] storageDomain → undefined
[svc] agents → undefined
```

同一 profile 改成 `ctx.inject(['schedule'], cb)`：

```
[wait] schedule 服务就绪，keys: ctx,name,typertRemote,retention,ready,initialized,chain,runtime,stopping
[wait] create: function | catalog: function
[wait] sessions 就绪
```

原因在 `cordis/lib/index.js:762`：`get(name, strict=true)` 要求 `impl.fiber.state === 2`（active）；
`apply()` 同步阶段还没到那一步。`ctx.inject` 是 "Start a callback once the requested dependencies are available"（`:1600`）。

### 1.3 真实 CRUD 实测

```
create → {id:'schedule-cb3887c9-…', kind:'at', scheduledAt:'2026-11-07T04:51:25.526Z'}
catalog → [{id, kind, title, prompt, scheduledAt, sessionId, status:'active'}]
update → {id, updated:true, record:{…prompt 已改为「改期后的正文」}}
delete → {id, deleted:true} → catalog 归 0
history → {records:[], earlierRecordsUnavailable:false, retention:{days:30, records:200}}
```

**条目结构要点**：`ScheduleCatalogEntry = ScheduleRecord & {sessionId, status, lastDelivery?}`
（`types.d.ts:184`）——条目**本身就是 record**，没有嵌套 `record` 字段。
`update` 的 `expected` 要求纯 record，所以代码里用 `recordOf()` 剥掉投影字段。

### 1.4 持久化与重启

落盘 `<DSH_HOME>/storages/schedule.json`：

```json
{ "unit": {"name":"schedule","version":1}, "global": null,
  "tables": { "tasks": { "schedule-…": {
    "sessionId": "session-7f392c3b-…",
    "record": {"id":"schedule-…","kind":"at","title":"restart-persist-test",
               "prompt":"重启恢复验证正文","scheduledAt":"2026-11-07T06:50:10.277Z"},
    "status": "active",
    "deliveryHistory": {"records":[],"earlierRecordsUnavailable":false} } } } }
```

重启后 `catalog()` 仍读回同一条且 `status:'active'` —— 已实测。

### 1.5 投递语义（**必须说清楚**）

dsh-schedule 的投递是 **在原 Session 里发一条后续消息**
（`cordis.patch.yml` 原文：`delivers each due occurrence as a follow-up in its original Session`）。

**不是 macOS 系统通知。** 全仓库 `UNUserNotification` / `display notification` /
`osascript … notification` 调用数为 **0**，DSH 本身也不提供这个能力。

因此本包对外只说「提醒已注册为 Host 持久化任务」，**不宣称会弹系统通知**。

---

## 2. P0 提醒投递：实现与验证

### 2.1 结构

```
packages/workbench-ui/index.js
  ├─ ctx.inject(['schedule'], cb)      绑定服务（可选依赖，缺席则降级）
  ├─ REMINDER_AFFECTING_OPS           哪些写操作要重算提醒
  ├─ reconcileReminders(sessionId)    读 task.list + event.list → 调同步层
  ├─ op 'reminder.status'             只读诊断（服务是否接上 / 上次对账结果）
  └─ op 'reminder.reconcile'          手动触发一次对齐

workbench-core/src/reminder-sync.js   （新增，418 行）
  ├─ reminderForTask / reminderForEvent   数据 → 提醒描述（含非法值上报）
  ├─ diffReminders                        期望 vs 现状 → create/update/delete/unchanged
  └─ createReminderSync({schedule})       reconcile / ownHostRecords / deliveryStateOf
```

### 2.2 三个关键设计

**身份不用 `title + scheduledAt`**：那样改标题不改时间会漏掉旧记录 → 重复注册。
改用 `task:<id>` / `event-start:<id>`，时间变化只走 update，身份不变。

**身份编码进 prompt 末尾**：`待办「X」到期了。 [[wb:task:t1]]`。
不用标题反查（会被用户改、会截断、会重名）；没有标记的记录一律视为**非本插件**，
**绝不删** —— 宁可留孤儿，不误删用户自建的其他提醒。

**catalog 读不到就不写**：不知道现状就写 = 重复注册。
`catalogAvailable: false` 时整批放弃，并把原因放进 `failed`。

### 2.3 真机证据（隔离实例，真实 UI 操作）

**创建 → 自动注册**（UI 建日程「E2E提醒验证」，2026-12-01 09:00 本地）：

```json
"title": "E2E提醒验证",
"prompt": "日程「E2E提醒验证」开始了。 [[wb:event-start:a9764a17-4f26-4845-9923-2f3f9045c8a2]]",
"scheduledAt": "2026-12-01T01:00:00.000Z",
"status": "active"
```

本地 09:00 → UTC 01:00，时区换算正确。

**删除 → 自动取消**（UI 删掉该日程后）：

```
剩余提醒数: 1
   "WP51提醒验证" | status: active
```

**重启 → 保留**：

```
重启前提醒数: 1
重启后提醒数: 1
```

**重复注册防护**（新增一条日程后）：

```
提醒总数: 2
   "WP51提醒验证" × 1 ✅ 唯一
   "重复防护验证" × 1 ✅ 唯一
```

**幂等**（模块级，固定时间戳）：

```
R1 created: 2 updated: 0 unchanged: 0
R2 created: 0 updated: 0 unchanged: 2   ← 幂等
R3 created: 0 updated: 0 unchanged: 2   ← 幂等
R4 改期 updated: 1 unchanged: 1
R5 改标题 updated: 1 unchanged: 1
```

> 这一条是**修出来的**：初版 `sameText` 拿 `row.prompt` 去比 `want.prompt`，
> 而落盘的是 `encodePrompt(...)`（带标记），两者永不相等 → 每次 reconcile 都
> `updated:2`，幂等彻底失效。实测发现后才改对。

---

## 3. P1 ICS 幂等导入

### 3.1 缺陷

`event.import` 逐条无条件 `events.create`，完全不查 UID。实测同一份 ICS 导入两次：

```
第一次 imported=2  第二次 imported=2  最终事件数: 4
各条 uid: accept-ics-001, accept-ics-002, accept-ics-001, accept-ics-002
```

而 `event.previewIcs` **已经**正确标 `skip-duplicate-uid` —— 于是「预览说跳过、执行照样建」。

### 3.2 修法

让两边**共用同一个**判定函数 `uidOfEvent()` / `uidOfIncoming()`，并顺势把 preview 的
O(n·m) `existing.find(...)` 换成 `Set` 索引。

语义边界（与 preview 一致）：
- 只按 **UID** 判重（不同 UID 的同名事件是两条）；
- 已软删事件**不参与**判重（删掉后重新导入应当建回来）；
- 同一次导入内部的自重复也跳过；
- 跳过**如实上报**（`skipped` / `skippedEvents`）。

### 3.3 验证

```
第一次: imported=2 skipped=0
第二次: imported=0 skipped=2
第三次: imported=0 skipped=2
最终事件数: 2 | uids: accept-ics-001,accept-ics-002
预览 counts: {"create":0,"duplicate":2,"conflict":0,"degraded":0,"unsupported":0,"skip":2}
```

审批红线未动：无 token 仍 `confirmation-required`，`payload.confirmed` 仍不被采信。

---

## 4. P2 导出入口

### 4.1 缺陷

顶栏只有 `刷新 / 导入 / + 新建`，**LOCALE 里 export 相关 key 数为 0**。
服务端 `event.exportIcs` / `snapshot.export` 一直可用，但用户无法从界面导出。

### 4.2 实现

两个按钮 + 真实下载（Blob + `URL.createObjectURL` + `<a download>`），
文件名带日期，进行中禁用防连点。临时节点挂 `document.documentElement`
（项目规范禁止写 `document.body`）。

### 4.3 真机验证

ICS：
```
下载调用: [{"download":"workbench-2026-11-07.ics","href":"blob:http://127.0.0.1:63999/ae4a…"}]
Blob: [{"type":"text/calendar;charset=utf-8","len":428,"head":"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//"}]
提示: 已导出 workbench-2026-11-07.ics
```

JSON：
```
下载调用: [{"download":"workbench-2026-11-07.json","href":"blob:…"}]
Blob: [{"type":"application/json;charset=utf-8","len":2118}]
提示: 已导出 workbench-2026-11-07.json
```

---

## 5. P2 窄屏与坏数据

**窄屏**：原来只有一个 `max-width:800px` 断点，且只处理 `.wb-side` / `.wb-body`，
日历 7 列网格（`.wb-grid-7`）无窄屏处理。现补 `.wb-grid-7` / `.wb-day` /
`.wb-day-num` / `.wb-event-chip` / `.wb-toolbar` 的 800px 与 520px 两档。

**坏数据**：原来 `String(row.dueAt).slice(0, 10)` 把 `'排序验证'` 原样当日期显示。
现抽出纯函数 `dueDisplay(raw)` → `{kind:'none'|'date'|'broken'}`，
broken 走 `dueAtBroken` 文案（「时间格式异常（这条待办不会触发提醒）」）。

> 抽成纯函数不只是为了整洁：**写在 JSX 里的判断没法被单元测试覆盖**，
> 抽出来之后变异 Y12 才能被测试捕获。

---

## 6. 测试与验证

| 项 | 结果 |
|---|---|
| 核心域全量 | **407 / 407 pass**（WP5 收口时 371，新增 36） |
| 新增测试文件 | `reminder-sync-wp51.test.mjs`（24）、`import-idempotent-wp51.test.mjs`（10） |
| 追加测试 | `workbench-ui-wp5.test.mjs` 追加 2（dueDisplay / 口径一致） |
| 变异验证 | **119 / 119 CAUGHT，0 VACUUM，0 SKIP**（原 107 + 新增 12） |
| `verify-wp5-ui.mjs` | 9 通过 / 0 失败 |
| LOCALE | en/zh 各 **173** key，集合一致 |

### 变异项（新增 12 条，id 前缀 `Y`）

> 一开始用 `X1…X12`，与既有 `X1…X29` **撞号**，导致 `X11` 被静默覆盖成
> `reminder-recovery.js` 的变异，我的「导出防连点」根本没被执行。
> 变异 id 必须全局唯一 —— 撞号不会报错，只会静默少测。

Y1 导入不查 UID / Y2 不与既有比对 / Y3 预览导入规则漂移 / Y4 文件内自重复漏网 /
Y5 跳过不计数 / Y6 幂等比较用未编码 prompt / Y7 时间比较恒假 /
Y8 catalog 失败仍继续写 / Y9 非法 dueAt 静默丢弃 / Y10 已完成不撤销提醒 /
Y11 导出无防连点 / Y12 坏 dueAt 直接截断

其中 Y10 / Y11 / Y12 首轮是 **VACUUM**（测试没覆盖），补了测试才变 CAUGHT。
Y12 还经历过一次锚点漂移（我把渲染处重构成 `dueDisplay`，旧锚点消失）——
**重构会让锚点失效，改完必须重跑。**

---

## 7. 未验证 / 已知限制

1. **macOS 系统通知**：DSH 与 dsh-schedule 都不提供此能力。本包投递 = Session 后续消息。
   「系统通知横幅」**未实现，也未宣称实现**。
2. **真实到点投递**：提醒的**注册/持久化/重启恢复**已实测；但「到点后 Session 里真的收到
   一条消息」需要等真实时间到达（本轮用 2 小时后的提醒，未等待到点），
   这一条**未做端到端观察**。
3. **启动对账覆盖范围**：`sessionDirName` 是 sha256 前缀、不可逆，重启后磁盘上的老会话
   反推不出 sessionId。当前覆盖「本进程打开过的 session」+「首次写操作时对账」；
   **重启后从未被打开的老会话不会在启动时对账**。如实记录，不假装全量。
4. **休眠唤醒**：`reminder-recovery.js` 的 `recover({scenario:'suspend'})` 逻辑正确
   （restored 2 / missed 1 / 60s 边界包含，三场景一致），但**未被接入 UI 生命周期**，
   本轮也未接 —— 唤醒后的补投仍是未验证项。
5. **窄屏视觉**：CSS 已补，但本轮无 `setViewport` 能力，**未做真实窄窗口截图验证**。
6. **拖拽排序、文件选择器导入、VoiceOver**：沿用 WP5 的未验证状态。

---

## 8. 第三轮独立审查的处置（对抗性审查）

独立子代理（`33183bd7`）对本轮改动做了对抗性审查，提出 4 个 P0。**逐条用实证核验后确认全部成立**，已全部修复并补测试 + 补变异。

### P0-1 · 跨 session 误删 / 谎报成功 ✅ 已修

**问题**：`ownHostRecords()` 只按 `[[wb:…]]` 过滤，**不按 sessionId**。而真实
`dsh-schedule` 的 `catalog()` 返回**全表所有 session**（`lib/index.js`
`table("tasks").entries()` 无 session 过滤）。于是 session-A 会把 session-B 的
记录判成「不在期望集合」→ 调 delete → Host 守卫返回 `{deleted:false}` →
**代码不看返回值，照样 `report.deleted += 1`**。

**核验**：读源码确认 catalog 无 session 过滤；代码确认无返回值检查。

**修复**：
- `ownHostRecords(sessionId, scope)` 增加 sessionId 过滤；
- `delete`/`update` **检查返回值**，`deleted:false` / `updated:false` 计入 `failed`。

**验证**（真机脚本，双 session 共用 catalog）：
```
建后总数: 1
A 对账结果: deleted=0 failed=0
B 的提醒仍在: ✅ 是
```

### P0-2 · identity 被截断 → 无界重复注册 ✅ 已修

**问题**：`encodePrompt` 超长时**从头截断**，而身份标记在末尾 → 标记必然被切掉 →
`identityOfHostRecord` 返回 null → 该记录永远认不出、永远删不掉，每轮还新建一条。

**核验**：
```
identity 长 2200：prompt 长度 2000、能识别身份 null、结尾是 "xxx…" 而不是 "]]"
```

**修复**：先给标记留预算，只截正文；标记自身超预算时优先保标记。

### P0-3 · 身份可被用户伪造 ✅ 已缓解

**问题**：只看 prompt 末尾的 `[[wb:…]]`，用户手写同样字样即被认领 → 可能被误删。

**修复**：标记加**不可见前缀**（U+200B + U+2060），自然打字不可能产生。
真正的隔离仍靠 sessionId 过滤（P0-1）。

**验证**：
```
纯文本伪造 → null      （不认领）
本插件标记 → task:_:t1 （正常识别）
```
> 诚实说明：这**不能杜绝**刻意复制粘贴的伪造，只是把风险从「随口一写就中」
> 降到「刻意构造才行」。要彻底解决需要 Host 提供结构化 metadata，当前不可用。

### P0-4 · scope 未进 identity → 不同 scope 互相覆盖 ✅ 已修

**问题**：`reminderIdentity(kind, entityId)` 不含 scope，而业务数据是**按 scope
分目录隔离**的。两个 scope 下同 id 实体算出同一 identity → 后一轮 update 掉前一轮。

**修复**：
- identity 改为三段 `kind:scope:entityId`（空 scope 用 `_` 占位避免歧义）；
- `reconcile`/`desiredFrom`/`reminderForTask`/`reminderForEvent` 全链路透传 scope；
- `ownHostRecords` 再按 scope 过滤（否则 A scope 会删 B scope 的记录）；
- `decodeIdentity` 兼容旧两段格式。

**验证**：两个 scope 各建 1 条 → `rows.size === 2`，再各跑一次 → 均 `unchanged:1`。

### P1-5 · UI 不显示导入跳过数 ✅ 已修

`event.import` 新增 `skipped`，UI 原来只说「导入完成」。现在：
有跳过 → 「已导入 {n} 条，跳过重复 {s} 条」；无跳过 → 「已导入 {n} 条」。

### P2-9 · `fakeSchedule` 太宽松 ✅ 已修

`fake` 原来不校验 sessionId、不校验 `expected`，**这是上述 P0-1 漏网的结构性原因**
（假宿主比真宿主宽容，测试就永远绿）。现在 fake 对齐真实守卫：
- `sessionId !== req.sessionId` → `{deleted:false, code:'schedule_not_found'}`；
- `expected.id !== row.id` → `{updated:false, code:'schedule_conflict'}`。

> 这个教训值得记住：**测试替身比真实系统宽松，是「测了但没测到」的根因**。

### 未采纳 / 记录在案

- **P2-7** `openedSessions()` 用 `lastIndexOf('::')` 解析复合 key，scope 含 `::` 时
  解析错。当前 scope 是内部生成值，不会含 `::`；若将来放开需改嵌套 Map。**记录，本轮不改**。
- **P2-10** 变异覆盖的仍是「已想到的点」。这轮把审查提出的 4 个 P0 都补了变异
  （Y15–Y20），但**不能由此宣称「没有想不到的点」**。

---

## 9. 基线已有问题（非本轮引入，如实记录）

`workbench-core/test/host-approval-real.test.mjs` 的
`WP3：真 ApprovalService 端到端` 在本轮**之前就已失败**：

- **HEAD `e43de69` 实测：`pass 370 / fail 1`**（同一测试）
- 报错 `Cannot read properties of undefined (reading 'stateOf')`
- 根因：`ApprovalService.init()` 里 `this.approvalProjectionHandle =
  await this.ctx.sessionProjections.register(...)`，而测试桩**没有提供
  `sessionProjections` 服务** → 句柄为 undefined
- 这是**测试环境缺口**，不是产品缺陷；本轮未修（超出 WP5.1 授权范围）

因此「全量全绿」的准确表述是：**419 个测试，418 通过，1 个是基线既有失败**。
