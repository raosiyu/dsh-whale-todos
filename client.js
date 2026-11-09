/**
 * WP4 Client half — `main` keyed slot + `sidebar.panellist`.
 *
 * 真契约：
 *  - `window.__ModuleLoader__.load({ id, factory(require) {...} })`（模板 client.js）
 *  - React 从 `require('react')`（浏览器模块表），不装第二份、不用 CDN
 *  - `ctx.slots.inject(ownerKey, () => ctx.slots.register({...}, Component))`
 *    （`dsh-client-ui-schedule/lib/client.js:7473-7490`）
 *  - `main` 是 keyed slot（`dsh-client-ui-layout:119` 用 entryKey 渲染），
 *    我们的 key 与 `conversation` 并存，**不覆盖现有 Conversation 页**
 *  - 数据：`ctx.remote.commands.execute(sessionId, '/workbench <json>', [])`
 *    → Host `ctx.workbench.invoke(...)`（唯一数据源，无假数据）
 *  - 只用 `--dsw-alias-*` Theme Tokens（浅/深色由宿主切换）
 *  - 所有资源在 `apply` 内注册，factory 无副作用
 *
 * 不用 iframe、不 require Client primitives、不写 document.body。
 */

window.__ModuleLoader__.load({
  id: 'dsh-whale-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const PANEL_ID = 'workbench'
    const NS = '@local/dsh-workbench-ui'

    /**
     * **默认文案函数**（factory 作用域）。
     *
     * 第三轮 Review 的 BLOCKER-1：`t` 曾只定义在 WorkbenchPage **内部**，
     * 而 EventForm / TaskForm / ConfirmDelete 是工厂作用域的**兄弟函数**，
     * 取不到它 → 渲染即 ReferenceError → React 卸载整棵子树 → 整页白屏。
     * 现在 t 在 factory 层，组件可从 props 取，也可直接用默认实现。
     */
    const defaultT = (key) => LOCALE.en[key] ?? key

    // UI 文案走真 Client locale 服务（ctx.locale.register/bind）。
    // 真契约：dsh-client-ui-approval/lib/client.js:316 `ctx.locale.register(NS, { zh, en })`，
    // 取值 `ctx.locale.bind(NS)`('key')。
    const LOCALE = {
      en: {
      "meta": {
            "title": "Whale Todos",
            "description": "A calendar and todo workbench backed by the Host Service."
      },
      "panel": "Whale Todos",
      "calendar": "Calendar",
      "todos": "Todos",
      "month": "Month",
      "week": "Week",
      "day": "Day",
      "agenda": "Agenda",
      "today": "Today",
      "planned": "Planned",
      "inProgress": "In progress",
      "done": "Done",
      "new": "New",
      "save": "Save",
      "cancel": "Cancel",
      "delete": "Delete",
      "refresh": "Refresh",
      "search": "Search",
      "retry": "Retry",
      "loading": "Loading…",
      "ready": "Ready",
      "error": "Error",
      "import": "Import",
      "export": "Export ICS",
      "exportJsonShort": "Export JSON",
      "exportIcs": "Export as ICS calendar",
      "exportJson": "Export as JSON snapshot",
      "exportIcsHint": "Download all active events as an .ics calendar file",
      "exportJsonHint": "Download a full JSON snapshot (events and todos)",
      "exporting": "Exporting…",
      "exportDone": "Exported {file}",
      "exportEmpty": "Nothing to export (the Host returned an empty document)",
      "dueAtBroken": "Invalid time format (this todo will not trigger a reminder)",
      "undo": "Undo",
      "redo": "Redo",
      "archive": "Archive",
      "restore": "Restore",
      "archivedSection": "Archived",
      "reminder": "Reminder",
      "moveScope": "Choose move scope",
      "view": "View",
      "openLabel": "Open {title}",
      "importSummary": "Import {kind} data",
      "untitled": "(untitled)",
      "kindTask": "Task",
      "kindEvent": "Event",
      "fieldDue": "Due",
      "fieldStart": "Start",
      "fieldDescription": "Description",
      "fieldRepeats": "Repeats",
      "fieldCustom": "custom",
      "occurrencesNext7": "{n} occurrence(s) in next 7 days",
      "fieldConflict": "Conflict",
      "conflictOverlap": "Overlaps another event",
      "fieldSubtasks": "Subtasks",
      "openDetails": "Details of {title}",
      "complete": "Complete",
      "reopen": "Reopen",
      "noActiveSession": "No active session; open the workbench from a conversation",
      "missingSourceDate": "Missing source date for this occurrence; reload and retry",
      "allDay": "All day",
      "time": "Time",
      "date": "Date",
      "repeat": "Repeat",
      "priority": "Priority",
      "priorityLow": "Low",
      "priorityNormal": "Normal",
      "priorityHigh": "High",
      "confirmDelete": "Confirm delete",
      "approvalNotGranted": "Host approval was not granted",
      "taskReopened": "Task reopened",
      "taskCompleted": "Task completed",
      "deletedAfterApproval": "Deleted after Host approval",
      "edit": "Edit",
      "deleteAction": "Delete…",
      "close": "Close",
      "deleteSummary": "Delete {kind}",
      "confirmDeleteHint": "This requires Host approval before deleting “{label}”.",
      "requestingApproval": "Requesting approval…",
      "requestApprovalDelete": "Request approval & delete",
      "fieldTitle": "Title",
      "collabTitle": "Agent collaboration",
      "collabStatusIdle": "Not started",
      "collabStatusExecuting": "In progress",
      "collabStatusAwaiting": "Awaiting your acceptance",
      "collabStatusAccepted": "Accepted",
      "collabStatusRejected": "Rejected",
      "backupPanel": "Backups",
      "backupPanelHint": "Restoring replaces current data with that snapshot. It requires approval.",
      "backupCreate": "Back up now",
      "backupCreated": "Backup created",
      "backupCreateFailed": "Backup failed",
      "backupLoadFailed": "Could not list backups",
      "backupEmpty": "No backups yet",
      "backupRolledBack": "Restored from backup",
      "backupRollbackFailed": "Restore failed",
      "collabOpenSession": "Open",
      "collabOpened": "Switched to that session",
      "collabOpenFailed": "Could not open session",
      "collabOpenUnavailable": "This window does not expose the session switcher",
      "collabSessionGone": "This session is no longer available in this window",
      "collabCopySession": "Copy",
      "collabCopying": "Copying…",
      "collabCopied": "Session id copied",
      "collabCopyFailed": "Copy failed",
      "collabCopyUnavailable": "Clipboard is not available — select the session id and copy it manually",
      "collabErrSessionMissing": "This task is assigned to an Agent, but no session id was recorded — progress cannot be traced back to a conversation.",
      "collabErrLogCorrupt": "Execution log is malformed (not a list); only the latest progress is shown.",
      "collabErrProgressBroken": "Progress value is invalid; showing 0% instead of a wrong number.",
      "dueDateLabel": "Due date",
      "dueTimeLabel": "Due time",
      "noDueLabel": "No due date",
      "nothingToUndo": "Nothing to undo",
      "nothingToRedo": "Nothing to redo",
      "archiveHint": "Archive this task",
      "new": "New",
      "fieldId": "ID",
      "untitledEvent": "untitled event",
      "selectToSeeDetails": "Select an event or task to see details",
      "dateLocale": "en",
      "weekdayMon": "Mon",
      "weekdayTue": "Tue",
      "weekdayWed": "Wed",
      "weekdayThu": "Thu",
      "weekdayFri": "Fri",
      "weekdaySat": "Sat",
      "weekdaySun": "Sun",
      "moveScopeTitle": "Move a recurring event",
      "moveScopeBody": "\"{title}\" repeats. Move it to {date}:",
      "untitled": "(untitled)",
      "dragMoving": "Moving",
      "dragWillDrop": "will land on",
      "unsupportedTitle": "Unsupported items",
      "unsupportedFallback": "unsupported",
      "warningsTitle": "Warnings",
      "importNote": "Confirming an import goes through host approval and takes a backup first.",
      "importPreviewTitle": "Import preview",
      "previewColKind": "Kind",
      "previewColCount": "Count",
      "previewColHint": "What happens",
      "previewDegraded": "Degraded",
      "previewDegradedHint": "Imported, but missing timezone details",
      "previewSkip": "Skipped",
      "previewSkipHint": "Not imported for other reasons",
      "saving": "Saving…",
      "noUpcoming": "No reminders due in the next 7 days",
      "reminderSkipped": "reminders cannot be scheduled (bad data, will not fire)",
      "cancel": "Cancel",
      "moveSingle": "Only this occurrence",
      "moveSeries": "Entire series",
      "confirmImport": "Confirm import",
      "importing": "Importing…",
      "previewCreate": "New",
      "previewDuplicate": "Duplicate",
      "previewConflict": "Conflict",
      "previewUnsupported": "Unsupported",
      "previewRemoved": "Will be removed",
      "moved": "Moved to",
      "onlyThisOne": "(this one only)",
      "eventCreated": "Event created in Host",
      "eventUpdated": "Event updated in Host",
      "taskSaved": "Task saved in Host",
      "loadedFromHost": "Loaded from Host Service",
      "eventGone": "That event no longer exists; please refresh",
      "nEvents": "events",
      "dragToReschedule": "drag to reschedule",
      "event": "Event",
      "openDetailsHint": "click for details; use ←/→ or drag to reschedule",
      "dragToMonthGrid": "Drag onto a day cell to reschedule",
      "draggableHint": "drag to reschedule",
      "conflictCheck": "Conflict check",
      "expandCheck": "Recurrence expand",
      "unavailable": "unavailable",
      "importData": "Import data",
      "importHint": "Import a JSON snapshot or an ICS calendar; preview first",
      "undoableSteps": "undoable steps:",
      "ungrouped": "Ungrouped",
      "items": "items",
      "dragToReorder": "drag to reorder",
      "reorderHint": "Drag to reorder; keyboard users use the up/down buttons",
      "moveUp": "Move up",
      "moveDown": "Move down",
      "noEvents7d": "No events in the next 7 days",
      "noEventsRange": "No events in this range",
      "nothingScheduled": "Nothing scheduled",
      "next7days": "next 7 days",
      "previous": "Previous",
      "next": "Next",
      "orderSaved": "Order saved",
      "undoDone": "Undid last step",
      "redoDone": "Redone",
      "importDone": "Imported {n} item(s)",
      "importDoneSkipped": "Imported {n} item(s), skipped {s} duplicate(s)",
      "archived": "Archived",
      "restored": "Restored",
      "loadFailed": "Load failed",
      "noTasks": "No tasks in this view",
      "moveSingleHint": "Only this occurrence",
      "moveSeriesHint": "Shift the whole series",
      "previewCreateHint": "Will be written to the store",
      "previewDuplicateHint": "Same id/uid already exists; will skip",
      "previewConflictHint": "Overlaps an existing event",
      "previewUnsupportedHint": "Cannot be imported; see reasons below",
      "previewRemovedHint": "A replace-style import deletes these existing rows",
      "dueAtInvalid": "Due must be a valid ISO instant (for example 2026-11-10T09:00:00Z), or left empty.",
      // WP6：AI 智能规划与会话协作
      "aiPlan": "AI 规划",
      "aiPlanTitle": "智能规划与任务拆解",
      "aiPlanHint": "输入目标，AI 基于真实待办与日历空闲时段生成提案；确认前不会写入任何数据",
      "goalLabel": "目标 / 会议纪要",
      "windowToday": "今日",
      "windowWeek": "本周",
      "generatePlan": "生成建议",
      "generating": "生成中…",
      "planItems": "建议条目",
      "planConflicts": "检测到的冲突",
      "planReason": "安排理由",
      "planOverloaded": "安排过满：需要 {used} 分钟，超出每日容量 {capacity} 分钟",
      "planStats": "拆解 {decomposed} 条 · 排期 {scheduled} 条 · 已用 {used}/{capacity} 分钟",
      "planEmpty": "暂无建议，换个目标或时间窗再试",
      "confirmPlan": "确认并写入",
      "rejectPlan": "拒绝",
      "modifyPlan": "修改目标",
      "planApproving": "提交中…",
      "planApplied": "已写入 {n} 条，可一次撤销",
      "planRejected": "已拒绝，未修改任何数据",
      "planBack": "返回",
      "estimateLabel": "预计耗时（分钟）",
      "aiSessionLinks": "关联 Agent 会话",
      "aiProgress": "进度",
      "aiExecutionLog": "执行记录",
      "aiAcceptance": "完成验收",
      "acceptCompletion": "通过验收",
      "rejectCompletion": "驳回",
      "completionFeedback": "驳回原因",
      "noSessions": "暂无关联会话",
      "pendingAcceptance": "待用户验收（任务尚未完成）",
      "acceptedLabel": "已验收通过",
      "rejectedLabel": "已驳回：{feedback}",
      },
      zh: {
      "meta": {
            "title": "鲸鱼待办",
            "description": "由 Host Service 提供数据的日历与待办面板。"
      },
      "panel": "鲸鱼待办",
      "calendar": "日历",
      "todos": "待办",
      "month": "月",
      "week": "周",
      "day": "日",
      "agenda": "议程",
      "today": "今日",
      "planned": "计划中",
      "inProgress": "进行中",
      "done": "已完成",
      "new": "新建",
      "save": "保存",
      "cancel": "取消",
      "delete": "删除",
      "refresh": "刷新",
      "search": "搜索",
      "retry": "重试",
      "loading": "加载中…",
      "ready": "就绪",
      "error": "错误",
      "import": "导入",
      "export": "导出 ICS",
      "exportJsonShort": "导出 JSON",
      "exportIcs": "导出为 ICS 日历",
      "exportJson": "导出为 JSON 快照",
      "exportIcsHint": "把所有有效日程下载为 .ics 日历文件",
      "exportJsonHint": "下载完整 JSON 快照（含日程与待办）",
      "exporting": "导出中…",
      "exportDone": "已导出 {file}",
      "exportEmpty": "没有可导出的内容（宿主返回了空文档）",
      "dueAtBroken": "时间格式异常（这条待办不会触发提醒）",
      "undo": "撤销",
      "redo": "重做",
      "archive": "归档",
      "restore": "恢复",
      "archivedSection": "已归档",
      "reminder": "提醒",
      "moveScope": "选择移动范围",
      "view": "视图",
      "openLabel": "打开 {title}",
      "importSummary": "导入 {kind} 数据",
      "untitled": "（未命名）",
      "kindTask": "待办",
      "kindEvent": "日程",
      "fieldDue": "截止",
      "fieldStart": "开始",
      "fieldDescription": "描述",
      "fieldRepeats": "重复",
      "fieldCustom": "自定义",
      "occurrencesNext7": "未来 7 天共 {n} 次",
      "fieldConflict": "冲突",
      "conflictOverlap": "与另一日程时间重叠",
      "fieldSubtasks": "子任务",
      "openDetails": "查看 {title} 详情",
      "complete": "完成",
      "reopen": "重新打开",
      "noActiveSession": "没有活动会话，请从对话中打开鲸鱼待办",
      "missingSourceDate": "这个实例缺少源日，请刷新后重试",
      "allDay": "全天",
      "time": "时间",
      "date": "日期",
      "repeat": "重复",
      "priority": "优先级",
      "priorityLow": "低",
      "priorityNormal": "普通",
      "priorityHigh": "高",
      "confirmDelete": "确认删除",
      "approvalNotGranted": "宿主审批未通过",
      "taskReopened": "待办已重新打开",
      "taskCompleted": "待办已完成",
      "deletedAfterApproval": "已通过宿主审批删除",
      "edit": "编辑",
      "deleteAction": "删除…",
      "close": "关闭",
      "deleteSummary": "删除{kind}",
      "confirmDeleteHint": "删除“{label}”需要宿主审批。",
      "requestingApproval": "正在申请审批…",
      "requestApprovalDelete": "申请审批并删除",
      "fieldTitle": "标题",
      "collabTitle": "Agent 协作",
      "collabStatusIdle": "未开始",
      "collabStatusExecuting": "执行中",
      "collabStatusAwaiting": "等待你验收",
      "collabStatusAccepted": "已验收",
      "collabStatusRejected": "已驳回",
      "backupPanel": "备份",
      "backupPanelHint": "恢复会用该快照替换当前数据，需要审批。",
      "backupCreate": "立即备份",
      "backupCreated": "已创建备份",
      "backupCreateFailed": "备份失败",
      "backupLoadFailed": "无法读取备份列表",
      "backupEmpty": "还没有备份",
      "backupRolledBack": "已从备份恢复",
      "backupRollbackFailed": "恢复失败",
      "collabOpenSession": "打开",
      "collabOpened": "已切换到该会话",
      "collabOpenFailed": "打开会话失败",
      "collabOpenUnavailable": "当前窗口没有暴露会话切换能力",
      "collabSessionGone": "该会话已不在当前窗口，无法跳转",
      "collabCopySession": "复制",
      "collabCopying": "复制中…",
      "collabCopied": "会话标识已复制",
      "collabCopyFailed": "复制失败",
      "collabCopyUnavailable": "剪贴板不可用，请手动选中会话标识复制",
      "collabErrSessionMissing": "这个任务已分配给 Agent，但没有记录会话标识 —— 进度无法追溯到具体会话。",
      "collabErrLogCorrupt": "执行日志格式异常（不是列表），只显示最近一次进度。",
      "collabErrProgressBroken": "进度值不合法，已显示 0% 而不是错误的数字。",
      "dueDateLabel": "到期日期",
      "dueTimeLabel": "到期时刻",
      "noDueLabel": "无截止日期",
      "nothingToUndo": "没有可撤销的操作",
      "nothingToRedo": "没有可重做的操作",
      "archiveHint": "归档这个待办",
      "new": "新建",
      "fieldId": "ID",
      "untitledEvent": "未命名日程",
      "selectToSeeDetails": "选中一个日程或待办查看详情",
      "dateLocale": "zh",
      "weekdayMon": "周一",
      "weekdayTue": "周二",
      "weekdayWed": "周三",
      "weekdayThu": "周四",
      "weekdayFri": "周五",
      "weekdaySat": "周六",
      "weekdaySun": "周日",
      "moveScopeTitle": "移动重复事件",
      "moveScopeBody": "「{title}」是重复事件。移到 {date}：",
      "untitled": "（无标题）",
      "dragMoving": "移动",
      "dragWillDrop": "将落到",
      "unsupportedTitle": "不支持的条目",
      "unsupportedFallback": "不支持",
      "warningsTitle": "警告",
      "importNote": "确认导入会走宿主审批，并自动先做一次备份。",
      "importPreviewTitle": "导入预览",
      "previewColKind": "类别",
      "previewColCount": "数量",
      "previewColHint": "说明",
      "previewDegraded": "降级",
      "previewDegradedHint": "能导进来，但时区信息不全",
      "previewSkip": "跳过",
      "previewSkipHint": "因其它原因未导入",
      "saving": "保存中…",
      "noUpcoming": "接下来 7 天没有到点的提醒",
      "reminderSkipped": "条算不出提醒时刻（数据有问题，不会响）",
      "cancel": "取消",
      "moveSingle": "只改这一次",
      "moveSeries": "改整个系列",
      "confirmImport": "确认导入",
      "importing": "导入中…",
      "previewCreate": "新增",
      "previewDuplicate": "重复",
      "previewConflict": "冲突",
      "previewUnsupported": "不支持",
      "previewRemoved": "会被移除",
      "moved": "已移动到",
      "onlyThisOne": "（仅这一次）",
      "eventCreated": "日程已写入 Host",
      "eventUpdated": "日程已更新到 Host",
      "taskSaved": "待办已保存到 Host",
      "loadedFromHost": "已从 Host Service 加载",
      "eventGone": "事件已不存在，请刷新",
      "nEvents": "个事件",
      "dragToReschedule": "拖放可改期",
      "event": "事件",
      "openDetailsHint": "可打开详情；改期请用 ←/→ 键或拖动",
      "dragToMonthGrid": "拖动到月视图的日期格可改期",
      "draggableHint": "拖动可改期",
      "conflictCheck": "冲突检测",
      "expandCheck": "重复展开",
      "unavailable": "不可用",
      "importData": "导入数据",
      "importHint": "导入 JSON 快照或 ICS 日历；先预览再确认",
      "undoableSteps": "可撤销步数：",
      "ungrouped": "未分组",
      "items": "项",
      "dragToReorder": "拖动调整顺序：",
      "reorderHint": "拖动调整顺序；键盘用户请用上移/下移按钮",
      "moveUp": "上移",
      "moveDown": "下移",
      "noEvents7d": "接下来 7 天没有日程",
      "noEventsRange": "这段时间没有日程",
      "nothingScheduled": "没有安排",
      "next7days": "接下来 7 天",
      "previous": "上一页",
      "next": "下一页",
      "orderSaved": "顺序已保存",
      "undoDone": "已撤销上一步",
      "redoDone": "已重做",
      "importDone": "已导入 {n} 条",
      "importDoneSkipped": "已导入 {n} 条，跳过重复 {s} 条",
      "archived": "已归档",
      "restored": "已恢复",
      "loadFailed": "加载失败",
      "noTasks": "当前视图没有待办",
      "moveSingleHint": "其余实例不动",
      "moveSeriesHint": "所有实例一起平移",
      "previewCreateHint": "会写进库里的条目",
      "previewDuplicateHint": "库里已有同 id/同 uid，将跳过",
      "previewConflictHint": "与既有事件时间重叠",
      "previewUnsupportedHint": "导不进来，原因见下",
      "previewRemovedHint": "覆盖式导入会删掉这些既有条目",
      "dueAtInvalid": "到期时间必须是合法的 ISO 时刻（例如 2026-11-10T09:00:00Z），或者留空。",
      // WP6：AI 智能规划与会话协作
      "aiPlan": "AI 规划",
      "aiPlanTitle": "智能规划与任务拆解",
      "aiPlanHint": "输入目标，AI 基于真实待办与日历空闲时段生成提案；确认前不会写入任何数据",
      "goalLabel": "目标 / 会议纪要",
      "windowToday": "今日",
      "windowWeek": "本周",
      "generatePlan": "生成建议",
      "generating": "生成中…",
      "planItems": "建议条目",
      "planConflicts": "检测到的冲突",
      "planReason": "安排理由",
      "planOverloaded": "安排过满：需要 {used} 分钟，超出每日容量 {capacity} 分钟",
      "planStats": "拆解 {decomposed} 条 · 排期 {scheduled} 条 · 已用 {used}/{capacity} 分钟",
      "planEmpty": "暂无建议，换个目标或时间窗再试",
      "confirmPlan": "确认并写入",
      "rejectPlan": "拒绝",
      "modifyPlan": "修改目标",
      "planApproving": "提交中…",
      "planApplied": "已写入 {n} 条，可一次撤销",
      "planRejected": "已拒绝，未修改任何数据",
      "planBack": "返回",
      "estimateLabel": "预计耗时（分钟）",
      "aiSessionLinks": "关联 Agent 会话",
      "aiProgress": "进度",
      "aiExecutionLog": "执行记录",
      "aiAcceptance": "完成验收",
      "acceptCompletion": "通过验收",
      "rejectCompletion": "驳回",
      "completionFeedback": "驳回原因",
      "noSessions": "暂无关联会话",
      "pendingAcceptance": "待用户验收（任务尚未完成）",
      "acceptedLabel": "已验收通过",
      "rejectedLabel": "已驳回：{feedback}",
      },
    }

    // --------------------------------------------------------------- 样式
    // 只引用真实存在的 --dsw-alias-* 令牌（见 docs/wp4/00-contract.md）。
    // 间距 4/8 倍数；正文 16px；标题 20–28px；点击区 >= 44px。
    const CSS = `
.wb-root{display:flex;flex-direction:column;height:100%;min-height:0;
  color:var(--dsw-alias-label-primary);font-size:16px;line-height:1.5;
  font-family:inherit;background:transparent;box-sizing:border-box}
.wb-root *{box-sizing:border-box}
.wb-top{display:flex;align-items:center;gap:8px;padding:16px;
  border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;flex-wrap:wrap}
.wb-title{font-size:24px;font-weight:600;margin:0;line-height:1.25}
.wb-spacer{flex:1 1 auto;min-width:8px}
.wb-tabs{display:flex;gap:4px;flex-wrap:wrap}
.wb-btn{min-height:44px;min-width:44px;padding:8px 16px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:16px;cursor:pointer;display:inline-flex;align-items:center;
  justify-content:center;gap:8px}
.wb-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wb-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.wb-btn[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover);font-weight:600}
.wb-btn[disabled]{opacity:.5;cursor:not-allowed}
.wb-btn-primary{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);
  border-color:transparent}
.wb-btn-danger{color:var(--dsw-alias-state-warn-label)}
.wb-body{display:flex;flex:1 1 auto;min-height:0;overflow:hidden}
.wb-main{flex:1 1 auto;min-width:0;overflow:auto;padding:16px}
.wb-side{width:320px;max-width:40vw;flex:0 0 auto;overflow:auto;
  border-left:1px solid var(--dsw-alias-border-l1);padding:16px}
.wb-section{margin:0 0 16px 0}
.wb-section h2{font-size:20px;font-weight:600;margin:0 0 8px 0}
.wb-section h3{font-size:16px;font-weight:600;margin:0 0 8px 0;
  color:var(--dsw-alias-label-secondary)}
.wb-muted{color:var(--dsw-alias-label-secondary)}
.wb-tertiary{color:var(--dsw-alias-label-tertiary)}
.wb-grid{display:grid;gap:8px}
.wb-grid-7{grid-template-columns:repeat(7,minmax(0,1fr))}
.wb-cell{min-height:44px;padding:8px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;background:transparent;text-align:left;font:inherit;font-size:16px;
  color:var(--dsw-alias-label-primary);cursor:pointer;overflow:hidden}
.wb-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wb-cell:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.wb-cell-today{border-color:var(--dsw-alias-state-business-primary)}
.wb-row{display:flex;align-items:center;gap:8px;min-height:44px;padding:8px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.wb-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wb-row-main{flex:1 1 auto;min-width:0;text-align:left;background:transparent;border:0;
  font:inherit;font-size:16px;color:var(--dsw-alias-label-primary);cursor:pointer;
  min-height:44px;display:flex;align-items:center;gap:8px}
.wb-row-main:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.wb-badge{font-size:12px;padding:4px 8px;border-radius:4px;
  background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);
  white-space:nowrap}
.wb-badge-ok{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.wb-input{min-height:44px;width:100%;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:16px}
.wb-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.wb-search{min-width:200px;flex:0 1 320px}
.wb-scroll::-webkit-scrollbar{width:8px;height:8px}
.wb-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}
.wb-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2)}
.wb-status{min-height:44px;padding:8px 16px;display:flex;align-items:center;gap:8px;
  border-bottom:1px solid var(--dsw-alias-border-l1);font-size:16px}
.wb-status-error{color:var(--dsw-alias-state-warn-label)}
/* 提醒条：提示性质，视觉上比状态栏更轻，不与「错误」抢注意力 */
.wb-reminders{flex-wrap:wrap;background:var(--dsw-alias-interactive-bg-hover)}
.wb-reminder-label{color:var(--dsw-alias-label-secondary);flex:none}
.wb-reminder-chip{padding:4px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}
.wb-reminder-more{color:var(--dsw-alias-label-tertiary);flex:none}
.wb-reminder-warn{color:var(--dsw-alias-state-warn-label);flex:none}
.wb-empty{padding:32px 16px;text-align:center;color:var(--dsw-alias-label-secondary)}
/* V1.2 · 议程里的日期分组 */
.wb-backup-panel{margin:8px 0 0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.wb-backup-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wb-backup-head strong{flex:1 1 auto;font-size:13px}
.wb-backup-list{margin:0;padding-left:16px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.wb-backup-list li{display:flex;align-items:center;gap:8px;min-height:44px}
.wb-daygroup{margin-bottom:8px}
.wb-daygroup-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);
  padding:8px 0 4px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:4px}
/* V1.1 §2 · Agent 协作面板
   颜色一律走 --dsw-alias-* 令牌（WP4 硬约束）：硬编码色值在深色主题下
   会变成不可读的脏色块，而且主题切换时不会跟着变。 */
.wb-collab{margin-top:16px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.wb-collab-title{margin:0 0 8px;font-size:14px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary)}
.wb-collab-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.wb-collab-progress{font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-label-primary)}
.wb-collab-status{padding:4px 8px;border-radius:10px;font-size:12px;border:1px solid var(--dsw-alias-border-l2)}
.wb-collab-status.wb-collab-idle{color:var(--dsw-alias-label-tertiary)}
.wb-collab-status.wb-collab-executing{color:var(--dsw-alias-state-business-primary)}
.wb-collab-status.wb-collab-awaiting{color:var(--dsw-alias-state-warn-label)}
.wb-collab-status.wb-collab-accepted{color:var(--dsw-alias-state-business-primary)}
.wb-collab-status.wb-collab-rejected{color:var(--dsw-alias-state-warn-label)}
.wb-collab-bar{height:8px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;margin-bottom:8px}
.wb-collab-bar-fill{height:100%;background:var(--dsw-alias-state-business-primary);transition:width .3s ease}
.wb-collab-section{margin-top:16px}
.wb-collab-links,.wb-collab-log,.wb-collab-anomalies{margin:4px 0 0;padding-left:16px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.wb-collab-anomalies{color:var(--dsw-alias-state-warn-label)}
.wb-collab-role{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.wb-collab-pending{padding:8px;border-radius:6px;border:1px solid var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-primary)}
.wb-collab-pending p{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.wb-collab-accepted,.wb-collab-rejected{padding:8px;border-radius:6px;font-size:12px;border:1px solid var(--dsw-alias-border-l1)}
.wb-collab-accepted{color:var(--dsw-alias-state-business-primary)}
.wb-collab-rejected{color:var(--dsw-alias-state-warn-label)}
.wb-collab-actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
/* >=44px 点击区是 WP4 硬约束，小按钮靠 padding 撑满而不是缩字号 */
.wb-btn-mini{padding:0 12px;font-size:12px;min-height:44px;min-width:44px}

.wb-form{display:grid;gap:8px}
.wb-form label{display:grid;gap:4px;font-size:16px;color:var(--dsw-alias-label-secondary)}
.wb-dialog{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:16px;
  margin-bottom:16px}
.wb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;
  align-items:center;justify-content:center;z-index:1000}
/* 弹窗必须是**不透明**的浮起面：早先用 interactive-bg-hover（悬停态半透明色），
   底层页面文字会透出来，标题出现重影。改用 overlay 专用 token。
   边框用 l2（更强的一档）把浮起面和背后内容分开——不用 box-shadow，
   因为样式规范禁止硬编码颜色，而阴影色没有对应的 --dsw-alias-* 令牌。 */
.wb-overlay-panel{background:var(--dsw-alias-bg-overlay);
  border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:24px;
  min-width:320px;max-width:min(560px,90vw);max-height:80vh;overflow:auto}
.wb-overlay-panel h2{font-size:20px;margin:0 0 16px 0}
.wb-kbd{font:inherit;font-size:12px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:4px;color:var(--dsw-alias-label-tertiary)}
/* 拖拽：必须让人看见「正在拖什么」「会落到哪」 */
.wb-drag-source{opacity:.4}
.wb-drop-target{outline:2px dashed var(--dsw-alias-state-business-primary);outline-offset:-2px;
  background:var(--dsw-alias-interactive-bg-hover)}
/* 仅供读屏的播报节点：视觉上不可见，但不 aria-hidden（否则读屏也拿不到）。 */
.wb-sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip-path:inset(50%);white-space:nowrap;border:0}
.wb-drag-preview{position:fixed;pointer-events:none;z-index:2000;padding:4px 8px;border-radius:4px;
  font-size:12px;background:var(--dsw-alias-interactive-bg-hover);
  border:1px solid var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.wb-group-head{display:flex;align-items:center;gap:8px;padding:8px 0;font-size:16px;
  color:var(--dsw-alias-label-secondary)}
.wb-handle{cursor:grab;min-width:44px;min-height:44px;display:inline-flex;align-items:center;
  justify-content:center;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit}
/* WP6-D：智能规划面板。只引用 --dsw-alias-* 令牌，不硬编码颜色。 */
.wb-plan-panel{max-width:640px;max-height:80vh;overflow:auto}
.wb-plan-result{margin-top:16px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:16px}
.wb-plan-items{list-style:none;padding:0;margin:8px 0}
.wb-plan-items li{padding:8px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:16px}
.wb-plan-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;
  flex-wrap:wrap;margin-bottom:16px}
.wb-plan-summary .wb-btn{flex-shrink:0}
.wb-handle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.wb-preview-table{width:100%;border-collapse:collapse;font-size:16px}
.wb-preview-table th,.wb-preview-table td{text-align:left;padding:4px 8px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.wb-preview-create{color:var(--dsw-alias-state-business-primary)}
.wb-preview-warn{color:var(--dsw-alias-state-warn-label)}
@media (max-width:800px){.wb-side{width:100%;max-width:none;border-left:0;
  border-top:1px solid var(--dsw-alias-border-l1)}.wb-body{flex-direction:column}
  /* 日历 7 列网格在 800px 以下会被压到每格约 100px，日期数字与事件条挤成竖条。
     缩字号与内边距，让一屏仍能读出"哪天有什么事"，而不是把格子压碎。 */
  .wb-grid-7{gap:4px}
  .wb-day{padding:4px;min-height:44px}
  .wb-day-num{font-size:11px}
  .wb-event-chip{padding:4px;font-size:10px}
  /* 顶栏按钮在窄屏会换行错位：允许横向滚动而不是硬挤成一列。 */
  .wb-toolbar{flex-wrap:wrap;row-gap:8px}}
@media (max-width:520px){
  /* 更窄时把日历切成"周视图式"信息密度：只留日期数字，事件靠点击查看。
     保留网格而不是改成列表——用户在这个视图里找的是"哪一天"。 */
  .wb-day{min-height:36px;padding:4px}
  .wb-event-chip{display:none}
  .wb-day-num{font-size:10px}
  .wb-toolbar .wb-btn{padding:4px 8px;font-size:12px}}
`

    // --------------------------------------------------------------- 工具函数
    const pad = (n) => String(n).padStart(2, '0')
    const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
    const sameDay = (a, b) => isoDate(a) === isoDate(b)
    /**
     * 星期表头必须跟着语言走。
     *
     * 原来写死英文数组 + `cursor.toDateString()`，两者都由引擎给出英文，
     * 中文界面里就成了「日历 / 待办」配「Mon Tue Wed」和「Sat Nov 07 2026」。
     * 模块级常量拿不到 t（t 是组件作用域），所以做成函数，渲染时传入。
     */
    const weekdayLabels = (t) => [
      t('weekdayMon'), t('weekdayTue'), t('weekdayWed'), t('weekdayThu'),
      t('weekdayFri'), t('weekdaySat'), t('weekdaySun'),
    ]
    const formatCursor = (d, t) => {
      const locale = t('dateLocale') === 'zh' ? 'zh-CN' : 'en-US'
      try {
        return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' })
      } catch {
        // 运行环境不支持 locale 参数时退回 ISO 日期，至少不是错的英文句子
        return isoDate(d)
      }
    }
    const fmtTime = (iso) => {
      if (typeof iso !== 'string') return ''
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function eventDay(e) {
      // Event 有两种时间表达（WP1 validateEventInput 的真实契约）：
      // allDay → startDate (YYYY-MM-DD)；定时 → start (墙钟 YYYY-MM-DDTHH:mm:ss)
      const raw = e.allDay === true ? e.startDate : e.start
      if (typeof raw !== 'string' || raw === '') return null
      const d = new Date(raw.length <= 10 ? `${raw}T00:00:00` : raw)
      return Number.isNaN(d.getTime()) ? null : d
    }

    /**
     * 把「用户选的本地日期 + 本地时刻」拼成 Host 要求的 `dueAt`。
     *
     * 为什么必须在客户端拼时区：`task.dueAt` 走 `isoInstant` 硬校验，只收带
     * `Z` 或 `±HH:MM` 的时刻。裸墙钟 `2026-11-10T09:00` 会被服务端拒收。
     * 而用户选的是**本地** 09:00，不是 UTC 09:00 —— 直接拼 `Z` 会让 GMT+8
     * 的用户看到 17:00。所以这里按本机偏移补上后缀。
     *
     * 用 `new Date(y, m, d, h, min)` 构造而非 `Date.parse('YYYY-MM-DDTHH:mm')`：
     * 后者在部分引擎里按 UTC 解析，跨天会差一天。
     *
     * @param {string} datePart YYYY-MM-DD（本地日期）
     * @param {string} timePart HH:mm（本地时刻）
     * @returns {string|undefined} 带偏移的 ISO 时刻；任一部分非法时 undefined
     */
    function composeDueAt(datePart, timePart) {
      const dp = String(datePart ?? '').trim()
      const tp = String(timePart ?? '').trim()
      if (dp === '' || tp === '') return undefined
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dp)
      const tm = /^(\d{2}):(\d{2})$/.exec(tp)
      if (dm === null || tm === null) return undefined
      const [y, mo, da] = [Number(dm[1]), Number(dm[2]), Number(dm[3])]
      const [hh, mi] = [Number(tm[1]), Number(tm[2])]
      if (hh > 23 || mi > 59) return undefined
      const local = new Date(y, mo - 1, da, hh, mi, 0, 0)
      // 反查构造结果：2 月 31 日这类不存在的日期会被引擎顺延到 3 月，
      // 必须拒绝而不是默默改期。
      if (local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== da) return undefined
      const offsetMin = -local.getTimezoneOffset()
      const sign = offsetMin >= 0 ? '+' : '-'
      const abs = Math.abs(offsetMin)
      return `${dp}T${tp}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
    }

    /**
     * 反向：把已存的 `dueAt` 拆回本地日期 + 本地时刻，供编辑表单回填。
     *
     * 关键点：不能 `slice(0, 10)`。`2026-11-09T17:00:00Z` 在 GMT+8 是
     * **11 月 10 日 01:00**，切片后用户会看到 11-09，改个标题保存就把日期改错了。
     * 必须用 Date 走一遍本地时区再格式化。
     *
     * @param {unknown} raw 已存的 dueAt
     * @returns {{date: string, time: string}} 本地日期与时刻；坏值/空值返回空串
     */
    function splitDueAt(raw) {
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (text === '') return { date: '', time: '' }
      const d = new Date(text)
      if (Number.isNaN(d.getTime())) return { date: '', time: '' }
      return { date: isoDate(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
    }

    /**
 * 提醒时刻的紧凑显示：同一天只显示时刻，跨天带日期。
 * 用本地时区——用户看到的应该是自己的钟点，不是 UTC。
 */
function formatReminderTime(ms) {
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `${hh}:${mm}`
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${month}-${day} ${hh}:${mm}`
}

/**
 * 软删判定。**唯一实现**——原本这个条件在 client.js 里抄了 3 遍，
 * 变异测试证明其中 2 处抄漏了也没人发现（W4 存活）。
 * 抽成纯函数既去掉重复，也让它可以被直接测到。
 */
function isSoftDeleted(t) {
  return t?.deleted === true || (typeof t?.deletedAt === 'string' && t.deletedAt !== '')
}

/**
 * 主列表过滤（纯函数，导出给测试直接断言）。
 *
 * 三层都必须挡：软删、归档、搜索与分桶不匹配。
 * 归档那层原先只在渲染层漏了 —— reorderTasks / nudgeTask 都挡了 archived，
 * 于是同一条待办会同时出现在主列表和归档区（双渲染）。抽成纯函数后，
 * 变异把这一层改成 `if (false)` 会被行为断言直接抓住。
 */
function filterTasksForView(tasks, { search = '', taskFilter, now } = {}) {
  const q = String(search ?? '').trim().toLowerCase()
  return (tasks ?? []).filter((task) => {
    if (isSoftDeleted(task)) return false
    // 归档 = 收起来，不是删掉；但主列表也不该再显示它
    if (task?.archived === true) return false
    if (q !== '' && !String(task.title ?? '').toLowerCase().includes(q)) return false
    return taskBucket(task, now ?? new Date()) === taskFilter
  })
}

/**
 * ---- 请求体构造器（纯函数，导出给测试直接断言）----
 *
 * 这些逻辑原来内联在组件闭包里，于是**只能靠正则扫源码来验证**。
 * 后果很实在：审查 B1/B3/B4/B5 四个阻塞项全部躺在正则断言的绿区里 ——
 * 导入凭证塞错层、拖拽丢源日、排序用错基、计数本地重算，一条都没红。
 * 抽成纯函数后，测试可以直接调用它、断言真实 payload 形状，
 * 变异一改就必然红。
 */

/** 导入确认：签发请求体（内容类 op 的 target 恒为 undefined，摘要由 text 推导）。 */
function buildImportApprovalRequest(kind, text, summary) {
  /**
   * summary 会原样显示在用户审批弹窗里，所以必须能本地化。
   * 这是纯构造器、拿不到 `t`，只能由调用方传入；不传时退回英文兜底，
   * 保证旧调用点与测试不破。
   */
  return {
    op: 'confirmUserAction',
    payload: {
      approvalOp: kind === 'ics' ? 'event.import' : 'snapshot.replace',
      target: undefined,
      text,
      summary: summary ?? ('Import ' + kind + ' data'),
    },
  }
}

/** 导入执行：approvalToken 必须在**顶层**（bridge 只从顶层读）。 */
function buildImportExecuteRequest(kind, text, token) {
  return {
    op: kind === 'ics' ? 'event.import' : 'snapshot.replace',
    payload: { text },
    approvalToken: token,
  }
}

/**
 * WP6-D：规划落地的审批签发请求体。
 *
 * 与导入不同，proposal.apply 是**实体类** op：只绑 target（提案 id），
 * **绝不**带 text/digest（否则 Host 按内容类算 digest → fingerprint-mismatch，
 * WP5 实测过同款坑）。抽成构造器是为了让「签发/执行都走构造器」可被测试锁住。
 */
function buildPlanApprovalRequest(proposalId, summary) {
  return {
    op: 'confirmUserAction',
    payload: {
      approvalOp: 'proposal.apply',
      target: proposalId,
      summary,
    },
  }
}

/**
 * V1.2 · 回滚审批请求体。
 *
 * 回滚在 DANGEROUS_OPS 里，必须带一次性审批 token 才能执行。
 * `target` 绑**具体备份名**——不是 'latest'：审批通过后如果又生成了更新的
 * 备份，指纹会不匹配而被拒，而不是悄悄回滚到别的目标。
 */
function buildRollbackApprovalRequest(backupName) {
  return {
    op: 'confirmUserAction',
    payload: {
      approvalOp: 'store.rollback',
      target: backupName,
      summary: '回滚到备份 ' + backupName,
    },
  }
}

/** WP6-D：规划落地执行请求体，token 必须在顶层。 */
function buildPlanApplyRequest(proposalId, token) {
  return {
    op: 'proposal.apply',
    payload: { id: proposalId },
    approvalToken: token,
  }
}

/**
 * 改期请求体。
 * - 非重复事件：mode 恒为 'series'（服务端没有「单次」概念）。
 * - 重复事件：'single' 必须带**源日** occurrenceDate，'series' 不带。
 * 把落点当源日会被服务端静默接受，然后排除落点那天 —— 源日仍在、目标被吞。
 */
function buildEventMoveRequest(target, dateKey, modeChoice) {
  const recurring = target?.recurring === true
  const mode = recurring ? (modeChoice ?? 'series') : 'series'
  const body = { id: target?.id, mode, target: { startDate: dateKey } }
  if (recurring && mode === 'single') body.occurrenceDate = target?.occurrenceDate ?? null
  return body
}

/**
 * 排序请求体。`ids` 是**用户看到的顺序**（按 order 排），不是存储顺序。
 * 调用方负责先按 byOrder 排好再传进来。
 */
function buildReorderRequest(rows, project) {
  return { op: 'task.reorder', payload: { ids: rows.map((r) => r.id), project } }
}

/** 归档/恢复请求体。恢复是同一个 op 带 archived:false，**没有** task.unarchive。 */
function buildArchiveRequest(id, archived) {
  return { op: 'task.archive', payload: { id, archived } }
}

/** ICS 预览计数：一律用服务端 counts，不本地重算，不硬写 unsupported。 */
/**
 * `dueAt` 必须校验，不能原样提交。
 *
 * 实测后果：输入框留空或写「排序验证」都会被写进 Host，
 * 随后提醒编译对该任务报「算不出提醒时刻（数据有问题，不会响）」——
 * 一条永远不会响的待办，比没有待办更危险。
 *
 * 规则：
 * - 空串 → **不写这个字段**（不是写空串），让 Host 保持「无到期时间」
 * - 非空但不是合法 ISO 时刻 → 拦下并提示，不落盘
 *
 * 放在函数声明区（而非组件内）的原因：`__test` 在模块求值期就要引用它，
 * 定义在组件里会踩 TDZ（Cannot access 'parseDueAt' before initialization）。
 */
function parseDueAt(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { ok: true, value: undefined }
  const ms = Date.parse(text)
  if (Number.isNaN(ms)) return { ok: false, value: undefined }
  // Date.parse 宽松到危险：'1'、'12'、'2026'、'0'、'2026/11/10' 全部返回合法毫秒数。
  // 界面若按它放行，值送到服务端会被 isoInstant 拒收 → 「点保存后莫名失败」。
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) return { ok: false, value: undefined }
  return { ok: true, value: text }
}

/**
 * 到期时间该**怎么显示**（纯函数，供列表渲染与测试共用）。
 *
 * 为什么抽出来：原实现在渲染处直接 `String(row.dueAt).slice(0, 10)`，
 * 结果是坏数据 `'排序验证'` 被当成合法日期原样显示。那种写在 JSX 里的
 * 判断没法被单元测试覆盖 —— 能不能测，取决于有没有把它变成纯函数。
 *
 * @param {unknown} raw
 * @returns {{ kind: 'none' } | { kind: 'date', text: string } | { kind: 'broken', raw: string }}
 */
function dueDisplay(raw) {
  const parsed = parseDueAt(raw)
  if (parsed.ok === true && parsed.value === undefined) return { kind: 'none' }
  if (parsed.ok === true) return { kind: 'date', text: parsed.value.slice(0, 10) }
  return { kind: 'broken', raw: String(raw ?? '') }
}

function buildIcsCounts(serverCounts) {
  const c = serverCounts ?? {}
  /**
   * `degraded` 不能丢，`removed` 不能硬写 0。
   *
   * - degraded：服务端在时区信息不足时会降级解析，这类条目**不是**干净的
   *   「新增」。原来整条丢弃，degraded:1 会显示成「新增」，用户以为导进来了。
   * - removed：ICS 导入是合并语义、本来就不删东西，所以 removed 取服务端
   *   真实值（缺省 0）即可；硬写 0 会和 snapshot.preview 的
   *   removedEvents/removedTasks 自相矛盾。
   */
  const duplicate = Number(c.duplicate ?? 0)
  const conflict = Number(c.conflict ?? 0)
  const unsupported = Number(c.unsupported ?? 0)
  const degraded = Number(c.degraded ?? 0)
  /**
   * 服务端的 `skip` 是**兼容字段**，定义是「非 create 的总数」：
   *   skip = duplicate + conflict + unsupported
   * （见 service.js 的 event.previewIcs：`plan.filter(x => x.action !== 'create')`）
   *
   * UI 把 duplicate / conflict / unsupported 各自单独成行，若再把原始 skip
   * 原样显示，同一条会被数两次。实测 2 条冲突 → 「冲突 2」+「跳过 2」，
   * 用户以为 4 条有问题，实际只有 2 条。
   *
   * 所以这里只保留**真正「其它原因」**的部分：从 skip 里扣掉已经单独
   * 展示的三类。扣成负数说明服务端口径变了，钳到 0 并在测试里锁住。
   */
  const skip = Math.max(0, Number(c.skip ?? 0) - duplicate - conflict - unsupported)
  return {
    create: Number(c.create ?? 0),
    // duplicate 不得拿 skip 兜底：服务端给了 duplicate:0 / skip:1 时，
    // 兜底会把「跳过 1 条」显示成「重复 0 条」，用户以为没有重复，实际有 1 条被跳过。
    duplicate,
    skip,
    conflict,
    unsupported,
    degraded,
    removed: Number(c.removed ?? 0),
  }
}

/**
 * 组内排序比较器。**唯一实现**。
 *
 * 渲染（groupedTasks）与排序计算（reorderTasks / nudgeTask）必须用同一个
 * 比较器：渲染按 order 排，而 reorderTasks 原先用未排序的 tasks.filter
 * 算索引 —— 两个基不一致，第二次排序起就拼出错误的 ids。实测：显示
 * c,a,b 时把 b 拖到最前，期望 b,c,a，实际发 a,c,b，落库 a,c,b。
 */
function byOrder(a, b) {
  const ao = Number.isFinite(a?.order) ? a.order : Number.MAX_SAFE_INTEGER
  const bo = Number.isFinite(b?.order) ? b.order : Number.MAX_SAFE_INTEGER
  return ao - bo
}

function taskBucket(task, now) {
      // 已软删的待办不进任何桶（复审 MAJOR：删除后仍出现在列表里）
      if (isSoftDeleted(task)) return 'deleted'
      if (task.done === true) return 'done'
      const due = typeof task.dueAt === 'string' && task.dueAt !== '' ? new Date(task.dueAt) : null
      if (due !== null && !Number.isNaN(due.getTime()) && sameDay(due, now)) return 'today'
      if (task.status === 'in_progress') return 'doing'
      return 'planned'
    }

    // --------------------------------------------------------------- 数据桥
    /**
     * 唯一 Client→Host 通道：真 commands.execute。
     * 返回 {ok, value, error}；失败**不静默**，抛给调用方显示。
     */
    /**
     * Client → Host 调用（**内联**）。
     *
     * 为什么内联而不 import 同包文件：浏览器模块加载器把 require 解析到
     * **冻结的模块表**（dsh-client-modules/README.md:50「every dynamic bundle
     * resolves its externals against exactly that baseline」），相对路径
     * `./host-call.mjs` 没有对应供应者 → 注册时直接抛错 → 整个 Client 半边挂掉。
     * 真实插件只用包名 require（react / react-dom / @deepseek-ai/...）。
     *
     * 测试不复制这份逻辑，而是从本文件**提取**出来测（见
     * workbench-core/test/workbench-ui-bridge.test.mjs 的 extractCallHost），
     * 所以仍然只有一份实现。
     */
    async function callHost(ctx, sessionId, req) {
      const line = `/workbench ${JSON.stringify(req)}`
      const result = await ctx.remote.commands.execute(sessionId, line, [])
      if (result === undefined || result === null) {
        return { ok: false, error: { code: 'no_result', message: 'command returned no result' } }
      }
      if (result.ok === false) {
        return { ok: false, error: result.error ?? { code: 'command_failed', message: 'command failed' } }
      }
      const envelope = result.value
      const command = envelope !== null && typeof envelope === 'object' ? envelope.result : undefined
      const text = command !== null && typeof command === 'object' && typeof command.text === 'string'
        ? command.text
        : (typeof envelope === 'string' ? envelope : undefined)
      if (typeof text === 'string' && text !== '') {
        try {
          const decoded = JSON.parse(text)
          if (decoded !== null && typeof decoded === 'object') return decoded
        } catch { /* 非 JSON 文本按原样返回 */ }
      }
      if (command?.kind === 'error') {
        return { ok: false, error: { code: 'command_error', message: text ?? 'command failed' } }
      }
      return { ok: true, value: text }
    }

    /**
     * 供测试取用**真实**实现（复审 N1 / MAJOR-1）：
     *  - callHost：解码逻辑若被复刻，真 bug 复活时测试仍全绿；
     *  - 组件：渲染期异常（如第三轮的 `t is not defined`）静态断言测不出，
     *    必须能真实调用组件函数才能捕获。
     * 仅测试进程使用；生产路径不依赖它。
     */
    const __test = {
      callHost,
      // 让测试读真实键集，而不是拿正则去扫源码（正则扫出的键数和真实 LOCALE 对不上）
      LOCALE,
      // 请求体构造器：让测试断言真实 payload 形状，而不是扫源码正则
      buildImportApprovalRequest, buildImportExecuteRequest, buildEventMoveRequest,
      buildReorderRequest, buildArchiveRequest, buildIcsCounts,
      // WP6-D：规划审批/执行请求体构造器
      buildPlanApprovalRequest, buildPlanApplyRequest,
      // V1.2：备份回滚审批请求体
      buildRollbackApprovalRequest,
      // 纯函数：软删判定与分桶。行为测试要能直接调，不能只靠正则看源码。
      isSoftDeleted,
      taskBucket,
      filterTasksForView,
      // 到期时间解析：坏值必须拦在本地，不能落盘让提醒层降级
      parseDueAt,
      // 到期时间的展示决策：坏数据不能原样当日期显示
      dueDisplay,
      // 到期时间的本地时区双向转换：表单提交/回填的唯一实现
      composeDueAt,
      splitDueAt,
      // 三个弹窗组件：渲染期异常的探针目标（第三轮 BLOCKER-1 就是它们）
      EventForm,
      TaskForm,
      // V1.1 §2：协作面板。组件化之后能被真渲染断言，
      // 「空列表显示什么」「pending 时按钮有没有」不再是正则猜的。
      CollabPanel,
      ConfirmDelete,
      PlanPanel,
      WorkbenchPage,
    }

    // --------------------------------------------------------------- 组件
    function StatusBar({ loading, error, onRetry, t = defaultT }) {
      if (loading) return h('div', { className: 'wb-status', role: 'status', 'aria-live': 'polite' }, t('loading'))
      if (error) {
        return h('div', { className: 'wb-status wb-status-error', role: 'alert' },
          h('span', null, `${t('error')}: ${error}`),
          h('button', { className: 'wb-btn', type: 'button', onClick: onRetry, 'aria-label': t('retry') }, t('retry')))
      }
      return h('div', { className: 'wb-status', role: 'status', 'aria-live': 'polite' }, t('ready'))
    }

    function ViewTabs({ value, onChange, options, t = defaultT }) {
      return h('div', { className: 'wb-tabs', role: 'tablist', 'aria-label': t('view') },
        options.map((o) => h('button', {
          key: o.id, className: 'wb-btn', type: 'button', role: 'tab',
          'aria-selected': value === o.id, 'aria-pressed': value === o.id,
          onClick: () => onChange(o.id),
        }, o.label)))
    }

    /**
     * 月视图：日期格是放置目标，事件块是可拖拽项。
     *
     * 为什么把日期格从 `button` 改成 `div[role=button]`：
     * 事件块本身必须是可点击、可拖拽的按钮，把它塞进另一个 button 里
     * 既是非法 HTML，也会让拖拽手势被父级按钮吃掉——拖不动。
     * 现在空区域点击 = 选这天，事件块点击 = 选这个事件，两者互不干扰。
     */
    function MonthView({ events, cursor, onSelectDay, onSelectEvent, drag, setDrag, dropHint, setDropHint, onDropEvent, t = defaultT }) {
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
      const offset = (first.getDay() + 6) % 7 // Monday first
      const start = addDays(first, -offset)
      const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i))
      const today = new Date()
      const byDay = useMemo(() => {
        const m = new Map()
        for (const e of events) {
          const d = eventDay(e)
          if (d === null) continue
          const k = isoDate(d)
          if (!m.has(k)) m.set(k, [])
          m.get(k).push(e)
        }
        return m
      }, [events])
      return h('div', { className: 'wb-grid wb-grid-7' },
        weekdayLabels(t).map((w) => h('div', { key: w, className: 'wb-tertiary', style: { padding: '8px', fontSize: '12px' } }, w)),
        cells.map((d) => {
          const k = isoDate(d)
          const list = byDay.get(k) ?? []
          const inMonth = d.getMonth() === cursor.getMonth()
          const isTarget = dropHint !== null && dropHint.kind === 'event' && dropHint.dateKey === k
          return h('div', {
            key: k,
            role: 'button',
            tabIndex: 0,
            className: `wb-cell${sameDay(d, today) ? ' wb-cell-today' : ''}${isTarget ? ' wb-drop-target' : ''}`,
            'aria-label': `${k}, ${list.length} ${t('nEvents')}; ${t('dragToReschedule')}`,
            onClick: () => onSelectDay(d),
            onKeyDown: (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelectDay(d) }
            },
            onDragOver: (ev) => {
              // 只有拖事件时才接受；拖待办到月视图没有语义
              if (drag === null || drag.kind !== 'event') return
              ev.preventDefault()
              ev.dataTransfer.dropEffect = 'move'
              if (dropHint === null || dropHint.dateKey !== k) {
                setDropHint({ kind: 'event', dateKey: k })
              }
            },
            onDragLeave: () => {
              if (dropHint !== null && dropHint.kind === 'event' && dropHint.dateKey === k) setDropHint(null)
            },
            onDrop: (ev) => {
              ev.preventDefault()
              setDropHint(null)
              if (drag === null || drag.kind !== 'event') return
              onDropEvent(drag, k)
            },
            style: { opacity: inMonth ? 1 : 0.45 },
          },
            h('div', null, String(d.getDate())),
            list.slice(0, 2).map((e) => h('button', {
              key: e.id,
              type: 'button',
              draggable: true,
              className: `wb-tertiary${drag !== null && drag.id === e.id ? ' wb-drag-source' : ''}`,
              'aria-label': `${e.title || t('event')}, ${t('openDetailsHint')}`,
              title: t('dragToReschedule'),
              onClick: (ev) => { ev.stopPropagation(); onSelectEvent(e) },
              onDragStart: (ev) => {
                ev.stopPropagation()
                ev.dataTransfer.effectAllowed = 'move'
                // 必须设 data：某些浏览器不给 dataTransfer 就不认这次拖拽
                ev.dataTransfer.setData('text/plain', e.id)
                /**
                 * **必须带上被拖那个实例的真实源日期。**
                 *
                 * 服务端 event.move 的 occurrenceDate 语义是「源实例日期」
                 * （service.js:327 `instances.find(occ => occ.startDate === occurrenceDate)`），
                 * 不是落点日期。原来这里不带，展开成 undefined 后被
                 * JSON.stringify 丢掉键 → 「只改这一次」必然 validation 失败。
                 * 更糟的是若把落点当源日传：DAILY 系列会返回成功，但
                 * excludeDates 记的是落点那天 —— 实测源日仍在、目标那天被吞掉，
                 * 静默写坏数据。MonthView 拿到的是系列母体，源日就是母体自身日期。
                 */
                setDrag({ kind: 'event', id: e.id, title: e.title, allDay: e.allDay === true,
                  recurring: e.recurrence != null,
                  occurrenceDate: (() => { const d = eventDay(e); return d === null ? null : isoDate(d) })() })
              },
              onDragEnd: () => { setDrag(null); setDropHint(null) },
              /**
               * 月视图事件条既是点击目标又是拖拽把手，点击区必须 >= 44px。
               * 原来 padding:0 + 12px 行高，实际只有十几像素高，触控很难点中。
               */
              style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis',
                whiteSpace: 'nowrap', border: 0, background: 'transparent', textAlign: 'left',
                color: 'inherit', padding: '12px 8px', cursor: 'grab', maxWidth: '100%',
                minHeight: '44px', display: 'flex', alignItems: 'center' },
            }, e.allDay ? 'All day · ' : `${fmtTime(e.start)} · `, e.title)))
        }))
    }

    function AgendaList({ events, onSelect, emptyText, drag, setDrag, t = defaultT, groupByDay = false }) {
      if (events.length === 0) return h('div', { className: 'wb-empty' }, emptyText)
      const d = drag ?? null
      const set = setDrag ?? (() => {})
      /**
       * **按天分组**（V1.2）。
       *
       * 周/日视图原来是一根扁平列表：用户看不出哪天有安排、哪天是空的，
       * 而「这周哪几天空着」恰恰是周视图唯一要回答的问题。
       *
       * 只有显式传 groupByDay 才分组 —— 「今日 & 接下来 7 天」那块本来就是
       * 连续时间线，分组反而把它割碎。
       */
      const emitRow = (e) => {
        const dragging = d !== null && d.id === e.id
        const main = h('button', {
          className: 'wb-row-main', type: 'button',
          draggable: true,
          title: t('dragToMonthGrid'),
          'aria-label': (e.title || t('event')) + ', ' + t('draggableHint'),
          onClick: () => onSelect(e),
          onDragStart: (ev) => {
            ev.dataTransfer.effectAllowed = 'move'
            ev.dataTransfer.setData('text/plain', e.id)
            // 源日必须随拖拽一起走：漏了就会回退成落点，静默写坏重复事件（M-2）
            set({ kind: 'event', id: e.id, title: e.title, allDay: e.allDay === true,
              recurring: e.recurrence != null,
              occurrenceDate: (() => { const d2 = eventDay(e); return d2 === null ? null : isoDate(d2) })() })
          },
          onDragEnd: () => set(null),
        },
          h('span', null, e.allDay === true ? t('allDay') : fmtTime(e.start)),
          h('span', { style: { flex: 1 } }, e.title || '(untitled)'),
          e.recurrence ? h('span', { className: 'wb-badge' }, t('repeat')) : null,
          e.conflict === true ? h('span', { className: 'wb-badge' }, t('fieldConflict')) : null)
        const more = h('button', {
          className: 'wb-btn', type: 'button',
          'aria-label': t('openLabel').replace('{title}', e.title || t('untitledEvent')),
          onClick: () => onSelect(e),
        }, '…')
        return h('div', {
          key: e.id,
          className: 'wb-row' + (dragging ? ' wb-drag-source' : ''),
        }, main, more)
      }

      if (groupByDay !== true) return h('div', null, events.map(emitRow))

      // 按本地日期键分组，保持原始时间顺序
      const groups = []
      const index = new Map()
      for (const e of events) {
        const day = eventDay(e)
        const key = day === null ? '' : isoDate(day)
        let g = index.get(key)
        if (g === undefined) { g = { key, items: [] }; index.set(key, g); groups.push(g) }
        g.items.push(e)
      }
      return h('div', null, groups.map((g) => h('div', { key: g.key || 'undated', className: 'wb-daygroup' },
        h('div', { className: 'wb-daygroup-head' }, g.key === '' ? t('fieldCustom') : g.key),
        g.items.map(emitRow))))
    }

    /**
     * 重复事件拖拽改期时的范围选择。
     *
     * 为什么不替用户默认选一个：改「这一次」会写 EXDATE + 新建独立事件，
     * 改「整个系列」会平移全部实例——数据后果完全不同，猜错就是错改用户的日历。
     */
    /**
     * 对话框的 Escape 关闭。
     *
     * 三个弹窗都声明了 `aria-modal:'true'`，但都没有 Escape、也没有焦点陷阱 ——
     * 对读屏来说这是**错误声明**，比不写更误导：它宣告「这是模态」，
     * 键盘用户却 Tab 得出去、Esc 关不掉，只能一路 Tab 找到取消按钮。
     * 焦点陷阱需要完整实现，Escape 这一条先补上（成本最低、收益最直接）。
     */
    function useEscapeClose(onCancel) {
      useEffect(() => {
        const onKey = (ev) => {
          if (ev.key !== 'Escape') return
          ev.preventDefault()
          ev.stopPropagation()
          onCancel?.()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onCancel])
    }

    function MoveScopeDialog({ title, dateKey, onChoose, onCancel, t = defaultT }) {
      useEscapeClose(onCancel)
      return h('div', { className: 'wb-overlay', role: 'dialog', 'aria-modal': 'true',
        'aria-label': t('moveScope') },
        h('div', { className: 'wb-overlay-panel' },
          h('h2', null, t('moveScopeTitle')),
          h('p', { className: 'wb-muted' }, t('moveScopeBody').replace('{title}', title ?? t('untitled')).replace('{date}', dateKey)),
          h('div', { style: { display: 'grid', gap: '8px', marginTop: '16px' } },
            h('button', { className: 'wb-btn', type: 'button',
              'aria-label': t('moveSingle'), onClick: () => onChoose('single') },
              t('moveSingle'), h('span', { className: 'wb-tertiary', style: { fontSize: '12px' } }, '  ' + t('moveSingleHint'))),
            h('button', { className: 'wb-btn', type: 'button',
              'aria-label': t('moveSeries'), onClick: () => onChoose('series') },
              t('moveSeries'), h('span', { className: 'wb-tertiary', style: { fontSize: '12px' } }, '  ' + t('moveSeriesHint'))),
            h('button', { className: 'wb-btn', type: 'button', onClick: onCancel }, t('cancel')))))
    }

    /**
     * 导入预览面板：**先看清会发生什么，再决定导不导**。
     *
     * 四类必须分开显示（新增 / 重复 / 冲突 / 不支持），因为用户对它们的
     * 处置预期完全不同：重复的通常跳过，冲突的要看要不要覆盖，
     * 不支持的要知道「哪些东西导不进来」——合并成一句「导入成功」就是骗人。
     */
    function ImportPreview({ preview, onConfirm, onCancel, approving, t = defaultT }) {
      useEscapeClose(onCancel)
      if (preview === null || preview === undefined) return null
      const c = preview.counts ?? {}
      const row = (label, n, hint, cls) => h('tr', { key: label },
        h('td', cls ? { className: cls } : null, label),
        h('td', null, String(n ?? 0)),
        // hint 列是「这条会不会写进库里」的决策依据，不是装饰性元信息。
        // 12px 在这个位置上属于可读性风险，按正文 16px 处理。
        h('td', { className: 'wb-tertiary' }, hint))
      const body = [
        row(t('previewCreate'), c.create, t('previewCreateHint'), 'wb-preview-create'),
        row(t('previewDuplicate'), c.duplicate, t('previewDuplicateHint')),
        row(t('previewConflict'), c.conflict, t('previewConflictHint'), 'wb-preview-warn'),
        row(t('previewUnsupported'), c.unsupported, t('previewUnsupportedHint'), 'wb-preview-warn'),
        row(t('previewRemoved'), c.removed, t('previewRemovedHint')),
        // degraded：时区信息不足被降级解析的条目，它们不是干净的「新增」，
        // 混进新增数会让用户以为导进来的东西和原件一致。
        row(t('previewDegraded'), c.degraded, t('previewDegradedHint'), 'wb-preview-warn'),
        // skip：与 duplicate 分开显示，合并会把「跳过」误报成「重复」。
        row(t('previewSkip'), c.skip, t('previewSkipHint')),
      ]
      const unsupportedList = Array.isArray(preview.unsupported) ? preview.unsupported : []
      const warningList = Array.isArray(preview.warnings) ? preview.warnings : []
      const sections = []
      if (unsupportedList.length > 0) {
        sections.push(h('div', { key: 'unsup', style: { marginTop: '16px' } },
          h('h3', { style: { fontSize: '16px' } }, t('unsupportedTitle')),
          h('ul', null, unsupportedList.slice(0, 10).map((u, i) => h('li', {
            key: i, className: 'wb-status-error',
          }, u.kind + '「' + (u.detail ?? '') + '」：' + (u.reason ?? t('unsupportedFallback')))))))
      }
      if (warningList.length > 0) {
        sections.push(h('div', { key: 'warn', style: { marginTop: '16px' } },
          h('h3', { style: { fontSize: '16px' } }, t('warningsTitle')),
          h('ul', null, warningList.slice(0, 10).map((w, i) => h('li', {
            key: i, className: 'wb-status-error',
          }, String(w?.message ?? w))))))
      }
      const foot = h('div', { style: { display: 'flex', gap: '8px', marginTop: '16px' } },
        h('button', { className: 'wb-btn wb-btn-danger', type: 'button',
          disabled: approving, 'aria-label': t('confirmImport'), onClick: onConfirm },
        approving ? t('importing') : t('confirmImport')),
        h('button', { className: 'wb-btn', type: 'button', onClick: onCancel }, t('cancel')))
      const note = h('p', { className: 'wb-tertiary', style: { fontSize: '12px', marginTop: '16px' } },
        t('importNote'))
      return h('div', { className: 'wb-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('importPreviewTitle') },
        h('div', { className: 'wb-overlay-panel' },
          h('h2', null, t('importPreviewTitle')),
          h('table', { className: 'wb-preview-table' },
            h('thead', null, h('tr', null, h('th', null, t('previewColKind')), h('th', null, t('previewColCount')), h('th', null, t('previewColHint')))),
            h('tbody', null, body)),
          sections,
          note,
          foot))
    }

    function EventForm({ initial, onSave, onCancel, saving, t = defaultT }) {
      const [title, setTitle] = useState(initial?.title ?? '')
      const [date, setDate] = useState(() => {
        const d = eventDay(initial ?? {}) ?? new Date()
        return isoDate(d)
      })
      const [time, setTime] = useState(() => {
        const d = eventDay(initial ?? {})
        return d === null ? '09:00' : `${pad(d.getHours())}:${pad(d.getMinutes())}`
      })
      const [allDay, setAllDay] = useState(initial?.allDay === true)
      const [description, setDescription] = useState(initial?.description ?? '')
      const submit = (ev) => {
        ev.preventDefault()
        if (title.trim() === '') return
        const payload = allDay
          ? { title: title.trim(), allDay: true, startDate: date, description }
          : { title: title.trim(), allDay: false, start: `${date}T${time}:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, description }
        if (initial?.id !== undefined) payload.id = initial.id
        onSave(payload)
      }
      return h('form', { className: 'wb-form', onSubmit: submit },
        h('label', null, t('fieldTitle'),
          h('input', { className: 'wb-input', value: title, onChange: (e) => setTitle(e.target.value), required: true, autoFocus: true })),
        h('label', null, t('date'),
          h('input', { className: 'wb-input', type: 'date', value: date, onChange: (e) => setDate(e.target.value) })),
        h('label', null, t('allDay'),
          h('input', { type: 'checkbox', checked: allDay, onChange: (e) => setAllDay(e.target.checked), style: { minHeight: '44px', minWidth: '44px' } })),
        allDay ? null : h('label', null, t('time'),
          h('input', { className: 'wb-input', type: 'time', value: time, onChange: (e) => setTime(e.target.value) })),
        h('label', null, t('fieldDescription'),
          h('input', { className: 'wb-input', value: description, onChange: (e) => setDescription(e.target.value) })),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { className: 'wb-btn wb-btn-primary', type: 'submit', disabled: saving }, saving ? t('saving') : t('save')),
          h('button', { className: 'wb-btn', type: 'button', onClick: onCancel }, t('cancel'))))
    }

    function TaskForm({ initial, onSave, onCancel, saving, t = defaultT }) {
      const [title, setTitle] = useState(initial?.title ?? '')
      /**
       * 到期时间的三项状态：日期、时刻、是否「无截止」。
       *
       * 原实现是一个裸文本框 + `placeholder='2026-11-10T09:00:00Z'`。
       * 那个灰字**看起来像已填好的默认值**，实际 useState 拿到的是空串，
       * 提交时走 `delete next.dueAt` —— 用户以为设了今天，落库是无截止，
       * 待办就掉进「计划中 › 未分组」而不是「今日」。
       *
       * 改成真控件 + 真默认值：新建时预填今天 09:00（用户可见、可改、会被提交），
       * 编辑时按本地时区回填已存时刻（不能 slice，否则跨天会改错日期）。
       */
      const initialSplit = splitDueAt(initial?.dueAt)
      const isNew = initial?.id === undefined
      const [dueDate, setDueDate] = useState(() => {
        if (initialSplit.date !== '') return initialSplit.date
        return isNew ? isoDate(new Date()) : ''
      })
      const [dueTime, setDueTime] = useState(() => (initialSplit.time !== '' ? initialSplit.time : '09:00'))
      const [noDue, setNoDue] = useState(() => !isNew && initialSplit.date === '')
      const [priority, setPriority] = useState(initial?.priority ?? 'normal')
      const [formError, setFormError] = useState(null)
      const submit = (ev) => {
        ev.preventDefault()
        if (title.trim() === '') return
        // 两条路径都走 composeDueAt：用户填的日期和「今天」默认值用同一套时区逻辑
        const composed = noDue ? undefined : composeDueAt(dueDate, dueTime)
        if (noDue === false && composed === undefined) {
          setFormError(t('dueAtInvalid'))
          return
        }
        setFormError(null)
        const next = {
          ...(initial ?? {}),
          id: initial?.id ?? `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: title.trim(), priority,
          done: initial?.done === true,
          status: initial?.status ?? 'planned',
        }
        // 无截止用 delete 而不是赋 ''：'' 不是「无到期时间」，是坏数据
        if (composed === undefined) delete next.dueAt
        else next.dueAt = composed
        onSave(next)
      }
      return h('form', { className: 'wb-form', onSubmit: submit },
        h('label', null, t('fieldTitle'),
          h('input', { className: 'wb-input', value: title, onChange: (e) => setTitle(e.target.value), required: true, autoFocus: true })),
        h('label', null, t('dueDateLabel'),
          h('input', {
            className: 'wb-input', type: 'date', value: dueDate,
            disabled: noDue,
            onChange: (e) => setDueDate(e.target.value),
          })),
        h('label', null, t('dueTimeLabel'),
          h('input', {
            className: 'wb-input', type: 'time', value: dueTime,
            disabled: noDue,
            onChange: (e) => setDueTime(e.target.value),
          })),
        h('label', null, t('noDueLabel'),
          h('input', {
            type: 'checkbox', checked: noDue,
            onChange: (e) => setNoDue(e.target.checked),
            style: { minHeight: '44px', minWidth: '44px' },
          })),
        formError === null ? null : h('div', { className: 'wb-preview-warn', role: 'alert' }, formError),
        h('label', null, t('priority'),
          h('select', { className: 'wb-input', value: priority, onChange: (e) => setPriority(e.target.value) },
            h('option', { value: 'low' }, t('priorityLow')),
            h('option', { value: 'normal' }, t('priorityNormal')),
            h('option', { value: 'high' }, t('priorityHigh')))),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { className: 'wb-btn wb-btn-primary', type: 'submit', disabled: saving }, saving ? t('saving') : t('save')),
          h('button', { className: 'wb-btn', type: 'button', onClick: onCancel }, t('cancel'))))
    }

    function ConfirmDelete({ label, onConfirm, onCancel, approving, t = defaultT }) {
      useEscapeClose(onCancel)
      return h('div', { className: 'wb-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('confirmDelete') },
        h('div', { className: 'wb-overlay-panel' },
          h('h2', null, t('delete'), '?'),
          h('p', null, t('confirmDeleteHint').replace('{label}', label)),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button', { className: 'wb-btn wb-btn-danger', type: 'button', disabled: approving, onClick: onConfirm }, approving ? t('requestingApproval') : t('requestApprovalDelete')),
            h('button', { className: 'wb-btn', type: 'button', onClick: onCancel }, t('cancel')))))
    }


    /**
     * WP6-D · 智能规划提案面板。
     *
     * 纯渲染组件（不直接调 Host）：所有写操作由 WorkbenchPage 的回调执行，
     * 这样测试能真实调用组件并断言渲染结果，而不必驱动 React 生命周期。
     *
     * 硬纪律：AI 生成的 reasoning / item.reason 都是**不可信文本**，
     * 这里只当字符串展示，绝不解析、绝不作为指令、绝不拼进可执行结构。
     */
    function PlanPanel({ proposal, stats, onGenerate, onConfirm, onReject, onModify, onClose,
      goal, onGoalChange, windowKind, onWindowChange, generating, approving, t = defaultT }) {
      useEscapeClose(onClose)
      const items = Array.isArray(proposal?.items) ? proposal.items : []
      const conflicts = Array.isArray(proposal?.conflicts) ? proposal.conflicts : []
      const hasProposal = proposal !== null && proposal !== undefined
      return h('div', { className: 'wb-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('aiPlanTitle') },
        h('div', { className: 'wb-overlay-panel wb-plan-panel' },
          h('h2', null, t('aiPlanTitle')),
          h('p', { className: 'wb-tertiary' }, t('aiPlanHint')),
          // 输入区：目标 + 时间窗 + 生成
          h('label', null, t('goalLabel'),
            h('textarea', {
              className: 'wb-input', rows: 3, value: goal,
              onChange: (e) => onGoalChange(e.target.value),
              placeholder: t('goalLabel'),
            })),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } },
            h('button', {
              className: 'wb-btn', type: 'button',
              'aria-label': t('windowToday'),
              onClick: () => onWindowChange('today'),
            }, windowKind === 'today' ? '● ' : '', t('windowToday')),
            h('button', {
              className: 'wb-btn', type: 'button',
              'aria-label': t('windowWeek'),
              onClick: () => onWindowChange('week'),
            }, windowKind === 'week' ? '● ' : '', t('windowWeek')),
            h('button', {
              className: 'wb-btn wb-btn-primary', type: 'button',
              disabled: generating || goal.trim() === '',
              onClick: onGenerate,
            }, generating ? t('generating') : t('generatePlan'))),
          // 提案区
          hasProposal
            ? h('div', { className: 'wb-plan-result' },
                h('h3', null, t('planStats')
                  .replace('{decomposed}', String(stats?.decomposed ?? 0))
                  .replace('{scheduled}', String(stats?.scheduled ?? 0))
                  .replace('{used}', String(stats?.usedMinutes ?? 0))
                  .replace('{capacity}', String(stats?.capacityMinutes ?? 0))),
                stats?.overloaded === true
                  ? h('div', { className: 'wb-status-error', role: 'alert' },
                      t('planOverloaded').replace('{used}', String(stats.usedMinutes)).replace('{capacity}', String(stats.capacityMinutes)))
                  : null,
                proposal.reasoning
                  ? h('p', { className: 'wb-tertiary' }, t('planReason'), '：', proposal.reasoning)
                  : null,
                conflicts.length > 0
                  ? h('div', null, h('h3', null, t('planConflicts')),
                      h('ul', null, conflicts.slice(0, 5).map((c, i) =>
                        h('li', { key: i, className: 'wb-status-error' },
                          String(c?.a?.eventId ?? c?.eventId ?? JSON.stringify(c))))))
                  : null,
                h('h3', null, t('planItems')),
                items.length === 0
                  ? h('div', { className: 'wb-muted' }, t('planEmpty'))
                  : h('ul', { className: 'wb-plan-items' }, items.map((item, i) =>
                      h('li', { key: i },
                        h('strong', null, String(item.op ?? '')),
                        ' · ',
                        String(item.payload?.title ?? ''),
                        item.reason ? h('span', { className: 'wb-tertiary' }, ' — ', item.reason) : null))),
                h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '16px' } },
                  h('button', {
                    className: 'wb-btn wb-btn-primary', type: 'button',
                    disabled: approving || items.length === 0,
                    onClick: onConfirm,
                  }, approving ? t('planApproving') : t('confirmPlan')),
                  h('button', { className: 'wb-btn', type: 'button', onClick: onReject }, t('rejectPlan')),
                  h('button', { className: 'wb-btn', type: 'button', onClick: onModify }, t('modifyPlan'))))
            : null,
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '16px' } },
            h('button', { className: 'wb-btn', type: 'button', onClick: onClose }, t('planBack')))))
    }

    // ------------------------------------------------------- 协作面板组件
    /**
     * Agent 协作面板：把任务详情里原先内联的一段展示逻辑独立成组件。
     *
     * 拆出来的原因不是「代码好看」，是内联 IIFE 无法测：
     * `TaskForm` / `EventForm` 都能通过 `__test` 直接渲染断言，唯独协作区
     * 藏在 WorkbenchPage 的 h() 树深处，只能靠正则扫源码 —— 而正则扫不出
     * 「空数组时显示什么」。V1.1 要交付的是**真实可用**的面板，
     * 必须能对每种状态做行为断言。
     *
     * 六项能力对应：
     *   ① 任务关联 —— sessionLinks 列表 + 复制 sessionId（契约 §7.1：插件层
     *      无会话跳转契约，不自造 openSession，故落地为可复制的标识）
     *   ② 执行进度 —— progress 百分比 + 当前任务 + 执行状态
     *   ③ 完成申请 —— completion.status === 'pending' 时显著提示
     *   ④ 人工验收 —— 只在 pending 时出现，按钮由父层传入（保持唯一入口）
     *   ⑤ 实时刷新 —— 由父层定时 load，这里只管渲染
     *   ⑥ 异常处理 —— 三种异常各有明确文案，不静默
     */
    function CollabPanel({ task, t = defaultT, onCopySession, copying = false, onAccept, onReject, saving = false, onOpenSession, isKnownSession }) {
      const links = Array.isArray(task?.sessionLinks) ? task.sessionLinks : []
      const log = Array.isArray(task?.executionLog) ? task.executionLog : []
      const comp = task?.completion ?? null
      /**
       * 进度取值：优先用任务行上的 progress，否则取**时间戳最新**的那条日志。
       *
       * 为什么不能取 `log[log.length - 1]`（V1.2 缺陷修复）：
       * `task.list` 会把多个会话的 executionLog 合并后按 `at` 字符串排序再截断，
       * 合并结果的数组末位**不等于**最新一次写入。实测：先写 66、再写 99，
       * 界面显示 66 —— 用户以为 Agent 卡住了，实际早就到 99。
       *
       * 按 `Date.parse(at)` 取最大值才是「最新进度」的正确语义；
       * 时间戳解析不出来时才退回数组末位。
       */
      const latestLogEntry = (() => {
        if (log.length === 0) return null
        let best = null
        let bestMs = -Infinity
        for (const e of log) {
          const ms = Date.parse(String(e?.at ?? ''))
          if (!Number.isFinite(ms)) continue
          if (ms >= bestMs) { bestMs = ms; best = e }
        }
        return best ?? log[log.length - 1]
      })()
      /**
       * `task.progress` 是共享 assignment 上的**快照值**，可能落后于 executionLog。
       *
       * 实测：日志已有 66 和 99 两条，而 assignment 上的 progress 还停在 66，
       * 于是界面显示 66% —— 用户看到的是「卡住了」而不是「快完成了」。
       * 日志里存在更晚的写入时，以日志为准。
       */
      const logProgress = latestLogEntry !== null && Number.isFinite(latestLogEntry.progress)
        ? latestLogEntry.progress
        : null
      const progress = logProgress !== null
        ? logProgress
        : (Number.isFinite(task?.progress) ? task.progress : 0)
      /**
       * 执行状态：把 progress 与 completion 合成一个用户能读的短语。
       * 不能只显示数字 —— 「60 / 99」用户不知道是在跑还是卡住了。
       */
      const statusKind = comp?.status === 'pending'
        ? 'awaiting'
        : comp?.status === 'accepted'
          ? 'accepted'
          : comp?.status === 'rejected'
            ? 'rejected'
            : log.length > 0
              ? 'executing'
              : 'idle'
      const statusLabel = {
        awaiting: t('collabStatusAwaiting'),
        accepted: t('collabStatusAccepted'),
        rejected: t('collabStatusRejected'),
        executing: t('collabStatusExecuting'),
        idle: t('collabStatusIdle'),
      }[statusKind]
      /**
       * 异常处理（V1.1 §2.6）。三种真实的读不到/不一致：
       *   - session-missing：关联了会话但链接没有任何 sessionId
       *   - log-corrupt：executionLog 存在但不是数组（旧数据形态）
       *   - progress-broken：progress 有值但不是有限数字
       * 全部显式说清楚，不用空列表掩盖。
       */
      const anomalies = []
      if (links.length === 0 && task?.source === 'shared-assignment') {
        anomalies.push({ kind: 'session-missing', text: t('collabErrSessionMissing') })
      }
      if (task?.executionLog !== undefined && task?.executionLog !== null && !Array.isArray(task.executionLog)) {
        anomalies.push({ kind: 'log-corrupt', text: t('collabErrLogCorrupt') })
      }
      if (task?.progress !== undefined && task?.progress !== null && !Number.isFinite(task.progress)) {
        anomalies.push({ kind: 'progress-broken', text: t('collabErrProgressBroken') })
      }
      return h('div', { className: 'wb-collab' },
        h('h3', { className: 'wb-collab-title' }, t('collabTitle')),
        // ---- ② 执行进度 + 当前任务 + 执行状态
        h('div', { className: 'wb-collab-row' },
          h('span', { className: 'wb-tertiary' }, t('aiProgress')),
          h('span', { className: 'wb-collab-progress' }, `${progress}%`),
          h('span', { className: `wb-collab-status wb-collab-${statusKind}` }, statusLabel)),
        /**
         * 预计耗时：原先在内联 IIFE 里展示，重构时必须原样带过来 ——
         * 组件化不是为了减功能。Agent 排期依赖这个数字，用户看不到
         * 就无法判断「说两小时，一天没动静」是不是异常。
         */
        Number.isFinite(task?.estimatedMinutes)
          ? h('div', { className: 'wb-collab-row' },
              h('span', { className: 'wb-tertiary' }, t('estimateLabel')),
              h('span', null, String(task.estimatedMinutes)))
          : null,
        h('div', { className: 'wb-collab-bar', role: 'progressbar', 'aria-valuenow': progress, 'aria-valuemin': 0, 'aria-valuemax': 99 },
          h('div', { className: 'wb-collab-bar-fill', style: { width: `${Math.max(0, Math.min(99, progress))}%` } })),
        // ---- ⑥ 异常提示
        anomalies.length === 0 ? null : h('ul', { className: 'wb-collab-anomalies', role: 'alert' },
          anomalies.map((a, i) => h('li', { key: i, className: 'wb-collab-anomaly' }, a.text))),
        // ---- ① 任务关联
        h('div', { className: 'wb-collab-section' },
          h('div', { className: 'wb-tertiary' }, t('aiSessionLinks')),
          links.length === 0
            ? h('div', { className: 'wb-muted' }, t('noSessions'))
            : h('ul', { className: 'wb-collab-links' }, links.map((l, i) => {
                const sid = String(l.sessionId ?? '')
                /**
                 * 「能否打开这个会话」取决于它是否**还在当前窗口的会话列表里**。
                 *
                 * 插件层能做的跳转只有 `uiWorkspace.openSession(sessionId)`
                 * （dsh-client-ui-workspace 公开服务，内部走 sessions.retain
                 * + mainView 选中 + layout.selectPanel(null)）。
                 * 它只能切到**已存在**的会话；会话被删/属于别的工作区时，
                 * 调了也不会有反应 —— 所以在按钮层就先判定，并明确说为什么。
                 */
                const known = typeof isKnownSession === 'function' ? isKnownSession(sid) : null
                return h('li', { key: i },
                  h('code', null, sid),
                  ' · ',
                  h('span', { className: 'wb-collab-role' }, String(l.role ?? 'other')),
                  l.note ? h('span', { className: 'wb-tertiary' }, ' — ', l.note) : null,
                  typeof onOpenSession === 'function'
                    ? h('button', {
                        className: 'wb-btn wb-btn-mini', type: 'button',
                        disabled: known === false,
                        title: known === false ? t('collabSessionGone') : t('collabOpenSession'),
                        'aria-label': t('collabOpenSession'),
                        onClick: () => onOpenSession(sid),
                      }, t('collabOpenSession'))
                    : null,
                  typeof onCopySession === 'function'
                    ? h('button', {
                        className: 'wb-btn wb-btn-mini', type: 'button',
                        disabled: copying,
                        'aria-label': t('collabCopySession'),
                        onClick: () => onCopySession(sid),
                      }, copying ? t('collabCopying') : t('collabCopySession'))
                    : null,
                  // 会话已不在列表里时给出人话解释，而不是给个点了没反应的按钮
                  known === false
                    ? h('div', { className: 'wb-collab-anomaly', role: 'note' }, t('collabSessionGone'))
                    : null)
              }))),
        // ---- ③ 完成申请
        comp === null ? null : h('div', { className: 'wb-collab-section' },
          h('div', { className: 'wb-tertiary' }, t('aiAcceptance')),
          comp.status === 'pending'
            ? h('div', { className: 'wb-collab-pending', role: 'status' },
                h('strong', null, t('pendingAcceptance')),
                h('p', null, String(comp.summary ?? '')),
                comp.requestedAt ? h('div', { className: 'wb-tertiary' }, String(comp.requestedAt)) : null)
            : comp.status === 'accepted'
              ? h('div', { className: 'wb-collab-accepted' }, t('acceptedLabel'))
              : h('div', { className: 'wb-collab-rejected' }, t('rejectedLabel').replace('{feedback}', String(comp.feedback ?? '')))),
        // ---- ④ 处理记录（验收决策的痕迹）
        h('div', { className: 'wb-collab-section' },
          h('div', { className: 'wb-tertiary' }, t('aiExecutionLog')),
          log.length === 0
            ? h('div', { className: 'wb-muted' }, t('noSessions'))
            : h('ul', { className: 'wb-collab-log' }, log.slice(-5).map((e, i) => h('li', { key: i },
                h('span', { className: 'wb-tertiary' }, String(e.at ?? '')),
                ' · ',
                h('strong', null, `${e.progress ?? 0}%`),
                e.note ? ' · ' + String(e.note) : '',
                e.evidence ? h('span', { className: 'wb-tertiary' }, ' [', String(e.evidence), ']') : null)))),
        /**
         * ④ 人工验收入口：**唯一入口**，只在 pending 出现。
         *
         * 红线：AI 工具面（27 个）刻意不暴露 acceptCompletion，
         * 只有这里能点。任何重构都不能把这条路开给 Agent，
         * 否则「Agent 不得自行确认完成」就破了。
         */
        comp?.status === 'pending'
          ? h('div', { className: 'wb-collab-actions' },
              h('button', {
                className: 'wb-btn wb-btn-primary', type: 'button',
                disabled: saving, 'aria-label': t('acceptCompletion'),
                onClick: () => { if (typeof onAccept === 'function') onAccept() },
              }, t('acceptCompletion')),
              h('button', {
                className: 'wb-btn', type: 'button',
                disabled: saving, 'aria-label': t('rejectCompletion'),
                onClick: () => { if (typeof onReject === 'function') onReject() },
              }, t('rejectCompletion')))
          : null)
    }

    // --------------------------------------------------------------- 主页面
    function WorkbenchPage(props) {
      // UI 文案走 locale 服务
      const t = props.t ?? defaultT
      // **最终 Review BLOCKER 修复**：`main` 是 root-scope keyed slot，
      // `ctx.slots.inject('main', ...)` 的 inject 在真 renderer 里是**零参**
      // （dsh-client-ui-renderer:435-441，binding=void 0 时不 push 参数），
      // 所以不能靠 `props.sessionId`。
      // 真实来源（dsh-client-ui-workspace/lib/client.js:89）：
      //   ctx.sessions.list.getSnapshot().byId 中 retainedBy.mainView > 0 的行。
      const ctx = props.ctx
      const [currentSessionId, setCurrentSessionId] = useState(() => {
        try {
          const snap = ctx.sessions?.list?.getSnapshot?.()
          const row = snap?.byId
            ? Object.values(snap.byId).find((r) => (r?.retainedBy?.mainView ?? 0) > 0)
            : undefined
          return row?.id ?? props.sessionId ?? undefined
        } catch { return props.sessionId ?? undefined }
      })
      // 会话切换时跟随真实 store（订阅在 effect 内，返回清理）
      useEffect(() => {
        const list = ctx.sessions?.list
        if (typeof list?.subscribe !== 'function') return undefined
        const read = () => {
          try {
            const snap = list.getSnapshot?.()
            const row = snap?.byId
              ? Object.values(snap.byId).find((r) => (r?.retainedBy?.mainView ?? 0) > 0)
              : undefined
            if (row?.id !== undefined) setCurrentSessionId(row.id)
          } catch { /* 保留上一次已知会话 */ }
        }
        read()
        return list.subscribe(read)
      }, [ctx])
      const sessionId = currentSessionId
      const [tab, setTab] = useState('calendar')
      const [view, setView] = useState('month')
      const [taskFilter, setTaskFilter] = useState('today')
      const [events, setEvents] = useState([])
      const [tasks, setTasks] = useState([])
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState('')
      const [conflictCount, setConflictCount] = useState(0)
      /**
       * 提醒：只读计算结果。UI 只负责「显示」，不负责「投递」——
       * 投递是宿主 ctx.schedule 的职责（WP3 契约）。
       */
      const [reminders, setReminders] = useState([])
      /**
       * 导出进行中的类型（`'ics' | 'json' | null`）。
       *
       * 存在的意义：导出是异步的（要调 Host + 造 Blob），期间按钮必须禁用。
       * 不锁会让用户连点，生成多个同名下载文件。
       */
      const [exporting, setExporting] = useState(null)
      const [reminderSkipped, setReminderSkipped] = useState(0)
      /**
       * 拖拽状态。drag = 正在拖的东西；dropHint = 当前悬停的落点。
       *
       * 三个字段必须一起走：只记 id 就没法在落点上显示「会变成几点」，
       * 只记落点就没法判断「这是不是同一个事件」（原地拖回不该发请求）。
       */
      const [drag, setDrag] = useState(null)
      const [dropHint, setDropHint] = useState(null)
      // 拖拽浮层的真实指针位置。position:fixed 不给 top/left 就永远贴在角落，
      // 不会跟随指针 —— 那就不是「跟随提示」，是个挡视线的浮层。
      const [dragAt, setDragAt] = useState(null)
      /** 单次重复事件移动时，问「只改这一次 / 改整个系列」 */
      const [moveDialog, setMoveDialog] = useState(null)
      /** 撤销/重做可用性，由 history.status 提供 */
      const [history, setHistory] = useState({ canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 })
      /** 分组折叠：归档区默认收起 */
      const [showArchived, setShowArchived] = useState(false)
      /** 导入预览面板：null = 未打开 */
      const [importPanel, setImportPanel] = useState(null)
      const [search, setSearch] = useState('')
      const [cursor, setCursor] = useState(() => new Date())
      const [selected, setSelected] = useState(null)
      const [editing, setEditing] = useState(null)   // {kind:'event'|'task', data?}
      const [confirming, setConfirming] = useState(null) // {kind, id, label}
      const [saving, setSaving] = useState(false)
      const [approving, setApproving] = useState(false)
      /**
       * WP6-D · 智能规划面板状态。
       * planPanel: null（未打开）| 'input'（输入目标）| {proposal, stats}（有提案）
       */
      const [planPanel, setPlanPanel] = useState(null)
      /**
       * V1.2 · 备份面板：列表 / 手动备份 / 回滚。
       *
       * 回滚是**破坏性**操作，必须走审批（Host 侧 store.rollback 在
       * DANGEROUS_OPS 清单里）。这里不复制审批逻辑，只发请求。
       */
      const [backupPanel, setBackupPanel] = useState(false)
      const [backupList, setBackupList] = useState([])
      const [backupBusy, setBackupBusy] = useState(false)
      const loadBackups = async () => {
        try {
          const r = await request({ op: 'store.listBackups', payload: {} })
          if (r.ok !== true) throw new Error(r.error?.message ?? 'store.listBackups failed')
          setBackupList(Array.isArray(r.value) ? r.value : [])
        } catch (e) {
          setError(`${t('backupLoadFailed')}: ${String(e?.message ?? e)}`)
          setBackupList([])
        }
      }
      const makeBackup = async () => {
        setBackupBusy(true)
        try {
          const r = await request({ op: 'store.backup', payload: { label: 'manual' } })
          if (r.ok !== true) throw new Error(r.error?.message ?? 'store.backup failed')
          setNotice(t('backupCreated'))
          await loadBackups()
        } catch (e) {
          setError(`${t('backupCreateFailed')}: ${String(e?.message ?? e)}`)
        } finally { setBackupBusy(false) }
      }
      const rollbackTo = async (name) => {
        if (typeof name !== 'string' || name === '') return
        setBackupBusy(true)
        try {
          // 回滚是危险 op：先申请一次性审批，再带 token 执行
          const req = buildRollbackApprovalRequest(name)
          const token = await request(req)
          if (token.ok !== true) throw new Error(token.error?.message ?? 'approval failed')
          // approvalToken 必须在**顶层**（bridge 只从顶层读）
          const r = await request({ op: 'store.rollback', payload: { name }, approvalToken: token.value?.token ?? token.value })
          if (r.ok !== true) throw new Error(r.error?.message ?? 'store.rollback failed')
          setNotice(t('backupRolledBack'))
          setBackupPanel(false)
          await load(true)
        } catch (e) {
          setError(`${t('backupRollbackFailed')}: ${String(e?.message ?? e)}`)
        } finally { setBackupBusy(false) }
      }
      const [planGoal, setPlanGoal] = useState('')
      const [planWindow, setPlanWindow] = useState('week')
      const [planGenerating, setPlanGenerating] = useState(false)
      const searchRef = useRef(null)

      const request = useCallback(async (req) => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new Error('No active session; open the workbench from a conversation')
        }
        return callHost(ctx, sessionId, req)
      }, [ctx, sessionId])

      /**
       * `keepFeedback`：加载后**不要**覆盖已有的 error/notice。
       *
       * 原来 load 开头无条件 `setError(null)`、结尾无条件
       * `setNotice('Loaded from Host Service')` —— 于是所有「失败后 reload」
       * 的路径（拖拽改期、排序、恢复归档）都会把真实失败原因冲掉，
       * 所有「成功后 reload」的路径都会把「已移动到 X」冲成
       * 「Loaded from Host Service」。用户永远看不到自己那步的结果。
       */
      const load = useCallback(async (keepFeedback = false) => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          setError(t('noActiveSession'))
          return
        }
        setLoading(true)
        if (keepFeedback !== true) setError(null)
        try {
          const now = Date.now()
          const windowStart = new Date(now).setHours(0, 0, 0, 0)
          const windowEnd = windowStart + 7 * 24 * 3600 * 1000
          // 全部来自真实 Host Service（event.list / task.list / event.conflicts /
          // event.expand），无任何本地假数据。
          // 各命令**独立降级**：任一失败不应让整页变空白（其余数据仍可用）。
          const [ev, tk, cf, ex, rm, hs] = await Promise.all([
            request({ op: 'event.list', payload: { includeDeleted: false } }),
            request({ op: 'task.list', payload: {} }),
            request({ op: 'event.conflicts', payload: { windowStart, windowEnd } }),
            request({ op: 'event.expand', payload: { windowStart, windowEnd } }),
            // 提醒：只读计算（该提醒什么、什么时候提醒）。
            // 真实投递由宿主 ctx.schedule 负责，UI 只负责显示，不负责投递。
            request({ op: 'reminder.plan', payload: { nowMs: now, windowDays: 7 } }),
            // 撤销可用性：只读查询，失败就当作不可用（按钮置灰），不阻断整页
            request({ op: 'history.status', payload: {} }),
          ])
          // 主数据（事件/待办）失败才算整体失败；冲突与展开失败只降级为「无」。
          // 两条错误**合并成一条**，避免后一条覆盖前一条（第三轮 nit N3）。
          const problems = []
          if (ev.ok !== true) problems.push(`${t('calendar')}: ${ev.error?.message ?? t('loadFailed')}`)
          if (tk.ok !== true) problems.push(`${t('todos')}: ${tk.error?.message ?? t('loadFailed')}`)
          // 辅助命令失败也提示（第三轮 nit N4：原先完全静默）
          if (cf.ok !== true) problems.push(`${t('conflictCheck')}: ${cf.error?.message ?? t('unavailable')}`)
          if (ex.ok !== true) problems.push(`${t('expandCheck')}: ${ex.error?.message ?? t('unavailable')}`)
          if (rm.ok !== true) problems.push(`${t('reminder')}: ${rm.error?.message ?? t('unavailable')}`)
          if (hs.ok !== true) problems.push(`${t('undo')}: ${hs.error?.message ?? t('unavailable')}`)
          if (problems.length > 0) setError(problems.join('；'))
          const conflictIds = new Set(
            (cf.ok === true && Array.isArray(cf.value) ? cf.value : [])
              .flatMap((c) => [c.a?.eventId, c.b?.eventId, c.a?.id, c.b?.id, c.eventIdA, c.eventIdB])
              .filter((x) => typeof x === 'string'),
          )
          const recurrenceCount = new Map()
          for (const inst of (ex.ok === true && Array.isArray(ex.value) ? ex.value : [])) {
            const id = inst.eventId ?? inst.sourceId ?? inst.id
            if (typeof id === 'string') recurrenceCount.set(id, (recurrenceCount.get(id) ?? 0) + 1)
          }
          const nextEvents = (Array.isArray(ev.value) ? ev.value : []).map((e) => ({
            ...e,
            ...(conflictIds.has(e.id) ? { conflict: true } : {}),
            ...(recurrenceCount.has(e.id) ? { recurrenceOccurrences: recurrenceCount.get(e.id) } : {}),
          }))
          setEvents(nextEvents)
          const nextTasks = Array.isArray(tk.value) ? tk.value : []
          setTasks(nextTasks)
          /**
           * **选中项必须跟着数据刷新**（V1.2 缺陷修复）。
           *
           * `selected` 是渲染那一刻的**快照副本**，不是引用。刷新只更新 tasks、
           * 不重绑 selected，详情面板就会一直显示旧内容 —— 实测：
           * Agent 写入新的会话关联/进度后，列表已是最新，右侧面板仍是旧的，
           * 用户只能先点别处再点回来才看得到。这直接打掉了「可靠状态刷新」。
           *
           * 用 id 重新取一行即可；取不到说明它已被删，那就取消选中。
           */
          setSelected((prev) => {
            if (prev === null || prev.id === undefined) return prev
            // 任务与事件都要重绑：两类详情面板都会因为旧快照显示过期内容
            const pool = prev.kind === 'task' ? nextTasks : nextEvents
            const fresh = pool.find((r) => r.id === prev.id)
            if (fresh === undefined) return null
            return { kind: prev.kind, ...fresh }
          })
          /**
           * 提醒只保留「未来 7 天内、按触发时刻升序」的部分。
           * skipped 不静默丢弃——算不出提醒的条目单独计数，状态栏里如实显示。
           */
          const rmPlans = (rm.ok === true && Array.isArray(rm.value?.plans) ? rm.value.plans : [])
            .filter((p2) => Number.isFinite(p2?.fireAtMs))
            .sort((a, b) => a.fireAtMs - b.fireAtMs)
          setReminders(rmPlans)
          setReminderSkipped(
            rm.ok === true && Array.isArray(rm.value?.skipped) ? rm.value.skipped.length : 0,
          )
          setHistory(hs.ok === true && hs.value !== null && typeof hs.value === 'object'
            ? {
                canUndo: hs.value.canUndo === true,
                canRedo: hs.value.canRedo === true,
                undoDepth: Number.isFinite(hs.value.undoDepth) ? hs.value.undoDepth : 0,
                redoDepth: Number.isFinite(hs.value.redoDepth) ? hs.value.redoDepth : 0,
              }
            : { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 })
          setConflictCount(conflictIds.size)
          if (keepFeedback !== true) setNotice(t('loadedFromHost'))
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setLoading(false)
        }
      }, [request, sessionId])

      useEffect(() => { load() }, [load])

      /**
       * V1.1 §2.5 · 实时刷新。
       *
       * 问题：Agent 在**自己的会话**里写进度/申请验收，数据落在 Host 的
       * 共享 assignment 上；本页面已经渲染完，不重新 load 就永远看不到。
       * 用户视角就是「Agent 说做完了，界面上什么也没有」。
       *
       * 设计取舍：
       *   - 轮询而非事件订阅 —— 插件层没有跨会话数据变更事件契约，
       *     自造订阅等于假装有推送。
       *   - 8 秒间隔 —— 这是本地面板，不是高频交易；更密的轮询在
       *     「有 6 个命令并发」的 load 下会明显增加无谓 IO。
       *   - **编辑中/保存中/有弹窗时不刷新** —— 否则用户正在填的表单
       *     会被一次后台 load 覆盖（tasks 状态重建会让 selected 指向旧对象）。
       *     这条是硬约束，不是优化。
       *   - 页面不可见时跳过 —— 后台标签页刷新没有意义，还费电。
       */
      useEffect(() => {
        const id = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          // 弹窗/编辑/保存期间不打扰用户
          if (editing !== null || saving === true || confirming !== null || planPanel !== null) return
          if (loading === true) return
          load(true)
        }, 8000)
        return () => clearInterval(id)
      }, [load, editing, saving, confirming, planPanel, loading])

      /**
       * 快捷键要拿到**最新**的 undo/redo，而 keydown 的 effect 依赖数组是空的
       * （只在挂载时注册一次，避免每次渲染重绑）。用 ref 转发即可：
       * 注册一次，永远调到当前那个函数。
       */
      const undoRef = useRef(null)
      /**
       * 拖拽期间跟踪指针。HTML5 drag 的 drag 事件里 clientX/clientY 恒为 0，
       * 必须用 mousemove。只在 drag 进行时挂监听，避免常态开销。
       */
      useEffect(() => {
        if (drag === null) { setDragAt(null); return }
        const onMove = (ev) => setDragAt({ x: ev.clientX, y: ev.clientY })
        window.addEventListener('mousemove', onMove)
        return () => window.removeEventListener('mousemove', onMove)
      }, [drag])
      const redoRef = useRef(null)
      const importInputRef = useRef(null)
      const nudgeRef = useRef(null)

      // Ctrl/Cmd+K 聚焦搜索；Ctrl/Cmd+Z 撤销；Ctrl/Cmd+Shift+Z 重做
      useEffect(() => {
        const onKey = (ev) => {
          const mod = ev.ctrlKey || ev.metaKey
          const k = ev.key.toLowerCase()
          /**
           * 裸 ←/→ = 事件改期。**必须放在 mod 守卫之前**。
           *
           * 原实现把箭头分支写在 `if (!mod) return` 之后，于是裸箭头永远
           * 到不了这段代码 —— 实测纯 ArrowRight 触发 0 次，必须按住
           * Ctrl/Cmd 才有反应，而界面上没有任何地方提示这个组合键。
           * 这条路径本身就是用来替代拖拽的，不可达等于没做。
           */
          if (!mod && (k === 'arrowleft' || k === 'arrowright')) {
            const el = ev.target
            const typing = el !== null && el !== undefined
              && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true)
            if (typing) return
            if (nudgeRef.current === null) return
            ev.preventDefault()
            nudgeRef.current(k === 'arrowright' ? 1 : -1)
            return
          }
          if (!mod) return
          if (k === 'k') {
            ev.preventDefault()
            searchRef.current?.focus()
            return
          }
          // 在输入框里打字时不要抢撤销键：那是浏览器/输入法的文本撤销
          const el = ev.target
          const typing = el !== null && el !== undefined
            && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true)
          if (typing) return
          if (k === 'z') {
            ev.preventDefault()
            if (ev.shiftKey) redoRef.current?.()
            else undoRef.current?.()
            return
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      const filteredEvents = useMemo(() => {
        const q = search.trim().toLowerCase()
        return events.filter((e) => q === '' || String(e.title ?? '').toLowerCase().includes(q))
      }, [events, search])

      const filteredTasks = useMemo(
        () => filterTasksForView(tasks, { search, taskFilter, now: new Date() }),
        [tasks, search, taskFilter],
      )

      /**
       * 分组。排序只认组内，跨组不动——跨组意味着改 project，
       * 那是「移动」不是「排序」，语义不同不能混在一个手势里。
       *
       * 组内按 order 排（Host task.reorder 写的就是这个字段）；
       * 没有 order 的排在后面，保持稳定，避免「拖一下就全组重排」。
       */
      const groupedTasks = useMemo(() => {
        const groups = new Map()
        for (const task of filteredTasks) {
          const key = task.project ?? null
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(task)
        }
        const rows = []
        for (const [project, list] of groups) {
          const ordered = [...list].sort(byOrder)
          rows.push({ project, rows: ordered })
        }
        // 有分组的排前面，未分组垫底
        return rows.sort((a, b) => {
          if (a.project === null && b.project !== null) return 1
          if (b.project === null && a.project !== null) return -1
          return String(a.project ?? '').localeCompare(String(b.project ?? ''))
        })
      }, [filteredTasks])

      /** 已归档的待办单独一区：它们仍在库里、仍可被 AI 读到，只是收起来了。 */
      const archivedTasks = useMemo(() => {
        const q = search.trim().toLowerCase()
        return tasks.filter((task) => {
          if (task?.archived !== true) return false
          // deleted 优先：归档后又删掉的，不再显示在归档区
          if (isSoftDeleted(task)) return false
          return q === '' || String(task.title ?? '').toLowerCase().includes(q)
        })
      }, [tasks, search])

      /** 键盘替代操作：把某条在组内上/下挪一位，走和拖拽同一条 reorder 路径。 */
      const nudgeTask = async (groupId, id, delta) => {
        // 与渲染、reorderTasks 共用同一个比较器，避免索引基漂移
        const rows = tasks
          .filter((task) => (task.project ?? null) === groupId && task.archived !== true)
          .sort(byOrder)
        const i = rows.findIndex((task) => task.id === id)
        const j = i + delta
        if (i < 0 || j < 0 || j >= rows.length) return
        await reorderTasks(groupId, id, rows[j].id)
      }

      const todayEvents = useMemo(() => {
        const now = new Date()
        return [...filteredEvents]
          .filter((e) => { const d = eventDay(e); return d !== null && d >= startOfDay(now) && d < addDays(startOfDay(now), 8) })
          .sort((a, b) => (eventDay(a)?.getTime() ?? 0) - (eventDay(b)?.getTime() ?? 0))
      }, [filteredEvents])

      const weekEvents = useMemo(() => {
        const s = startOfDay(cursor)
        // 周视图：以 cursor 所在周（周一起）为范围
        const monday = addDays(s, -((s.getDay() + 6) % 7))
        return filteredEvents.filter((e) => {
          const d = eventDay(e)
          return d !== null && d >= monday && d < addDays(monday, 7)
        })
      }, [filteredEvents, cursor])

      const dayEvents = useMemo(() => filteredEvents.filter((e) => {
        const d = eventDay(e)
        return d !== null && sameDay(d, cursor)
      }), [filteredEvents, cursor])

      /**
       * 拖拽改期。
       *
       * 三个必须做对的地方：
       * 1. **冲突不写盘**：Host 侧 event.move 会先算候选再落盘，冲突时抛
       *    conflictError。这里不发「乐观更新」——列表只在成功后 reload，
       *    失败时界面保持原样，这就是「保存失败恢复原位」的实现方式。
       * 2. **重复事件必须问**：只改这一次（EXDATE + 独立事件）还是改整个系列，
       *    是两种完全不同的数据后果，不能替用户猜。
       * 3. **时区不丢**：定时事件移动只改墙钟时刻，timeZone 原样带过去。
       */
      const moveEventToDate = async (target, dateKey, modeChoice) => {
        if (target === null || target.kind !== 'event') return
        setError(null)
        const source = events.find((e) => e.id === target.id)
        if (source === undefined) { setError(t('eventGone')); return }
        const recurring = source.recurrence !== null && source.recurrence !== undefined
        // 重复事件第一次拖：先问范围，不擅自决定
        if (recurring && modeChoice === undefined) {
          /**
           * 把**源日**一并存进弹窗状态。onChoose 里必须用它，不能用 dateKey
           * （dateKey 是落点）。源日优先取调用方传入的 occurrenceDate（拖拽时
           * 记的是被拖实例的真实日期），否则退回母体自身日期。
           */
          const srcDay = target.occurrenceDate
            ?? (() => { const d = eventDay(source); return d === null ? null : isoDate(d) })()
          setMoveDialog({ id: target.id, title: source.title, dateKey, allDay: source.allDay === true,
            occurrenceDate: srcDay })
          return
        }
        const mode = recurring ? (modeChoice ?? 'series') : 'series'
        setSaving(true)
        try {
          /**
           * 走构造器，不内联拼 body。
           *
           * 内联版本里 `mode` 是本地算的，`occurrenceDate` 也是本地拼的 ——
           * 和构造器两份真相，改一处不改另一处就漂。B3 的修复一度只存在于
           * 构造器里（没人调用），等于没修。
           */
          const body = buildEventMoveRequest(
            { id: target.id, recurring, occurrenceDate: target.occurrenceDate, allDay: source.allDay === true, start: source.start },
            dateKey,
            modeChoice,
          )
          // 非全天事件要把时分带上（构造器只负责日期与范围语义）
          if (source.allDay !== true) body.target = { start: `${dateKey}T${fmtTime(source.start) || '09:00'}` }
          const r = await request({ op: 'event.move', payload: body })
          if (r.ok !== true) throw new Error(r.error?.message ?? 'event.move failed')
          setNotice(t('moved') + ' ' + dateKey + (mode === 'single' ? ' ' + t('onlyThisOne') : ''))
          await load(true)
        } catch (e) {
          // 失败不动界面：events 仍是 load 出来的旧值，等于「恢复原位」
          setError(String(e?.message ?? e))
          await load(true)
        } finally {
          setSaving(false)
        }
      }

      /**
       * 事件改期的**键盘替代**。
       *
       * 拖拽是 HTML5 draggable，键盘和读屏用户根本用不了。
       * 只提供拖拽 = 把一部分用户挡在门外，所以这里给选中事件一个
       * ←/→ 前后挪一天的操作，走的是同一条 moveEventToDate 路径。
       * 日期用本地日计算，避免 UTC 跨日把「挪一天」变成「挪两天」。
       */
      const nudgeEventDay = (delta) => {
        const sel = selected
        if (sel === null || sel.kind !== 'event') return
        const src = events.find((e) => e.id === sel.id)
        if (src === undefined) return
        // 复用模块级的 eventDay/isoDate，别再造一套日期解析（两套逻辑迟早分叉）
        const day = eventDay(src)
        if (day === null) return
        const baseKey = isoDate(day)
        const nextKey = isoDate(addDays(day, delta))
        const recurring = src.recurrence !== null && src.recurrence !== undefined
        moveEventToDate(
          { kind: 'event', id: sel.id, occurrenceDate: baseKey },
          nextKey,
          recurring ? undefined : 'series',
        )
      }

      /**
       * 待办拖拽排序。
       *
       * Host 的 task.reorder 要**完整的目标顺序**（幂等），所以这里算出
       * 整组的新顺序再发。只发「挪到某条前面」会让并发写入互相覆盖。
       */
      const reorderTasks = async (groupId, fromId, toId) => {
        if (fromId === toId) return
        /**
         * 必须**先按 order 排序**再算索引 —— 用户看到的顺序是 order 序，
         * 而 tasks 数组是存储序。两个基不一致时拼出的 ids 不是用户意图。
         */
        const groupRows = tasks
          .filter((task) => (task.project ?? null) === groupId && task.archived !== true)
          .sort(byOrder)
        const from = groupRows.findIndex((task) => task.id === fromId)
        const to = groupRows.findIndex((task) => task.id === toId)
        if (from < 0 || to < 0) return
        const next = [...groupRows]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        setError(null)
        setSaving(true)
        try {
          const r = await request(buildReorderRequest(next, groupId))
          if (r.ok !== true) throw new Error(r.error?.message ?? 'task.reorder failed')
          setNotice(t('orderSaved'))
          await load(true)
        } catch (e) { setError(String(e?.message ?? e)); await load(true) }
        finally { setSaving(false) }
      }

      /** 归档 / 恢复。归档不是删除，不需要审批；恢复更不需要。 */
      const setArchived = async (id, archived) => {
        setError(null)
        setSaving(true)
        try {
          /**
           * 恢复**不能**调 'task.unarchive' —— 那不是 handler，只是
           * task.archive 内部 audit 的 action 标签（service.js:902/909）。
           * 实测 svc.execute('task.unarchive') → unsupported: 不支持的操作。
           * 正确契约是同一个 op 带 archived:false。
           */
          const r = await request(buildArchiveRequest(id, archived))
          if (r.ok !== true) throw new Error(r.error?.message ?? 'archive failed')
          setNotice(archived ? t('archived') : t('restored'))
          await load(true)
        } catch (e) { setError(String(e?.message ?? e)) }
        finally { setSaving(false) }
      }

      /** 撤销 / 重做。失败必须说出来——静默失败会让人以为操作生效了。 */
      const undo = async () => {
        setError(null)
        try {
          const r = await request({ op: 'history.undo', payload: {} })
          if (r.ok !== true) throw new Error(r.error?.message ?? 'undo failed')
          setNotice(t('undoDone'))
          await load(true)
        } catch (e) { setError(String(e?.message ?? e)) }
      }
      const redo = async () => {
        setError(null)
        try {
          const r = await request({ op: 'history.redo', payload: {} })
          if (r.ok !== true) throw new Error(r.error?.message ?? 'redo failed')
          setNotice(t('redoDone'))
          await load(true)
        } catch (e) { setError(String(e?.message ?? e)) }
      }

      // 每次渲染把最新的 undo/redo 挂进 ref，供空依赖的 keydown effect 调用
      undoRef.current = undo
      redoRef.current = redo
      nudgeRef.current = nudgeEventDay

      /**
       * 导入：预览 → 用户确认 → **真 Host 审批** → 执行。
       *
       * 为什么执行必须走审批：`event.import` 在 DANGEROUS_OPS 里，是覆盖性写入。
       * 模型只能预览、只能告诉用户要导入什么，不能自己按下导入。
       * 这里的 token 由宿主在用户点击「确认导入」后签发，绑定 (op,target,digest)。
       */
      const startImport = async (kind, text) => {
        setError(null)
        setSaving(true)
        try {
          const op = kind === 'ics' ? 'event.previewIcs' : 'snapshot.preview'
          const r = await request({ op, payload: { text } })
          if (r.ok !== true) throw new Error(r.error?.message ?? (op + ' failed'))
          const v = r.value ?? {}
          // 统一成面板要的形状：ICS 预览给的是 plan 数组，JSON 预览给的是计数
          if (kind === 'ics') {
            /**
             * 计数一律用服务端给的 `counts`，**不本地重算**。
             *
             * 原来自己 plan.filter 算 create/duplicate/conflict，还把
             * unsupported 硬写成 0 —— 实测服务端返回
             * {create:2, unsupported:1}，面板却显示「不支持 0 条」，
             * 而下面列表里明明有 1 条 VTODO。自相矛盾，且丢掉了 degraded/skip。
             * 重复/冲突的判定权在服务端，客户端重算就是第二份真相源。
             */
            setImportPanel({
              kind, text,
              counts: buildIcsCounts(v.counts),
              unsupported: Array.isArray(v.unsupported) ? v.unsupported : [],
              warnings: Array.isArray(v.warnings) ? v.warnings : [],
            })
          } else {
            setImportPanel({
              kind, text,
              counts: v.counts ?? {},
              unsupported: Array.isArray(v.unsupported) ? v.unsupported : [],
              warnings: Array.isArray(v.warnings) ? v.warnings : [],
              removedEvents: v.removedEvents ?? [],
              removedTasks: v.removedTasks ?? [],
            })
          }
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setSaving(false)
        }
      }

      /**
       * 导出（WP5.1 · P2）。
       *
       * 服务端 `event.exportIcs` / `snapshot.export` 一直可用，但界面上
       * 从来没有入口 —— 用户只能导入不能导出。这里补齐，并走**真实下载**：
       * Blob + `URL.createObjectURL` + 临时 `<a download>`，不是把文本塞进面板。
       *
       * 文件名带日期（`workbench-2026-11-07.ics`）：导出是「拿走一份」的语义，
       * 没有日期的文件名在多次导出后无法区分。
       */
      const exportData = async (kind) => {
        if (exporting !== null) return
        setExporting(kind)
        setError(null)
        setNotice(null)
        try {
          const op = kind === 'ics' ? 'event.exportIcs' : 'snapshot.export'
          const r = await request({ op, payload: {} })
          if (r.ok !== true) throw new Error(r.error?.message ?? (op + ' failed'))
          const v = r.value ?? {}
          const text = typeof v === 'string' ? v : (v.text ?? '')
          if (typeof text !== 'string' || text === '') {
            throw new Error(t('exportEmpty'))
          }
          const stamp = isoDate(new Date())
          const filename = kind === 'ics'
            ? `workbench-${stamp}.ics`
            : `workbench-${stamp}.json`
          const mime = kind === 'ics' ? 'text/calendar;charset=utf-8' : 'application/json;charset=utf-8'
          const blob = new Blob([text], { type: mime })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = filename
          /**
           * 必须挂进文档再 click：部分浏览器对游离节点的 click 不触发下载。
           *
           * 挂到 `documentElement` 而不是 `body` —— 项目规范明确禁止写
           * `document.body`（`workbench-ui-standards.test.mjs`：
           * "不得写 document.body"），把它当成布局根节点之外的公共写入点。
           * 用 documentElement 效果相同，且不碰 body 的内容边界。
           */
          document.documentElement.appendChild(a)
          a.click()
          document.documentElement.removeChild(a)
          // 立刻 revoke 会让 Safari 拿不到内容，延后一拍
          setTimeout(() => URL.revokeObjectURL(url), 1000)
          setNotice(t('exportDone').replace('{file}', filename))
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setExporting(null)
        }
      }

      /** 用户在预览面板点了「确认导入」→ 申请宿主签发的用户确认凭证 → 执行。 */
      const confirmImport = async (panel) => {
        if (panel === null) return
        setApproving(true)
        setError(null)
        try {
          const op = panel.kind === 'ics' ? 'event.import' : 'snapshot.replace'
          // digest 必须和 Host 侧算的一致：Host 用 contentDigest(text)，
          // 这里传原文，由 Host 自己算，避免两边算法不一致导致 fingerprint-mismatch
          /**
           * 必须把**原文**带上，Host 才能按内容算摘要。
           *
           * 原实现只传 target: panel.kind（'ics'/'json'），而 Host 校验时
           * 不传 target、digest 由 contentDigest(text) 算 —— 两侧指纹对不上，
           * 凭证签发成功但执行必然 fingerprint-mismatch。实测：点「确认导入」
           * 只会看到审批失败，导入功能整体不可用。
           *
           * 内容类操作的 target 恒为 undefined（与 service 侧写死的契约一致），
           * 摘要一律由 text 推导。
           */
          const approval = await request(buildImportApprovalRequest(
            panel.kind,
            panel.text,
            t('importSummary').replace('{kind}', panel.kind.toUpperCase()),
          ))
          if (approval.ok !== true) throw new Error(approval.error?.message ?? t('approvalNotGranted'))
          const token = approval.value?.token
          if (typeof token !== 'string' || token === '') throw new Error(t('approvalNotGranted'))
          /**
           * approvalToken 必须在**顶层**，不能塞进 payload。
           *
           * bridge 只从顶层解构（index.js:130 `const { op, payload, scope,
           * approvalToken } = parsed.req`），放进 payload 等于没带 ——
           * 执行侧报 missing-token。对照：deleteWithApproval 就是放顶层，
           * 所以删除能用、导入不能用。
           */
          const r = await request(buildImportExecuteRequest(panel.kind, panel.text, token))
          if (r.ok !== true) throw new Error(r.error?.message ?? (op + ' failed'))
          setImportPanel(null)
          /**
           * **导入结果必须报出「跳过」条数**（WP5.1 · P1-5）。
           *
           * `event.import` 现在会按 UID 幂等跳过已存在的事件，但 UI 原来只会说
           * 「导入完成」。用户导入 10 条、实际只进 5 条时，看到的仍是「导入完成」——
           * 这是静默吞掉，与「报告说成功、实际没做」同类。
           */
          const importedN = Number(r.value?.imported ?? 0)
          const skippedN = Number(r.value?.skipped ?? 0)
          setNotice(skippedN > 0
            ? t('importDoneSkipped').replace('{n}', String(importedN)).replace('{s}', String(skippedN))
            : t('importDone').replace('{n}', String(importedN)))
          await load(true)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setApproving(false)
        }
      }


      /**
       * WP6-D · 生成智能规划提案（只读业务数据，只建 pending 提案）。
       *
       * 时间窗由用户在 UI 选「今日 / 本周」，毫秒值在这里算，
       * 传给 plan.suggest 复用真实 freeSlots/conflicts。
       */
      const generatePlan = async () => {
        const goal = String(planGoal ?? '').trim()
        if (goal === '') return
        setPlanGenerating(true)
        setError(null)
        try {
          const now = new Date()
          const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
          const end = planWindow === 'today'
            ? start + 86400000
            : start + 7 * 86400000
          const r = await request({
            op: 'plan.suggest',
            payload: {
              goal,
              windowStart: start,
              windowEnd: end,
              targetTitles: goal.split(/[\n、,，;；]/).map((s) => s.trim()).filter(Boolean).slice(0, 10),
              capacityMinutesPerDay: 480,
            },
          })
          if (r.ok !== true) throw new Error(r.error?.message ?? 'plan.suggest failed')
          const v = r.value ?? {}
          setPlanPanel({ proposal: v.proposal, stats: v.stats ?? {} })
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setPlanGenerating(false)
        }
      }

      /**
       * WP6-D · 用户确认提案。
       *
       * 红线：必须向 Host 申请一次性审批 token，再带 token 调 proposal.apply；
       * **绝不**用 payload.confirmed 或本地布尔绕过审批。
       * proposal.apply 是实体类 op（绑 target=id），审批请求不能带 text，
       * 否则 Host 按内容类算 digest 会 fingerprint-mismatch（WP5 实测坑）。
       */
      const confirmPlan = async () => {
        if (planPanel === null || planPanel === 'input') return
        const id = planPanel.proposal?.id
        if (typeof id !== 'string' || id === '') return
        setApproving(true)
        setError(null)
        try {
          const approval = await request(buildPlanApprovalRequest(id, t('confirmPlan')))
          if (approval.ok !== true || approval.value?.approved !== true) {
            throw new Error(t('loadFailed'))
          }
          const r = await request(buildPlanApplyRequest(id, approval.value.token))
          if (r.ok !== true) throw new Error(r.error?.message ?? 'proposal.apply failed')
          const n = Number(r.value?.created ?? 0)
          setNotice(t('planApplied').replace('{n}', String(n)))
          setPlanPanel(null)
          await load(true)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setApproving(false)
        }
      }

      /** 用户拒绝提案：零业务数据变化。 */
      const rejectPlan = async () => {
        if (planPanel === null || planPanel === 'input') return
        const id = planPanel.proposal?.id
        if (typeof id !== 'string' || id === '') return
        try {
          const r = await request({ op: 'proposal.reject', payload: { id } })
          if (r.ok !== true) throw new Error(r.error?.message ?? 'proposal.reject failed')
          setNotice(t('planRejected'))
          setPlanPanel(null)
        } catch (e) {
          setError(String(e?.message ?? e))
        }
      }


      /**
       * V1.2 · 从任务跳到真实 DSH 会话。
       *
       * ## 为什么这次能真做（以及为什么之前的结论是错的）
       *
       * V1.1 的注释写着「插件层没有会话跳转契约」，据此只做了「复制 sessionId」。
       * 那个结论来自只看 `dsh-client-ui-session`：它确实只暴露
       * bindingSource / whenAccess / provide。**但真正负责 GUI 切换的不是它。**
       *
       * 一手核实（解包 app.asar 读源码）：
       *   - `dsh-client-ui-workspace` 的 `UiWorkspaceService` 用
       *     `super(ctx, "uiWorkspace")` 把服务注册进 ctx；
       *   - 它的公开方法 `openSession(target)` → `replaceMain(...)` →
       *     `sessions.retain(target, { source: "mainView" })`
       *     + 更新选中 + `layout.selectPanel(null)`；
       *   - 插件模板自己就在用 `ctx.get("sessions")` 这类服务（我们的
       *     WorkbenchPage 已经在读 `ctx.sessions.list`）。
       *
       * 所以 `ctx.get('uiWorkspace')?.openSession(sessionId)` 是**真实契约**，
       * 不是自造接口。拿不到服务时明确报错，不做假按钮。
       */
      const openSessionById = (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        try {
          const svc = typeof ctx?.get === 'function' ? ctx.get('uiWorkspace') : undefined
          if (svc === undefined || svc === null || typeof svc.openSession !== 'function') {
            setError(t('collabOpenUnavailable'))
            return
          }
          svc.openSession(sessionId)
          setNotice(t('collabOpened'))
        } catch (e) {
          setError(`${t('collabOpenFailed')}: ${String(e?.message ?? e)}`)
        }
      }

      /**
       * 该 sessionId 是否还在当前窗口的会话列表里。
       *
       * `openSession` 只能切到**已存在**的会话：被删掉的、或属于本窗口未加载
       * 工作区的会话，调用后不会报错但也不会切过去 —— 用户会以为按钮坏了。
       * 所以先判定，把「会话已丢失」当成显式状态展示。
       *
       * 返回 null 表示「无法判定」（拿不到列表），此时不拦截，让用户去试。
       */
      const isKnownSession = (sessionId) => {
        try {
          const snap = ctx?.sessions?.list?.getSnapshot?.()
          const byId = snap?.byId
          if (byId === null || byId === undefined || typeof byId !== 'object') return null
          return Object.prototype.hasOwnProperty.call(byId, sessionId)
        } catch { return null }
      }

      /**
       * V1.1 §2.1 · 复制会话标识（保留）。
       *
       * 复制仍然是必要的补充：会话不在当前窗口时打不开，但 sessionId
       * 仍然可以用来在别处定位它。两个动作并存，各自诚实。
       */
      const [copyState, setCopyState] = useState({ busy: false, done: null })
      const copySessionId = async (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        setCopyState({ busy: true, done: null })
        try {
          /**
           * 只用 navigator.clipboard，**不退回 document.body + textarea**。
           *
           * WP4 硬约束「不得写 document.body」不是洁癖：插件运行在宿主
           * 的 renderer 里，往 body 里塞临时节点会和宿主的 DOM 管理冲突
           * （实测过的形态是节点残留、焦点被抢）。而 clipboard 不可用时
           * 静默失败同样不可接受。
           *
           * 所以不可用就**明确告诉用户**该手动复制 —— 会话标识一直明文
           * 显示在面板上，用户可以直接选中。诚实的降级优于偷偷改 DOM。
           */
          if (navigator?.clipboard?.writeText === undefined) {
            throw new Error(t('collabCopyUnavailable'))
          }
          await navigator.clipboard.writeText(sessionId)
          setCopyState({ busy: false, done: sessionId })
          setNotice(t('collabCopied'))
        } catch (e) {
          setCopyState({ busy: false, done: null })
          // 明确报错，不静默：用户点复制没反应比报错更让人困惑
          setError(`${t('collabCopyFailed')}: ${String(e?.message ?? e)}`)
        }
      }

      /**
       * WP6-D · 用户人工验收（通过 / 驳回）。
       * 只有用户点这两个按钮才会调用；AI 工具面完全没有这两个 op。
       */
      const decideCompletion = async (decision, feedback = '') => {
        if (selected === null || selected.kind !== 'task') return
        const op = decision === 'accept' ? 'task.acceptCompletion' : 'task.rejectCompletion'
        setSaving(true)
        setError(null)
        try {
          const r = await request({
            op,
            payload: decision === 'accept'
              ? { id: selected.id }
              : { id: selected.id, feedback },
          })
          if (r.ok !== true) throw new Error(r.error?.message ?? (op + ' failed'))
          await load(true)
          setSelected(null)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setSaving(false)
        }
      }

      const saveEvent = async (payload) => {
        setSaving(true)
        setError(null)
        try {
          const op = payload.id !== undefined ? 'event.update' : 'event.create'
          const body = payload.id !== undefined
            ? { id: payload.id, patch: { title: payload.title, description: payload.description, allDay: payload.allDay, ...(payload.allDay ? { startDate: payload.startDate } : { start: payload.start, timeZone: payload.timeZone }) } }
            : payload
          const r = await request({ op, payload: body })
          if (r.ok !== true) throw new Error(r.error?.message ?? `${op} failed`)
          setEditing(null)
          setNotice(op === 'event.create' ? t('eventCreated') : t('eventUpdated'))
          await load(true)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setSaving(false)
        }
      }

      const saveTask = async (task) => {
        setSaving(true)
        setError(null)
        try {
          const r = await request({ op: 'task.upsert', payload: { task } })
          if (r.ok !== true) throw new Error(r.error?.message ?? 'task.upsert failed')
          setEditing(null)
          setNotice(t('taskSaved'))
          await load(true)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setSaving(false)
        }
      }

      const toggleTask = async (task) => {
        setError(null)
        try {
          const r = await request({ op: 'task.upsert', payload: { task: { ...task, done: task.done !== true } } })
          if (r.ok !== true) throw new Error(r.error?.message ?? 'task.upsert failed')
          setNotice(task.done === true ? t('taskReopened') : t('taskCompleted'))
          await load(true)
        } catch (e) { setError(String(e?.message ?? e)) }
      }

      /**
       * 删除走**真 Host 审批**：先 askApproval 拿 token，再带 token 调 delete。
       * 绝不传 confirmed:true 布尔（WP2/WP3 已修掉的旁路）。
       */
      const deleteWithApproval = async (kind, id) => {
        setApproving(true)
        setError(null)
        try {
          // **最终 Review BLOCKER 修复**：service.listOps() 没有 task.delete
          // （只有 task.list/task.upsert）。待办删除改为 task.upsert 打软删
          // 标记（业务层整行替换但保留任意字段），并用 event.delete 的真实
          // 审批指纹；不臆造未实现的 op。
          // **审批指纹必须与实际操作一致**：审批凭证按 (op,target,digest) 绑定，
          // 用错 op 会得到 fingerprint-mismatch。
          //  - 日程删除 → op = event.delete
          //  - 待办软删 → op = task.upsert（真实在 DANGEROUS_OPS 里，且软删确实走它）
          const op = kind === 'task' ? 'task.upsert' : 'event.delete'
          /**
           * **先算出最终要写的 task，再凭它签发凭证**（复审 F1）。
           *
           * 凭证指纹现在绑 `taskUpsertContentDigest(task)`，签发端算的是
           * 「用户确认时看到的那份内容」，执行端算的是「实际提交的那份」。
           * 所以 `deletedAt` 必须在这里生成**一次**并复用：若签发前后各取
           * 一次 `new Date()`，两侧摘要必然不同 → 凭证当场失效。
           */
          const taskPayload = kind === 'task'
            ? { ...(tasks.find((x) => x.id === id) ?? { id }), deleted: true, deletedAt: new Date().toISOString() }
            : undefined
          // summary 会进宿主审批弹窗，必须是用户看得懂的中文，不能拼英文
          const detail = { target: id, summary: t('deleteSummary').replace('{kind}', kind === 'task' ? t('kindTask') : t('kindEvent')) }
          /**
           * 用户已在确认对话框点了「删除」→ 该动作本身就是授权。
           * 凭证由**宿主**签发（绑定 op+target+digest、一次性、不可伪造）。
           *
           * 为什么不用 ctx.approval.request：DSH 的审批只能在**模型回合内**发起
           * （dsh-user-approval/README.md:153），而 UI 删除是回合外的用户操作，
           * 走那条路在真实浏览器里必然拿不到 token（第四轮 Review 的 BLOCKER-4）。
           */
          const approval = await request({
            op: 'confirmUserAction',
            payload: {
              approvalOp: op,
              ...detail,
              ...(taskPayload !== undefined ? { task: taskPayload } : {}),
            },
          })
          if (approval.ok !== true) {
            throw new Error(approval.error?.message ?? t('approvalNotGranted'))
          }
          const token = approval.value?.token
          if (typeof token !== 'string' || token === '') {
            throw new Error(approval?.error?.message ?? t('approvalNotGranted'))
          }
          let r
          if (kind === 'task') {
            // 复用签发时那一份：`deletedAt` 必须同值，否则摘要对不上（见上）
            r = await request({
              op: 'task.upsert',
              payload: { task: taskPayload },
              approvalToken: token,
            })
          } else {
            r = await request({ op: 'event.delete', payload: { id }, approvalToken: token })
          }
          if (r.ok !== true) throw new Error(r.error?.message ?? `delete failed`)
          setConfirming(null)
          setSelected(null)
          setNotice(t('deletedAfterApproval'))
          await load(true)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setApproving(false)
        }
      }

      const openNew = () => setEditing({ kind: tab === 'calendar' ? 'event' : 'task' })

      return h('div', { className: 'wb-root wb-scroll' },
        h('style', null, CSS),
        h('div', { className: 'wb-top' },
          h('h1', { className: 'wb-title' }, t('panel')),
          h(ViewTabs, {
            value: tab,
            onChange: (v) => { setTab(v); setSelected(null); setEditing(null) },
            options: [{ id: 'calendar', label: t('calendar') }, { id: 'tasks', label: t('todos') }],
            t,
          }),
          h('div', { className: 'wb-spacer' }),
          h('input', {
            ref: searchRef, className: 'wb-input wb-search', type: 'search',
            placeholder: 'Search (Ctrl/Cmd+K)', 'aria-label': t('search'),
            value: search, onChange: (e) => setSearch(e.target.value),
          }),
          // 直接把 load 当 onClick 会把 click 事件当成 keepFeedback 传进去（truthy），
          // 于是「刷新」永远不清旧提示。必须显式包一层。
          h('button', { className: 'wb-btn', type: 'button', onClick: () => load(), 'aria-label': t('refresh') }, t('refresh')),
          // 导入入口：选文件 → 预览 → 确认 → 走 Host 审批执行
          h('button', {
            className: 'wb-btn', type: 'button', 'aria-label': t('importData'),
            title: t('importHint'),
            onClick: () => importInputRef.current?.click(),
          }, t('import')),
          h('input', {
            ref: importInputRef, type: 'file', accept: '.json,.ics,application/json,text/calendar',
            style: { display: 'none' }, 'aria-hidden': 'true', tabIndex: -1,
            onChange: async (ev) => {
              const file = ev.target.files?.[0]
              ev.target.value = ''   // 允许连续选同一个文件
              if (file === undefined) return
              const text = await file.text()
              const kind = file.name.toLowerCase().endsWith('.ics') ? 'ics' : 'json'
              await startImport(kind, text)
            },
          }),
          // 导出入口（WP5.1 · P2）：服务端 `event.exportIcs` / `snapshot.export`
          // 一直是可用的，但界面上**没有任何入口** —— 用户只能导入不能导出。
          // 这里补两个按钮，直接下载真实文件。
          h('button', {
            className: 'wb-btn', type: 'button', 'aria-label': t('exportIcs'),
            title: t('exportIcsHint'),
            disabled: exporting !== null,
            onClick: () => exportData('ics'),
          }, exporting === 'ics' ? t('exporting') : t('export')),
          h('button', {
            className: 'wb-btn', type: 'button', 'aria-label': t('exportJson'),
            title: t('exportJsonHint'),
            disabled: exporting !== null,
            onClick: () => exportData('json'),
          }, exporting === 'json' ? t('exporting') : t('exportJsonShort')),
          /**
           * V1.2：数据备份入口。
           *
           * 后端 `store.backup` / `store.listBackups` / `store.rollback` 一直都在，
           * 但界面上没有任何入口 —— 用户能导出文件，却不能用插件自己的
           * 带时间戳的备份体系。这是「后端已实现、UI 缺失」的典型缺口。
           */
          h('button', {
            className: 'wb-btn', type: 'button', 'aria-label': t('backupPanel'),
            title: t('backupPanelHint'),
            onClick: () => { setBackupPanel(true); loadBackups() },
          }, t('backupPanel')),
          // WP6-D：AI 智能规划入口（只生成提案，确认前不写任何数据）
          h('button', {
            className: 'wb-btn', type: 'button', 'aria-label': t('aiPlan'),
            title: t('aiPlanHint'),
            onClick: () => { setPlanPanel('input'); setPlanGoal(''); setError(null) },
          }, '✦ ', t('aiPlan')),
          h('button', { className: 'wb-btn wb-btn-primary', type: 'button', onClick: openNew }, '+ ', t('new'))),
        h(StatusBar, { loading, error, onRetry: load, t }),
        // V1.2 · 备份面板：列出可用备份、手动备份、审批后回滚
        backupPanel !== true ? null : h('div', { className: 'wb-backup-panel', role: 'region', 'aria-label': t('backupPanel') },
          h('div', { className: 'wb-backup-head' },
            h('strong', null, t('backupPanel')),
            h('button', { className: 'wb-btn', type: 'button', disabled: backupBusy, onClick: makeBackup },
              backupBusy ? t('saving') : t('backupCreate')),
            h('button', { className: 'wb-btn', type: 'button', onClick: () => setBackupPanel(false) }, t('close'))),
          h('p', { className: 'wb-tertiary', style: { margin: '4px 0 8px' } }, t('backupPanelHint')),
          backupList.length === 0
            ? h('div', { className: 'wb-muted' }, t('backupEmpty'))
            : h('ul', { className: 'wb-backup-list' }, backupList.slice().reverse().slice(0, 10).map((name) => h('li', { key: name },
                h('code', null, name),
                h('button', {
                  className: 'wb-btn wb-btn-mini', type: 'button',
                  disabled: backupBusy,
                  'aria-label': `${t('restore')} ${name}`,
                  onClick: () => rollbackTo(name),
                }, t('restore')))))),

        // role=status 默认就是 polite，但显式写 aria-live 才能保证读屏真的播报
        // （部分实现只在节点已存在时才生效，动态插入需要这层兜底）
        notice ? h('div', { className: 'wb-status', role: 'status', 'aria-live': 'polite' }, notice) : null,
        /**
         * 提醒条：显示「接下来 7 天要提醒什么」。
         *
         * 三条硬纪律：
         * 1. **只显示未来的**——过去的提醒不该在界面上继续占位。
         * 2. **最多 3 条**——提醒是提示，不是列表，超过就折叠成计数。
         * 3. **skipped 必须可见**——「算不出提醒」不等于「没有提醒」，
         *    静默吞掉会让用户以为一切正常，实际有日程根本不会提醒。
         */
        (() => {
          const upcoming = reminders.filter((r) => r.fireAtMs > Date.now())
          if (upcoming.length === 0 && reminderSkipped === 0) return null
          const shown = upcoming.slice(0, 3)
          return h('div', { className: 'wb-status wb-reminders', role: 'status', 'aria-live': 'polite' },
            h('span', { className: 'wb-reminder-label' }, '⏰ ' + t('reminder')),
            shown.length === 0
              ? h('span', null, t('noUpcoming'))
              : shown.map((r) => h('span', {
                  key: r.reminderKey,
                  className: 'wb-reminder-chip',
                  title: r.prompt,
                }, `${formatReminderTime(r.fireAtMs)} ${r.title}`)),
            upcoming.length > shown.length
              ? h('span', { className: 'wb-reminder-more' }, `+${upcoming.length - shown.length}`)
              : null,
            reminderSkipped > 0
              ? h('span', { className: 'wb-reminder-warn' },
                  `${reminderSkipped} ${t('reminderSkipped')}`)
              : null)
        })(),
        conflictCount > 0
          // 冲突是需要立刻知道的问题。role=status 是 polite 播报，会被延迟或合并；
          // 同文件其他错误信息（:330）用的就是 alert，这里必须一致。
          ? h('div', { className: 'wb-status wb-status-error', role: 'alert' },
              `${conflictCount} event(s) have scheduling conflicts in the next 7 days`)
          : null,

        h('div', { className: 'wb-body' },
          h('div', { className: 'wb-main wb-scroll' },
            editing !== null
              ? h('div', { className: 'wb-dialog' },
                  h('h2', null, editing.data?.id !== undefined ? t('edit') : t('new'), ' ', editing.kind === 'event' ? t('kindEvent') : t('kindTask')),
                  editing.kind === 'event'
                    ? h(EventForm, { initial: editing.data, saving, t, onSave: saveEvent, onCancel: () => setEditing(null) })
                    : h(TaskForm, { initial: editing.data, saving, t, onSave: saveTask, onCancel: () => setEditing(null) }))
              : null,

            tab === 'calendar'
              ? h('div', null,
                  h('div', { className: 'wb-section' },
                    h(ViewTabs, {
                      value: view,
                      onChange: setView,
                      options: [{ id: 'month', label: t('month') }, { id: 'week', label: t('week') }, { id: 'day', label: t('day') }, { id: 'agenda', label: t('agenda') }],
                      t,
                    }),
                    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
                      h('button', { className: 'wb-btn', type: 'button', onClick: () => setCursor((c) => view === 'month' ? new Date(c.getFullYear(), c.getMonth() - 1, 1) : addDays(c, view === 'week' ? -7 : -1)), 'aria-label': t('previous') }, '‹'),
                      h('span', { className: 'wb-muted' }, formatCursor(cursor, t)),
                      h('button', { className: 'wb-btn', type: 'button', onClick: () => setCursor((c) => view === 'month' ? new Date(c.getFullYear(), c.getMonth() + 1, 1) : addDays(c, view === 'week' ? 7 : 1)), 'aria-label': t('next') }, '›'),
                      h('button', { className: 'wb-btn', type: 'button', onClick: () => setCursor(new Date()) }, t('today')))),
                  view === 'month'
                    ? h(MonthView, {
                        events: filteredEvents, cursor,
                        onSelectDay: (d) => { setCursor(d); setView('day') },
                        // 选中必须带 kind：键盘改期靠 sel.kind==='event' 判分支，
                        // 直接透传裸事件会让 ←/→ 永远走不到 nudgeEventDay。
                        onSelectEvent: (e) => setSelected({ kind: 'event', ...e }),
                        drag, setDrag, dropHint, setDropHint,
                        onDropEvent: (target, dateKey) => moveEventToDate(target, dateKey),
                        t,
                      })
                    : h(AgendaList, {
                        events: view === 'week' ? weekEvents : view === 'day' ? dayEvents : todayEvents,
                        onSelect: (e) => setSelected({ kind: 'event', ...e }),
                        emptyText: view === 'agenda' ? t('noEvents7d') : t('noEventsRange'),
                        // 周/日/议程按天分组：这三个视图要回答的是「哪天有什么事」，
                        // 扁平列表看不出空档。「今日 & 接下来 7 天」是时间线，不分组。
                        groupByDay: true,
                        drag, setDrag, t,
                      }),
                  h('div', { className: 'wb-section', style: { marginTop: '24px' } },
                    h('h2', null, t('today') + ' & ' + t('next7days')),
                    h(AgendaList, { events: todayEvents, onSelect: (e) => setSelected({ kind: 'event', ...e }), emptyText: t('nothingScheduled'), t })))
              : h('div', null,
                  /**
                   * WP6-D · 今日 / 本周智能计划摘要。
                   * 只展示最近一次生成的提案统计与快捷入口，不重做待办列表。
                   */
                  h('div', { className: 'wb-status wb-plan-summary', role: 'status', 'aria-live': 'polite' },
                    h('span', null, t('aiPlan'), ' · ',
                      typeof planPanel === 'object' && planPanel?.stats !== undefined
                        ? t('planStats')
                            .replace('{decomposed}', String(planPanel.stats.decomposed ?? 0))
                            .replace('{scheduled}', String(planPanel.stats.scheduled ?? 0))
                            .replace('{used}', String(planPanel.stats.usedMinutes ?? 0))
                            .replace('{capacity}', String(planPanel.stats.capacityMinutes ?? 0))
                        : t('aiPlanHint')),
                    h('button', {
                      className: 'wb-btn', type: 'button', 'aria-label': t('aiPlan'),
                      onClick: () => { setPlanPanel('input'); setPlanGoal(''); setError(null) },
                    }, t('generatePlan'))),
                  h('div', { className: 'wb-section' },
                    h(ViewTabs, {
                      value: taskFilter,
                      onChange: setTaskFilter,
                      options: [
                        { id: 'today', label: t('today') }, { id: 'planned', label: t('planned') },
                        { id: 'doing', label: t('inProgress') }, { id: 'done', label: t('done') },
                      ],
                      t,
                    })),
                  h('div', { className: 'wb-section', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                    h('button', {
                      className: 'wb-btn', type: 'button', disabled: !history.canUndo,
                      'aria-label': t('undo'), title: history.canUndo ? t('undo') + ' (Ctrl/Cmd+Z)' : t('nothingToUndo'),
                      onClick: undo,
                    }, '↶ ' + t('undo')),
                    h('button', {
                      className: 'wb-btn', type: 'button', disabled: !history.canRedo,
                      'aria-label': t('redo'), title: history.canRedo ? t('redo') + ' (Ctrl/Cmd+Shift+Z)' : t('nothingToRedo'),
                      onClick: redo,
                    }, '↷ ' + t('redo')),
                    h('span', { className: 'wb-tertiary', style: { fontSize: '12px' } },
                      `${t('undoableSteps')} ${history.undoDepth}`)),
                  // 分组渲染：project 相同的待办归一组，组内按 order 排。
                  // 拖拽排序只在**组内**进行——跨组拖动要改 project，那是另一个语义，
                  // 不在本次授权范围内，所以明确不做（而不是默默允许然后字段错乱）。
                  groupedTasks.length === 0
                    ? h('div', { className: 'wb-empty' }, t('noTasks'))
                    : h('div', null,
                        groupedTasks.map((g) => h('div', { key: g.project ?? '__none__' },
                          h('div', { className: 'wb-group-head' },
                            h('span', null, g.project === null ? t('ungrouped') : g.project),
                            h('span', { className: 'wb-tertiary', style: { fontSize: '12px' } },
                              `${g.rows.length} ${t('items')}`)),
                          g.rows.map((row) => h('div', {
                            key: row.id,
                            className: `wb-row${dropHint !== null && dropHint.kind === 'task' && dropHint.id === row.id ? ' wb-drop-target' : ''}`,
                            onDragOver: (ev) => {
                              if (drag === null || drag.kind !== 'task') return
                              ev.preventDefault()
                              ev.dataTransfer.dropEffect = 'move'
                              if (dropHint === null || dropHint.id !== row.id) setDropHint({ kind: 'task', id: row.id })
                            },
                            onDragLeave: () => {
                              if (dropHint !== null && dropHint.kind === 'task' && dropHint.id === row.id) setDropHint(null)
                            },
                            onDrop: (ev) => {
                              ev.preventDefault()
                              setDropHint(null)
                              if (drag === null || drag.kind !== 'task') return
                              reorderTasks(g.project ?? null, drag.id, row.id)
                            },
                          },
                            // 拖拽手柄：键盘用户用下方「上移/下移」按钮，不依赖拖拽
                            h('button', {
                              className: 'wb-handle', type: 'button', draggable: true,
                              'aria-label': `${t('dragToReorder')} ${row.title}`,
                              title: t('reorderHint'),
                              onDragStart: (ev) => {
                                ev.dataTransfer.effectAllowed = 'move'
                                ev.dataTransfer.setData('text/plain', row.id)
                                setDrag({ kind: 'task', id: row.id, title: row.title, group: g.project ?? null })
                              },
                              onDragEnd: () => { setDrag(null); setDropHint(null) },
                            }, '⠿'),
                            h('button', {
                              className: 'wb-row-main', type: 'button',
                              'aria-label': `${row.done === true ? t('reopen') : t('complete')} ${row.title}`,
                              onClick: () => toggleTask(row),
                            },
                              h('span', { 'aria-hidden': true }, row.done === true ? '☑' : '☐'),
                              h('span', { style: { flex: 1, textDecoration: row.done === true ? 'line-through' : 'none' } }, row.title),
                              row.priority === 'high' ? h('span', { className: 'wb-badge' }, t('priorityHigh')) : null,
                              /**
                               * 到期时间的展示（WP5.1 · P2）。
                               *
                               * 原实现 `String(row.dueAt).slice(0, 10)`：把任意字符串
                               * 截前 10 个字符直接显示。实测 `dueAt === '排序验证'` 的坏
                               * 数据在列表里被当成「到期时间」原样展示出来，用户看不出
                               * 这是脏数据，只会以为界面坏了。
                               *
                               * 现在：能解析的显示规范化日期；解析不了的显式标注
                               * 「时间格式异常」，与提醒条的降级提示口径一致。
                               */
                              (() => {
                                const due = dueDisplay(row.dueAt)
                                if (due.kind === 'none') return null
                                if (due.kind === 'date') {
                                  return h('span', { className: 'wb-tertiary', style: { fontSize: '12px' } }, due.text)
                                }
                                return h('span', {
                                  className: 'wb-status-error',
                                  style: { fontSize: '12px' },
                                  title: due.raw,
                                  'aria-label': t('dueAtBroken'),
                                }, t('dueAtBroken'))
                              })()),
                            h('button', { className: 'wb-btn', type: 'button', 'aria-label': t('openDetails').replace('{title}', row.title), onClick: () => setSelected({ kind: 'task', ...row }) }, '…'),
                            // 键盘替代操作：不依赖鼠标拖拽也能调整顺序
                            h('button', {
                              className: 'wb-btn', type: 'button', 'aria-label': `${t('moveUp')} ${row.title}`,
                              onClick: () => nudgeTask(g.project ?? null, row.id, -1),
                            }, '↑'),
                            h('button', {
                              className: 'wb-btn', type: 'button', 'aria-label': `${t('moveDown')} ${row.title}`,
                              onClick: () => nudgeTask(g.project ?? null, row.id, 1),
                            }, '↓'),
                            h('button', {
                              className: 'wb-btn', type: 'button', 'aria-label': `${t('archive')} ${row.title}`,
                              title: t('archiveHint'), onClick: () => setArchived(row.id, true),
                            }, t('archive'))))))),
                  // 归档区：默认收起。归档不是删除，所以这里必须能恢复。
                  archivedTasks.length === 0
                    ? null
                    : h('div', { className: 'wb-section', style: { marginTop: '16px' } },
                        h('button', {
                          className: 'wb-btn', type: 'button',
                          'aria-expanded': showArchived ? 'true' : 'false',
                          onClick: () => setShowArchived((v) => !v),
                        }, showArchived ? '▾' : '▸', ` ${t('archivedSection')}（${archivedTasks.length}）`),
                        showArchived
                          ? h('div', null, archivedTasks.map((row) => h('div', { key: row.id, className: 'wb-row' },
                              h('span', { className: 'wb-tertiary', style: { flex: 1, minHeight: '44px', display: 'flex', alignItems: 'center' } }, row.title),
                              h('button', {
                                className: 'wb-btn', type: 'button', 'aria-label': `${t('restore')} ${row.title}`,
                                onClick: () => setArchived(row.id, false),
                              }, t('restore')))))
                          : null)))

          , h('div', { className: 'wb-side wb-scroll' },
              selected === null
                ? h('div', { className: 'wb-empty' }, t('selectToSeeDetails'))
                : h('div', null,
                    h('h2', null, selected.title ?? t('untitled')),
                    h('div', { className: 'wb-muted' }, selected.kind === 'task' ? t('kindTask') : t('kindEvent')),
                    h('dl', null,
                      h('dt', { className: 'wb-tertiary' }, t('fieldId')),
                      h('dd', null, selected.id),
                      selected.dueAt ? h('dt', { className: 'wb-tertiary' }, t('fieldDue')) : null,
                      selected.dueAt ? h('dd', null, selected.dueAt) : null,
                      selected.start ? h('dt', { className: 'wb-tertiary' }, t('fieldStart')) : null,
                      selected.start ? h('dd', null, selected.start) : null,
                      selected.description ? h('dt', { className: 'wb-tertiary' }, t('fieldDescription')) : null,
                      selected.description ? h('dd', null, selected.description) : null,
                      selected.recurrence ? h('dt', { className: 'wb-tertiary' }, t('fieldRepeats')) : null,
                      selected.recurrence ? h('dd', null, `${selected.recurrence.freq ?? t('fieldCustom')}${selected.recurrenceOccurrences ? ' · ' + t('occurrencesNext7').replace('{n}', selected.recurrenceOccurrences) : ''}`) : null,
                      selected.conflict === true ? h('dt', { className: 'wb-tertiary' }, t('fieldConflict')) : null,
                      selected.conflict === true ? h('dd', { className: 'wb-status-error' }, t('conflictOverlap')) : null,
                      selected.subtasks ? h('dt', { className: 'wb-tertiary' }, t('fieldSubtasks')) : null,
                      selected.subtasks ? h('dd', null, h('ul', null,
                        (Array.isArray(selected.subtasks) ? selected.subtasks : []).map((st, i) =>
                          h('li', { key: i }, typeof st === 'string' ? st : (st.title ?? JSON.stringify(st)))))) : null,
                      /**
                       * WP6-C/D · 任务详情里的 Agent 协作面板。
                       *
                       * 从内联 IIFE 抽成独立组件（V1.1 §2）：内联形态无法被
                       * __test 渲染断言，只能正则扫源码 —— 扫不出「空列表时
                       * 显示什么」。面板要真的可用，就必须每种状态都能测。
                       *
                       * 契约边界不变：插件层**没有**会话跳转契约（docs/wp6/
                       * 00-contract.md §7.1 一手核实），故不自造 openSession，
                       * 「进入会话」落地为可复制的 sessionId。
                       */
                      selected.kind === 'task'
                        ? h(CollabPanel, {
                            task: selected,
                            t,
                            saving,
                            copying: copyState.busy,
                            onCopySession: copySessionId,
                            onOpenSession: openSessionById,
                            isKnownSession,
                            onAccept: () => decideCompletion('accept'),
                            onReject: () => decideCompletion('reject', t('completionFeedback')),
                          })
                        : null,
                    ),
                    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '16px' } },
                      h('button', {
                        className: 'wb-btn', type: 'button',
                        onClick: () => setEditing({ kind: selected.kind === 'task' ? 'task' : 'event', data: selected }),
                      }, t('edit')),
                      h('button', {
                        className: 'wb-btn wb-btn-danger', type: 'button',
                        onClick: () => setConfirming({ kind: selected.kind ?? 'event', id: selected.id, label: selected.title ?? '' }),
                      }, t('deleteAction')),
                      /**
                       * 验收按钮已移入 CollabPanel（V1.1 §2.4）。
                       * 移走而非复制：验收入口必须**唯一**，两处按钮意味着
                       * 两套状态判断，迟早出现「一处可点一处不可点」。
                       * 红线不变 —— AI 工具面仍无此能力。
                       */
                      h('button', { className: 'wb-btn', type: 'button', onClick: () => setSelected(null) }, t('close')))))),

        confirming !== null
          ? h(ConfirmDelete, {
              label: confirming.label, approving, t,
              onConfirm: () => deleteWithApproval(confirming.kind, confirming.id),
              onCancel: () => setConfirming(null),
            })
          : null,

        // 重复事件拖拽后问范围：只改这一次 / 改整个系列
        moveDialog !== null
          ? h(MoveScopeDialog, {
              title: moveDialog.title, dateKey: moveDialog.dateKey,
              onChoose: (mode) => {
                const pending = moveDialog
                setMoveDialog(null)
                /**
                 * occurrenceDate 必须是**源日**（被拖的那个实例），
                 * 不能拿 pending.dateKey 冒充 —— 那是落点。
                 *
                 * 实测把落点当源日：DAILY 系列返回成功，但 excludeDates 记的
                 * 是落点那天，源日照旧存在 → 用户以为拖走了，实际目标那天被吞掉。
                 * 源日由拖拽开始时记进 drag 状态，一路传到 moveDialog。
                 */
                /**
                 * **不许**用 `pending.dateKey`（落点）兜底源日。
                 * 兜底成落点 = 服务端把落点记进 EXDATE（M-2 已实证静默写坏：
                 * 源日还在、目标日被吞，一层都不报错）。源日缺失就当场报错，
                 * 让用户看见，而不是写坏数据。
                 */
                if (pending.occurrenceDate === null || pending.occurrenceDate === undefined) {
                  setMoveDialog(null)
                  setError(t('missingSourceDate'))
                  return
                }
                moveEventToDate(
                  { kind: 'event', id: pending.id, occurrenceDate: pending.occurrenceDate },
                  pending.dateKey,
                  mode,
                )
              },
              onCancel: () => setMoveDialog(null),
              // 不传 t 会回落到 defaultT（= LOCALE.en），组件内的中文就混排出来
              t,
            })
          : null,

        // 导入预览：看清四类计数再决定
        importPanel !== null
          ? h(ImportPreview, {
              preview: importPanel,
              approving,
              onConfirm: () => confirmImport(importPanel),
              onCancel: () => setImportPanel(null),
              t,
            })
          : null,

        // WP6-D：智能规划提案面板（含拆解/排期/冲突/原因 + 确认/拒绝/修改）
        planPanel !== null
          ? h(PlanPanel, {
              proposal: planPanel === 'input' ? null : planPanel.proposal,
              stats: planPanel === 'input' ? {} : planPanel.stats,
              goal: planGoal,
              onGoalChange: setPlanGoal,
              windowKind: planWindow,
              onWindowChange: setPlanWindow,
              generating: planGenerating,
              approving,
              onGenerate: generatePlan,
              onConfirm: confirmPlan,
              onReject: rejectPlan,
              onModify: () => setPlanPanel('input'),
              onClose: () => setPlanPanel(null),
              t,
            })
          : null,

        // 拖拽跟随提示：让用户知道「正在拖什么、会落到哪」
        drag !== null
          ? h('div', {
              className: 'wb-drag-preview',
              // 装饰层对读屏隐藏；真正的播报交给下方 role=status 的节点
              'aria-hidden': 'true',
              style: dragAt === null ? null : { left: `${dragAt.x + 12}px`, top: `${dragAt.y + 12}px` },
            },
              t('dragMoving') + ' ' + (drag.title || t('untitled')),
              dropHint !== null && dropHint.kind === 'event' ? ' → ' + dropHint.dateKey : '')
          : null,
        /**
         * 拖拽的读屏播报。视觉浮层是 aria-hidden 的装饰，键盘/读屏用户
         * 拿不到任何拖拽反馈 —— 这个节点补上那一路。
         */
        drag !== null
          ? h('div', { className: 'wb-sr-only', role: 'status', 'aria-live': 'polite' },
              t('dragMoving') + ' ' + (drag.title || t('untitled'))
              + (dropHint !== null && dropHint.kind === 'event' ? ' ' + t('dragWillDrop') + ' ' + dropHint.dateKey : ''))
          : null)
    }

    // --------------------------------------------------------------- 注册
    return {
      /**
       * **Cordis inject 是逐服务名精确匹配的，不递归**（WP5 真机发现）。
       *
       * 真机报错 `cannot get property "remote.commands" without inject`：
       * 声明 `remote` 只拿到 remote 根对象，其上的 `commands` 子服务仍需单独声明。
       * 官方 dsh-client-ui-plan/lib/client.js:605 就是 `['remote', 'remote.commands', ...]`。
       *
       * 静态测试与 render 测试都测不出这个 —— 只有真浏览器 + 真 Cordis 才报。
       */
      inject: [
        'slots',
        'remote',
        'remote.commands',
        'remote.session',
        'sessions',
        'locale',
      ],
      /** 仅供测试取用真实实现（见 __test 注释）。 */
      __test,
      apply(ctx) {
        // 注册 UI 文案（真 locale 服务）：locale.register(NS, { zh, en })
        ctx.effect(() => ctx.locale.register(NS, LOCALE), 'workbench-ui: locale')
        // factory 内不产生副作用；注册都在 apply 里，ctx.effect 负责清理
        ctx.effect(() => {
          const d1 = ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            id: PANEL_ID,
            locale: NS,
            inject: () => ({ ctx, t: ctx.locale.bind(NS) }),
          }, WorkbenchPage))
          const d2 = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            locale: NS,
            label: () => ctx.locale.bind(NS)('panel'),
          }, function WorkbenchIcon() {
            return h('svg', {
              viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true,
              fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
            },
              h('rect', { x: 3, y: 4, width: 18, height: 17, rx: 2 }),
              h('path', { d: 'M3 9h18M8 2v4M16 2v4' }),
              h('path', { d: 'M7 14h4v4H7z' }))
          }))
          return () => { d1?.(); d2?.() }
        }, 'workbench-ui: slots')
      },
    }
  },
})
