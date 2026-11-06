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
  id: '@local/dsh-workbench-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const PANEL_ID = 'workbench'
    const NS = '@local/dsh-workbench-ui'

    // UI 文案走真 Client locale 服务（ctx.locale.register/bind）。
    // 真契约：dsh-client-ui-approval/lib/client.js:316 `ctx.locale.register(NS, { zh, en })`，
    // 取值 `ctx.locale.bind(NS)`('key')。
    const LOCALE = {
      en: {
      "meta": {
            "title": "Workbench",
            "description": "A calendar and todo workbench backed by the Host Service."
      },
      "panel": "Workbench",
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
      "error": "Error"
},
      zh: {
      "meta": {
            "title": "工作台",
            "description": "由 Host Service 提供数据的日历与待办工作台。"
      },
      "panel": "工作台",
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
      "error": "错误"
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
.wb-empty{padding:32px 16px;text-align:center;color:var(--dsw-alias-label-secondary)}
.wb-form{display:grid;gap:8px}
.wb-form label{display:grid;gap:4px;font-size:16px;color:var(--dsw-alias-label-secondary)}
.wb-dialog{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:16px;
  margin-bottom:16px}
.wb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;
  align-items:center;justify-content:center;z-index:1000}
.wb-overlay-panel{background:var(--dsw-alias-interactive-bg-hover);
  border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:24px;
  min-width:320px;max-width:min(560px,90vw);max-height:80vh;overflow:auto}
.wb-overlay-panel h2{font-size:20px;margin:0 0 16px 0}
.wb-kbd{font:inherit;font-size:12px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:4px;color:var(--dsw-alias-label-tertiary)}
@media (max-width:800px){.wb-side{width:100%;max-width:none;border-left:0;
  border-top:1px solid var(--dsw-alias-border-l1)}.wb-body{flex-direction:column}}
`

    // --------------------------------------------------------------- 工具函数
    const pad = (n) => String(n).padStart(2, '0')
    const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
    const sameDay = (a, b) => isoDate(a) === isoDate(b)
    const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
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

    function taskBucket(t, now) {
      // 已软删的待办不进任何桶（复审 MAJOR：删除后仍出现在列表里）
      if (t?.deleted === true || (typeof t?.deletedAt === 'string' && t.deletedAt !== '')) return 'deleted'
      if (t.done === true) return 'done'
      const due = typeof t.dueAt === 'string' && t.dueAt !== '' ? new Date(t.dueAt) : null
      if (due !== null && !Number.isNaN(due.getTime()) && sameDay(due, now)) return 'today'
      if (t.status === 'in_progress') return 'doing'
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

    // 供测试直接 import 本模块验证真实解码（复审 N1：
    // 测试用复刻的 decode() 会让真 bug 复活而测试全绿）。
    // 挂在 window 上仅为测试取用；生产路径不依赖它。
    const __test = { callHost }

    // --------------------------------------------------------------- 组件
    function StatusBar({ loading, error, onRetry }) {
      if (loading) return h('div', { className: 'wb-status', role: 'status', 'aria-live': 'polite' }, 'Loading…')
      if (error) {
        return h('div', { className: 'wb-status wb-status-error', role: 'alert' },
          h('span', null, `Error: ${error}`),
          h('button', { className: 'wb-btn', type: 'button', onClick: onRetry, 'aria-label': 'Retry' }, 'Retry'))
      }
      return h('div', { className: 'wb-status', role: 'status', 'aria-live': 'polite' }, 'Ready')
    }

    function ViewTabs({ value, onChange, options }) {
      return h('div', { className: 'wb-tabs', role: 'tablist', 'aria-label': 'View' },
        options.map((o) => h('button', {
          key: o.id, className: 'wb-btn', type: 'button', role: 'tab',
          'aria-selected': value === o.id, 'aria-pressed': value === o.id,
          onClick: () => onChange(o.id),
        }, o.label)))
    }

    function MonthView({ events, cursor, onSelectDay, onSelectEvent }) {
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
        WEEKDAYS.map((w) => h('div', { key: w, className: 'wb-tertiary', style: { padding: '8px', fontSize: '12px' } }, w)),
        cells.map((d) => {
          const k = isoDate(d)
          const list = byDay.get(k) ?? []
          const inMonth = d.getMonth() === cursor.getMonth()
          return h('button', {
            key: k, type: 'button',
            className: `wb-cell${sameDay(d, today) ? ' wb-cell-today' : ''}`,
            'aria-label': `${k}, ${list.length} events`,
            onClick: () => onSelectDay(d),
            style: { opacity: inMonth ? 1 : 0.45 },
          },
            h('div', null, String(d.getDate())),
            list.slice(0, 2).map((e) => h('div', {
              key: e.id, className: 'wb-tertiary',
              style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, e.allDay ? 'All day · ' : `${fmtTime(e.start)} · `, e.title)))
        }))
    }

    function AgendaList({ events, onSelect, emptyText }) {
      if (events.length === 0) return h('div', { className: 'wb-empty' }, emptyText)
      return h('div', null, events.map((e) => h('div', { key: e.id, className: 'wb-row' },
        h('button', { className: 'wb-row-main', type: 'button', onClick: () => onSelect(e) },
          h('span', null, e.allDay === true ? 'All day' : fmtTime(e.start)),
          h('span', { style: { flex: 1 } }, e.title || '(untitled)'),
          e.recurrence ? h('span', { className: 'wb-badge' }, 'Repeat') : null,
          e.conflict === true ? h('span', { className: 'wb-badge' }, 'Conflict') : null),
        h('button', {
          className: 'wb-btn', type: 'button',
          'aria-label': `Open ${e.title || 'event'}`,
          onClick: () => onSelect(e),
        }, '…'))))
    }

    function EventForm({ initial, onSave, onCancel, saving }) {
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
        h('label', null, 'Title',
          h('input', { className: 'wb-input', value: title, onChange: (e) => setTitle(e.target.value), required: true, autoFocus: true })),
        h('label', null, 'Date',
          h('input', { className: 'wb-input', type: 'date', value: date, onChange: (e) => setDate(e.target.value) })),
        h('label', null, 'All day',
          h('input', { type: 'checkbox', checked: allDay, onChange: (e) => setAllDay(e.target.checked), style: { minHeight: '44px', minWidth: '44px' } })),
        allDay ? null : h('label', null, 'Time',
          h('input', { className: 'wb-input', type: 'time', value: time, onChange: (e) => setTime(e.target.value) })),
        h('label', null, 'Description',
          h('input', { className: 'wb-input', value: description, onChange: (e) => setDescription(e.target.value) })),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { className: 'wb-btn wb-btn-primary', type: 'submit', disabled: saving }, saving ? 'Saving…' : 'Save'),
          h('button', { className: 'wb-btn', type: 'button', onClick: onCancel }, t('cancel'))))
    }

    function TaskForm({ initial, onSave, onCancel, saving }) {
      const [title, setTitle] = useState(initial?.title ?? '')
      const [dueAt, setDueAt] = useState(initial?.dueAt ?? '')
      const [priority, setPriority] = useState(initial?.priority ?? 'normal')
      const submit = (ev) => {
        ev.preventDefault()
        if (title.trim() === '') return
        // **最终 Review BLOCKER 修复**：整行替换会丢 subtasks/sourceSessionId
        // 等字段，故展开 initial 全量字段再覆盖表单值。
        onSave({
          ...(initial ?? {}),
          id: initial?.id ?? `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: title.trim(), dueAt, priority,
          done: initial?.done === true,
          status: initial?.status ?? 'planned',
        })
      }
      return h('form', { className: 'wb-form', onSubmit: submit },
        h('label', null, 'Title',
          h('input', { className: 'wb-input', value: title, onChange: (e) => setTitle(e.target.value), required: true, autoFocus: true })),
        h('label', null, 'Due (ISO instant)',
          h('input', { className: 'wb-input', value: dueAt, onChange: (e) => setDueAt(e.target.value), placeholder: '2026-11-10T09:00:00Z' })),
        h('label', null, 'Priority',
          h('select', { className: 'wb-input', value: priority, onChange: (e) => setPriority(e.target.value) },
            h('option', { value: 'low' }, 'Low'),
            h('option', { value: 'normal' }, 'Normal'),
            h('option', { value: 'high' }, 'High'))),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { className: 'wb-btn wb-btn-primary', type: 'submit', disabled: saving }, saving ? 'Saving…' : 'Save'),
          h('button', { className: 'wb-btn', type: 'button', onClick: onCancel }, t('cancel'))))
    }

    function ConfirmDelete({ label, onConfirm, onCancel, approving }) {
      return h('div', { className: 'wb-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Confirm delete' },
        h('div', { className: 'wb-overlay-panel' },
          h('h2', null, t('delete'), '?'),
          h('p', null, `This requires Host approval before deleting “${label}”.`),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button', { className: 'wb-btn wb-btn-danger', type: 'button', disabled: approving, onClick: onConfirm }, approving ? 'Requesting approval…' : 'Request approval & delete'),
            h('button', { className: 'wb-btn', type: 'button', onClick: onCancel }, t('cancel')))))
    }

    // --------------------------------------------------------------- 主页面
    function WorkbenchPage(props) {
      // UI 文案走 locale 服务
      const t = props.t ?? ((k) => LOCALE.en[k] ?? k)
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
      const [search, setSearch] = useState('')
      const [cursor, setCursor] = useState(() => new Date())
      const [selected, setSelected] = useState(null)
      const [editing, setEditing] = useState(null)   // {kind:'event'|'task', data?}
      const [confirming, setConfirming] = useState(null) // {kind, id, label}
      const [saving, setSaving] = useState(false)
      const [approving, setApproving] = useState(false)
      const searchRef = useRef(null)

      const request = useCallback(async (req) => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new Error('No active session; open the workbench from a conversation')
        }
        return callHost(ctx, sessionId, req)
      }, [ctx, sessionId])

      const load = useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          setError('No active session; open the workbench from a conversation')
          return
        }
        setLoading(true)
        setError(null)
        try {
          const now = Date.now()
          const windowStart = new Date(now).setHours(0, 0, 0, 0)
          const windowEnd = windowStart + 7 * 24 * 3600 * 1000
          // 全部来自真实 Host Service（event.list / task.list / event.conflicts /
          // event.expand），无任何本地假数据。
          // 各命令**独立降级**：任一失败不应让整页变空白（其余数据仍可用）。
          const [ev, tk, cf, ex] = await Promise.all([
            request({ op: 'event.list', payload: { includeDeleted: false } }),
            request({ op: 'task.list', payload: {} }),
            request({ op: 'event.conflicts', payload: { windowStart, windowEnd } }),
            request({ op: 'event.expand', payload: { windowStart, windowEnd } }),
          ])
          // 主数据（事件/待办）失败才算整体失败；冲突与展开失败只降级为「无」
          if (ev.ok !== true && tk.ok !== true) {
            throw new Error(ev.error?.message ?? tk.error?.message ?? '加载失败')
          }
          if (ev.ok !== true) setError(`日程加载失败：${ev.error?.message ?? ''}`)
          if (tk.ok !== true) setError(`待办加载失败：${tk.error?.message ?? ''}`)
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
          setEvents((Array.isArray(ev.value) ? ev.value : []).map((e) => ({
            ...e,
            ...(conflictIds.has(e.id) ? { conflict: true } : {}),
            ...(recurrenceCount.has(e.id) ? { recurrenceOccurrences: recurrenceCount.get(e.id) } : {}),
          })))
          setTasks(Array.isArray(tk.value) ? tk.value : [])
          setConflictCount(conflictIds.size)
          setNotice('Loaded from Host Service')
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setLoading(false)
        }
      }, [request, sessionId])

      useEffect(() => { load() }, [load])

      // Ctrl/Cmd+K 聚焦搜索（键盘可访问性）
      useEffect(() => {
        const onKey = (ev) => {
          if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
            ev.preventDefault()
            searchRef.current?.focus()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      const filteredEvents = useMemo(() => {
        const q = search.trim().toLowerCase()
        return events.filter((e) => q === '' || String(e.title ?? '').toLowerCase().includes(q))
      }, [events, search])

      const filteredTasks = useMemo(() => {
        const q = search.trim().toLowerCase()
        const now = new Date()
        return tasks.filter((t) => {
          if (t?.deleted === true || (typeof t?.deletedAt === 'string' && t.deletedAt !== '')) return false
          if (q !== '' && !String(t.title ?? '').toLowerCase().includes(q)) return false
          return taskBucket(t, now) === taskFilter
        })
      }, [tasks, search, taskFilter])

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
          setNotice(op === 'event.create' ? 'Event created in Host' : 'Event updated in Host')
          await load()
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
          setNotice('Task saved in Host')
          await load()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setSaving(false)
        }
      }

      const toggleTask = async (t) => {
        setError(null)
        try {
          const r = await request({ op: 'task.upsert', payload: { task: { ...t, done: t.done !== true } } })
          if (r.ok !== true) throw new Error(r.error?.message ?? 'task.upsert failed')
          setNotice(t.done === true ? 'Task reopened' : 'Task completed')
          await load()
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
          const detail = { target: id, summary: `Delete ${kind} ${id}` }
          const approval = await request({
            op: 'requestApproval',
            payload: { approvalOp: op, ...detail },
          })
          if (approval.ok !== true) {
            throw new Error(approval.error?.message ?? 'Host approval was not granted')
          }
          const token = approval.value?.token
          if (typeof token !== 'string' || token === '') {
            throw new Error(approval?.error?.message ?? 'Host approval was not granted')
          }
          let r
          if (kind === 'task') {
            const t = tasks.find((x) => x.id === id) ?? { id }
            r = await request({
              op: 'task.upsert',
              payload: { task: { ...t, deleted: true, deletedAt: new Date().toISOString() } },
              approvalToken: token,
            })
          } else {
            r = await request({ op: 'event.delete', payload: { id }, approvalToken: token })
          }
          if (r.ok !== true) throw new Error(r.error?.message ?? `delete failed`)
          setConfirming(null)
          setSelected(null)
          setNotice('Deleted after Host approval')
          await load()
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
          }),
          h('div', { className: 'wb-spacer' }),
          h('input', {
            ref: searchRef, className: 'wb-input wb-search', type: 'search',
            placeholder: 'Search (Ctrl/Cmd+K)', 'aria-label': t('search'),
            value: search, onChange: (e) => setSearch(e.target.value),
          }),
          h('button', { className: 'wb-btn', type: 'button', onClick: load, 'aria-label': t('refresh') }, t('refresh')),
          h('button', { className: 'wb-btn wb-btn-primary', type: 'button', onClick: openNew }, '+ ', t('new'))),
        h(StatusBar, { loading, error, onRetry: load }),
        notice ? h('div', { className: 'wb-status', role: 'status' }, notice) : null,
        conflictCount > 0
          ? h('div', { className: 'wb-status wb-status-error', role: 'status' },
              `${conflictCount} event(s) have scheduling conflicts in the next 7 days`)
          : null,

        h('div', { className: 'wb-body' },
          h('div', { className: 'wb-main wb-scroll' },
            editing !== null
              ? h('div', { className: 'wb-dialog' },
                  h('h2', null, editing.data?.id !== undefined ? 'Edit' : 'New', ' ', editing.kind),
                  editing.kind === 'event'
                    ? h(EventForm, { initial: editing.data, saving, onSave: saveEvent, onCancel: () => setEditing(null) })
                    : h(TaskForm, { initial: editing.data, saving, onSave: saveTask, onCancel: () => setEditing(null) }))
              : null,

            tab === 'calendar'
              ? h('div', null,
                  h('div', { className: 'wb-section' },
                    h(ViewTabs, {
                      value: view,
                      onChange: setView,
                      options: [{ id: 'month', label: t('month') }, { id: 'week', label: t('week') }, { id: 'day', label: t('day') }, { id: 'agenda', label: t('agenda') }],
                    }),
                    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
                      h('button', { className: 'wb-btn', type: 'button', onClick: () => setCursor((c) => view === 'month' ? new Date(c.getFullYear(), c.getMonth() - 1, 1) : addDays(c, view === 'week' ? -7 : -1)), 'aria-label': 'Previous' }, '‹'),
                      h('span', { className: 'wb-muted' }, cursor.toDateString()),
                      h('button', { className: 'wb-btn', type: 'button', onClick: () => setCursor((c) => view === 'month' ? new Date(c.getFullYear(), c.getMonth() + 1, 1) : addDays(c, view === 'week' ? 7 : 1)), 'aria-label': 'Next' }, '›'),
                      h('button', { className: 'wb-btn', type: 'button', onClick: () => setCursor(new Date()) }, 'Today'))),
                  view === 'month'
                    ? h(MonthView, { events: filteredEvents, cursor, onSelectDay: (d) => { setCursor(d); setView('day') }, onSelectEvent: setSelected })
                    : h(AgendaList, {
                        events: view === 'week' ? weekEvents : view === 'day' ? dayEvents : todayEvents,
                        onSelect: setSelected,
                        emptyText: view === 'agenda' ? 'No events in the next 7 days' : 'No events in this range',
                      }),
                  h('div', { className: 'wb-section', style: { marginTop: '24px' } },
                    h('h2', null, t('today'), ' & next 7 days'),
                    h(AgendaList, { events: todayEvents, onSelect: setSelected, emptyText: 'Nothing scheduled' })))
              : h('div', null,
                  h('div', { className: 'wb-section' },
                    h(ViewTabs, {
                      value: taskFilter,
                      onChange: setTaskFilter,
                      options: [
                        { id: 'today', label: t('today') }, { id: 'planned', label: t('planned') },
                        { id: 'doing', label: t('inProgress') }, { id: 'done', label: t('done') },
                      ],
                    })),
                  filteredTasks.length === 0
                    ? h('div', { className: 'wb-empty' }, 'No tasks in this view')
                    : h('div', null, filteredTasks.map((t) => h('div', { key: t.id, className: 'wb-row' },
                        h('button', {
                          className: 'wb-row-main', type: 'button',
                          'aria-label': `${t.done === true ? 'Reopen' : 'Complete'} ${t.title}`,
                          onClick: () => toggleTask(t),
                        },
                          h('span', { 'aria-hidden': true }, t.done === true ? '☑' : '☐'),
                          h('span', { style: { flex: 1, textDecoration: t.done === true ? 'line-through' : 'none' } }, t.title),
                          t.priority === 'high' ? h('span', { className: 'wb-badge' }, 'High') : null,
                          t.dueAt ? h('span', { className: 'wb-tertiary', style: { fontSize: '12px' } }, String(t.dueAt).slice(0, 10)) : null),
                        h('button', { className: 'wb-btn', type: 'button', 'aria-label': `Details of ${t.title}`, onClick: () => setSelected({ kind: 'task', ...t }) }, '…'))))))

          , h('div', { className: 'wb-side wb-scroll' },
              selected === null
                ? h('div', { className: 'wb-empty' }, 'Select an event or task to see details')
                : h('div', null,
                    h('h2', null, selected.title ?? '(untitled)'),
                    h('div', { className: 'wb-muted' }, selected.kind === 'task' ? 'Task' : 'Event'),
                    h('dl', null,
                      h('dt', { className: 'wb-tertiary' }, 'ID'),
                      h('dd', null, selected.id),
                      selected.dueAt ? h('dt', { className: 'wb-tertiary' }, 'Due') : null,
                      selected.dueAt ? h('dd', null, selected.dueAt) : null,
                      selected.start ? h('dt', { className: 'wb-tertiary' }, 'Start') : null,
                      selected.start ? h('dd', null, selected.start) : null,
                      selected.description ? h('dt', { className: 'wb-tertiary' }, 'Description') : null,
                      selected.description ? h('dd', null, selected.description) : null,
                      selected.recurrence ? h('dt', { className: 'wb-tertiary' }, 'Repeats') : null,
                      selected.recurrence ? h('dd', null, `${selected.recurrence.freq ?? 'custom'}${selected.recurrenceOccurrences ? ` · ${selected.recurrenceOccurrences} occurrence(s) in next 7 days` : ''}`) : null,
                      selected.conflict === true ? h('dt', { className: 'wb-tertiary' }, 'Conflict') : null,
                      selected.conflict === true ? h('dd', { className: 'wb-status-error' }, 'Overlaps another event') : null,
                      selected.subtasks ? h('dt', { className: 'wb-tertiary' }, 'Subtasks') : null,
                      selected.subtasks ? h('dd', null, h('ul', null,
                        (Array.isArray(selected.subtasks) ? selected.subtasks : []).map((st, i) =>
                          h('li', { key: i }, typeof st === 'string' ? st : (st.title ?? JSON.stringify(st)))))) : null,
                      h('dt', { className: 'wb-tertiary' }, 'AI session'),
                      h('dd', null, 'Shared with the current Agent session (same Host Service)')),
                    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '16px' } },
                      h('button', {
                        className: 'wb-btn', type: 'button',
                        onClick: () => setEditing({ kind: selected.kind === 'task' ? 'task' : 'event', data: selected }),
                      }, 'Edit'),
                      h('button', {
                        className: 'wb-btn wb-btn-danger', type: 'button',
                        onClick: () => setConfirming({ kind: selected.kind ?? 'event', id: selected.id, label: selected.title ?? '' }),
                      }, 'Delete…'),
                      h('button', { className: 'wb-btn', type: 'button', onClick: () => setSelected(null) }, 'Close'))))),

        confirming !== null
          ? h(ConfirmDelete, {
              label: confirming.label, approving,
              onConfirm: () => deleteWithApproval(confirming.kind, confirming.id),
              onCancel: () => setConfirming(null),
            })
          : null)
    }

    // --------------------------------------------------------------- 注册
    return {
      inject: ['slots', 'remote', 'sessions', 'locale'],
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
            label: () => 'Workbench',
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
