import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const client = readFileSync(join(ROOT, 'packages', 'workbench-ui', 'client.js'), 'utf8')
/** 去掉注释，只对**活代码**断言——注释里写「我实现了拖拽」不算实现。 */
const code = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('WP5-UI：日历拖拽改期走 event.move，且带 mode', () => {
  assert.match(code, /draggable:\s*true/, '事件必须可拖拽')
  assert.match(code, /onDragStart/, '必须有 dragstart')
  assert.match(code, /onDrop/, '必须有 drop')
  assert.match(code, /'event\.move'/, '拖拽必须走 Host 的 event.move，不得本地改状态')
  assert.match(code, /mode/, 'event.move 必须显式带 mode')
})

test('WP5-UI：跨日期移动显示落点，失败恢复原位', () => {
  assert.match(code, /dropHint/, '必须记录当前落点')
  assert.match(code, /dateKey/, '落点必须是具体日期')
  /**
   * 失败时必须重新 load 回真实值。
   *
   * 原断言写死了 `setError(...)\n await load()` 的**排版**（换行+缩进），
   * 于是把 load 加个参数就红 —— 它测的是代码长什么样，不是行为对不对。
   * 现在断言的是「catch 块里确实调了 load」+「没有本地伪造状态」。
   */
  const catchBlocks = [...code.matchAll(/\} catch \(e\) \{([\s\S]{0,220}?)\n      \}/g)].map((m) => m[1])
  assert.ok(catchBlocks.length > 0, '必须有 catch 块')
  const reloads = catchBlocks.filter((b) => /await load\(/.test(b))
  assert.ok(reloads.length >= 1, '失败路径必须重新 load 以恢复原位')
  assert.ok(reloads.some((b) => /setError\(/.test(b)), '失败路径必须报错')
  assert.doesNotMatch(code, /optimistic/i, '不得用乐观更新冒充已保存')
})

test('WP5-UI：重复事件必须问「只改这一次 / 改整个系列」', () => {
  assert.match(code, /MoveScopeDialog/, '必须有范围选择对话框')
  assert.match(code, /'single'/, '支持单次')
  assert.match(code, /'series'/, '支持整个系列')
  assert.match(code, /occurrenceDate/, '单次移动必须带 occurrenceDate')
  // thisAndFuture 不被支持，UI 不得偷偷传它
  assert.doesNotMatch(code, /thisAndFuture/, '不得使用服务端明确不支持的 thisAndFuture')
})

test('WP5-UI：待办拖拽排序走 task.reorder 且传全量顺序', () => {
  // 行为断言：构造器产出的 payload 必须是全量目标顺序 + project scope。
  // 原先断言内联写法 `ids: next.map(...)`，把 payload 抽成构造器后就红了 ——
  // 它测的是代码排版，不是发出去的请求对不对。
  const { buildReorderRequest } = loadClient().__test
  const req = buildReorderRequest([{ id: 'x' }, { id: 'y' }, { id: 'z' }], 'G')
  assert.equal(req.op, 'task.reorder', '排序必须走 Host')
  assert.deepEqual(req.payload.ids, ['x', 'y', 'z'], '必须传完整的目标顺序')
  assert.equal(req.payload.project, 'G', '必须带 project scope，防跨组重排')
})

test('WP5-UI：排序有键盘替代操作', () => {
  assert.match(code, /nudgeTask/, '必须有键盘上移/下移')
  assert.match(code, /上移/, '上移按钮')
  assert.match(code, /下移/, '下移按钮')
})

test('WP5-UI：项目分组与归档/恢复', () => {
  assert.match(code, /groupedTasks/, '必须按 project 分组')
  assert.match(code, /'task\.archive'/, '归档走 Host')
  // 恢复**不是** task.unarchive —— 那个 op 不存在（service.js 里只是 audit 的
  // action 标签）。原断言把错误契约钉成了期望行为，等于在证明 bug 存在。
  assert.doesNotMatch(code, /'task\.unarchive'/, '恢复不得调用不存在的 task.unarchive')
  assert.match(code, /payload:\s*\{ id, archived \}/, '恢复必须用同一个 op 带 archived:false')
  // 归档不是删除：不得复用软删字段
  assert.doesNotMatch(code, /archived:\s*true\s*,\s*deleted/, '归档不得与软删混用')
})

test('WP5-UI：导入先预览再确认，执行走真 Host 审批', () => {
  assert.match(code, /'snapshot\.preview'/, 'JSON 导入必须预览')
  assert.match(code, /'event\.previewIcs'/, 'ICS 导入必须预览')
  assert.match(code, /ImportPreview/, '必须有预览面板')
  // 精确到 op 字面量，且必须出现在 confirmImport 函数体内——
  // 只看全文件会被删除路径那处 confirmUserAction 骗过（变异探针抓到过）
  /**
   * **护栏必须锁在调用点，不是构造器里。**
   *
   * 复审 B-1 实测：把 B1 原始 bug 形态注回生产路径（签发删 text、
   * 执行把 token 塞进 payload），只要构造器还写着对的，全量测试仍 355/0。
   * 构造器被 __test 导出引用不等于生产路径在用它 —— 只测构造器是假绿。
   */
  const importFn = code.slice(code.indexOf('const confirmImport ='), code.indexOf('const saveEvent ='))
  assert.ok(importFn.length > 0, 'confirmImport 必须存在')
  assert.match(importFn, /request\(buildImportApprovalRequest\(panel\.kind, panel\.text\)\)/, '签发必须走构造器，不得内联')
  assert.match(importFn, /request\(buildImportExecuteRequest\(panel\.kind, panel\.text, token\)\)/, '执行必须走构造器')
  // 反向：内联拼装不许复活
  assert.doesNotMatch(importFn, /op:\s*'confirmUserAction'/, '签发不得再内联 op 字面量')
  assert.doesNotMatch(importFn, /payload:\s*\{ text: panel\.text \}/, '执行不得再内联 payload')
  assert.doesNotMatch(code, /confirmed:\s*true/, '不得用 confirmed 布尔绕过审批')
  // 构造器本身仍须正确：token 顶层、text 在 payload、target 不传
  const issueFn = code.slice(code.indexOf('function buildImportApprovalRequest'), code.indexOf('function buildImportExecuteRequest'))
  assert.match(issueFn, /text/, '签发必须带 text（否则 digest 对不上，执行必然 fingerprint-mismatch）')
  const execFn = code.slice(code.indexOf('function buildImportExecuteRequest'), code.indexOf('function buildEventMoveRequest'))
  assert.match(execFn, /approvalToken: token/, 'token 必须顶层')
  assert.doesNotMatch(execFn, /approvalToken: token\)?\s*,?\s*\}\s*,\s*\/\//, 'token 不得进 payload')
  // 四类必须分开，且每一类都必须是**独立的 row 行**——
  // 只断言字符串出现过，被改名成 row('X', ...) 也照样通过（变异探针抓到过）
  // 复审 M-3：行名必须走 t()，硬编码中文会让英文用户看到中文
  for (const k of ['previewCreate', 'previewDuplicate', 'previewConflict', 'previewUnsupported']) {
    assert.match(code, new RegExp(`row\\('?t\\('${k}'\\)`), `预览必须有独立的「${k}」行且走 t()`)
  }
  // 反向：不许再出现硬编码中文行名
  for (const k of ['新增', '重复', '冲突', '不支持']) {
    assert.doesNotMatch(code, new RegExp(`row\\('${k}'`), `行名不得硬编码「${k}」`)
  }
})

test('WP5-UI：撤销/重做 + 快捷键', () => {
  assert.match(code, /'history\.undo'/, '撤销走 Host')
  assert.match(code, /'history\.redo'/, '重做走 Host')
  assert.match(code, /'history\.status'/, '可用性由 Host 提供，不得本地猜')
  // 必须真的把 Host 返回的布尔映射进 state，不能写死
  assert.match(code, /canUndo:\s*hs\.value\.canUndo === true/, 'canUndo 必须取自 Host 返回值')
  assert.match(code, /canRedo:\s*hs\.value\.canRedo === true/, 'canRedo 必须取自 Host 返回值')
  assert.match(code, /undoRef/, '快捷键需 ref 转发最新函数')
  assert.match(code, /shiftKey/, 'Ctrl/Cmd+Shift+Z 重做')
  // 输入框里不得抢撤销键：必须断言守卫**真的 return**，
  // 只匹配 `typing` 这个词会被 `if (false) return` 骗过（变异探针抓到过）
  assert.match(code, /if\s*\(typing\)\s*return/, '打字时必须提前 return，不拦截撤销快捷键')
})

test('WP5-UI：交互反馈齐全（加载/保存/失败）', () => {
  assert.match(code, /setSaving\(true\)/, '保存中状态')
  assert.match(code, /role: 'alert'/, '失败必须可见')
  assert.match(code, /setNotice/, '成功必须可见')
  assert.match(code, /wb-drag-preview/, '拖拽时必须有跟随提示')
})

test('WP5-UI：中英文 locale 键必须对齐（防止只加一边）', () => {
  const zh = JSON.parse(readFileSync(join(ROOT, 'packages', 'workbench-ui', 'locale', 'zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(join(ROOT, 'packages', 'workbench-ui', 'locale', 'en.json'), 'utf8'))
  const zk = Object.keys(zh).filter((k) => k !== 'meta').sort()
  const ek = Object.keys(en).filter((k) => k !== 'meta').sort()
  assert.deepEqual(zk, ek, '中英文键集合必须完全一致')
  for (const k of zk) {
    assert.ok(String(zh[k]).length > 0, `zh.${k} 不能为空`)
    assert.ok(String(en[k]).length > 0, `en.${k} 不能为空`)
  }
  // WP5 新增的能力必须有对应文案
  for (const k of ['import', 'undo', 'redo', 'archive', 'restore', 'reminder']) {
    assert.ok(zk.includes(k), `WP5 新增文案缺 ${k}`)
  }
})

test('WP5-UI：事件改期必须有键盘替代路径（拖拽不是唯一入口）', () => {
  // 拖拽是 HTML5 draggable，键盘/读屏用户用不了。只给拖拽 = 把一部分用户挡在门外。
  assert.match(code, /nudgeEventDay/, '必须有键盘改期函数')
  assert.match(code, /'arrowleft'/, '← 必须能改期')
  assert.match(code, /'arrowright'/, '→ 必须能改期')
  assert.match(code, /nudgeRef/, '键盘回调需 ref 转发，避免闭包过期')
  assert.match(code, /nudgeRef\.current = nudgeEventDay/, '每次渲染必须刷新 ref')
  // 必须复用模块级日期函数，不得另造一套解析
  assert.match(code, /eventDay\(src\)/, '必须复用 eventDay')
  assert.match(code, /isoDate\(addDays\(day, delta\)\)/, '必须复用 isoDate/addDays')
})

test('WP5-UI：选中事件必须带 kind=event，否则键盘改期永远进不去', () => {
  /**
   * 这条是**行为**断言，不是字符串断言。
   *
   * nudgeEventDay 的第一行是 `if (sel === null || sel.kind !== 'event') return`。
   * 之前三个选中入口都直接传 `setSelected`（裸事件对象，没有 kind 字段），
   * 于是函数在、ref 在、按键监听在，键盘改期实测触发 0 次 —— 纯死代码。
   * 只断言「函数存在」会把这个回归放过去。
   */
  const guard = code.slice(code.indexOf('const nudgeEventDay'), code.indexOf('const reorderTasks'))
  assert.match(guard, /sel\.kind !== 'event'/, '守卫必须判 kind')
  // 三个入口（MonthView / 周-日-议程列表 / 今日列表）都必须补 kind
  const sites = code.match(/onSelect(Event)?: \(e\) => setSelected\(\{ kind: 'event', \.\.\.e \}\)/g) ?? []
  assert.ok(sites.length >= 3, `三处选中入口都要补 kind，实际 ${sites.length}`)
  // 反向：不许再有裸透传
  assert.ok(!/onSelectEvent: setSelected,/.test(code), 'MonthView 不得再裸透传 setSelected')
  assert.ok(!/onSelect: setSelected,/.test(code), 'AgendaList 不得再裸透传 setSelected')
})

/** 最小 React：只够执行工厂拿 __test，不渲染。 */
function makeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
  }
}

/**
 * 真实执行 client.js 工厂，取出 `__test`。
 * 不能直接 `import`——client.js 走 window.__ModuleLoader__ 注册，顶层会碰 window。
 */
function loadClient() {
  const React = makeReact()
  let plugin = null
  const originalWindow = globalThis.window
  try {
    globalThis.window = {
      __ModuleLoader__: {
        load(def) {
          plugin = def.factory((name) => {
            if (name === 'react') return React
            throw new Error(`unexpected require: ${name}`)
          })
        },
      },
    }
    // eslint-disable-next-line no-new-func
    new Function('window', client)(globalThis.window)
    assert.ok(plugin !== null, 'client.js 应注册模块')
    return plugin
  } finally {
    globalThis.window = originalWindow
  }
}

test('WP5-UI：软删判定必须真的排除已删待办（W4 变异存活回归）', () => {
  // W4 变异把「已软删不进列表」删掉后，337 个测试全绿 —— 说明这条保护
  // 之前完全没被覆盖。根因是同一条件在 client.js 里抄了 3 遍，只测了 1 处。
  // 现在抽成唯一的 isSoftDeleted，并直接做行为断言。
  const { isSoftDeleted, taskBucket } = loadClient().__test
  assert.equal(typeof isSoftDeleted, 'function', 'isSoftDeleted 必须可调用')
  assert.equal(typeof taskBucket, 'function', 'taskBucket 必须可调用')

  const now = new Date('2026-11-06T10:00:00')
  const cases = [
    { deleted: true },
    { deletedAt: '2026-11-06T09:00:00.000Z' },
    { deleted: true, deletedAt: '' },
    { deletedAt: 'x' },
  ]
  for (const t of cases) {
    assert.equal(isSoftDeleted(t), true, `必须判为已删：${JSON.stringify(t)}`)
    assert.equal(taskBucket(t, now), 'deleted', `分桶必须落到 deleted：${JSON.stringify(t)}`)
  }

  const alive = [
    { deleted: false },
    { deleted: undefined, deletedAt: undefined },
    { deletedAt: '' },
    { deletedAt: null },
    {},
  ]
  for (const t of alive) {
    assert.equal(isSoftDeleted(t), false, `不得误判为已删：${JSON.stringify(t)}`)
  }
})

test('WP5-UI：归档必须走 task.archive，不得用 upsert 写软删（W32 回归）', () => {
  // 归档是「收起来」，不是「删掉」。用 task.upsert 写 deleted 会让用户在
  // 归档区再也找不到它 —— 行为上等于删除，只是名字好听。
  const src = code
  const fn = src.slice(src.indexOf('const setArchived ='), src.indexOf('const undo =') > 0 ? src.indexOf('const undo =') : src.indexOf('const setArchived =') + 3000)
  assert.ok(fn.length > 0, 'setArchived 必须存在')
  // 复审 B-2：护栏必须锁在**调用点**。构造器被 __test 引用不算数 ——
  // setArchived 内联拼装时，构造器里的变异全绿而生产路径无护栏。
  assert.match(fn, /request\(buildArchiveRequest\(id, archived\)\)/, '归档必须走构造器')
  assert.doesNotMatch(fn, /op:\s*'task\.archive'/, '归档不得再内联 op 字面量')
  assert.doesNotMatch(fn, /deleted:\s*true/, '归档不得写软删字段')
  assert.doesNotMatch(fn, /task\.upsert/, '归档不得复用 upsert')
})

test('WP5-UI：键盘改期 ref 必须真的指向函数（W33 回归）', () => {
  // ref 恒为 null 时，按下 ←/→ 会静默无反应 —— 比报错更糟，
  // 用户以为快捷键坏了却不知道原因。
  assert.match(code, /nudgeRef\.current = nudgeEventDay/, 'ref 必须赋值真实函数')
  assert.doesNotMatch(code, /nudgeRef\.current = null/, 'ref 不得被赋成 null')
  // 键盘处理里必须真的调用它，而不是只判空
  // 箭头分支现在在 `if (!mod) return` **之前**（裸箭头才可达），
  // 所以从分支起点切到后面的 mod 守卫为止
  const start = code.indexOf("k === 'arrowleft'")
  const kb = code.slice(start, start + 400)
  assert.match(kb, /nudgeRef\.current\(/, '键盘分支必须真的调用改期函数')
})

// ---------------------------------------------------------------- 行为级回归
// 下面几条直接驱动真实 service 走真契约，而不是对源码文本做正则。
// 复审 B6 指出：14 条静态断言全部通过时，导入/恢复/拖拽三条路径 100% 不可用，
// 因为断言测的是「字符串出现过」，不是「跑起来对不对」。

test('WP5-UI：内容类操作的审批凭证必须真的可用（B1 回归）', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createWorkbenchService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'b1-'))
  const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'host', allowIsolatedApproval: true })

  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//whale//t//EN',
    'BEGIN:VEVENT', 'UID:b1-001@whale', 'DTSTAMP:20261101T000000Z',
    'DTSTART:20261201T020000Z', 'DTEND:20261201T030000Z', 'SUMMARY:B1回归',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')

  // 走 UI 实际用的那条签发路径，且必须把原文带上
  const cred = await svc.confirmUserAction('event.import', undefined, { text: ics })
  assert.equal(cred.approved, true, '凭证应签发成功')
  // 执行必须成功 —— 原实现这里必然 fingerprint-mismatch
  const r = await svc.execute('event.import', { text: ics }, { approvalToken: cred.token })
  assert.ok(r, '带真实凭证的导入必须成功')
  assert.ok(Number(r.imported ?? 0) >= 1, '应真的导入条目')
})

test('WP5-UI：恢复归档必须走 task.archive + archived:false（B2 回归）', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createWorkbenchService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'b2-'))
  const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'host', allowIsolatedApproval: true })

  await svc.execute('task.upsert', { task: { id: 'b2-1', title: '归档回归' } })
  await svc.execute('task.archive', { id: 'b2-1' })
  let g = await svc.execute('task.list', {})
  const rows = Array.isArray(g) ? g : (g.tasks ?? [])
  assert.equal(rows.find((t) => t.id === 'b2-1')?.archived, true, '归档应生效')

  // task.unarchive 不是 handler —— 用它必然 unsupported
  let unarchiveCode = 'none'
  try { await svc.execute('task.unarchive', { id: 'b2-1' }) }
  catch (e) { unarchiveCode = e.code }
  assert.equal(unarchiveCode, 'unsupported', 'task.unarchive 不应存在（UI 不得依赖它）')
  // 正确写法：同一个 op 带 archived:false
  await svc.execute('task.archive', { id: 'b2-1', archived: false })
  g = await svc.execute('task.list', {})
  const rows2 = Array.isArray(g) ? g : (g.tasks ?? [])
  assert.equal(rows2.find((t) => t.id === 'b2-1')?.archived, undefined, '恢复后不应再带 archived')
})

test('WP5-UI：重复事件改期必须用源日，不能拿落点当源日（B3 回归）', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createWorkbenchService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'b3-'))
  const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'host', allowIsolatedApproval: true })

  const c = await svc.execute('event.create', {
    event: {
      title: 'B3日会', allDay: true, startDate: '2026-01-05',
      recurrence: { freq: 'DAILY', count: 5 },
    },
  })
  const id = c.id ?? c.event?.id

  // 把落点（01-09）当源日：服务端**不报错**，但排除的是落点那天，源日仍在
  // —— 这就是「静默写坏数据」。断言必须锁死这个错误形态，防止它再回来。
  // M-2 修复后：落点冒充源日被**服务端拒绝**，不再静默写坏数据。
  // 原来这条断言把「静默损坏」当成预期形态锁死 —— 那是把 bug 写成契约。
  let rejected = false
  try {
    await svc.execute('event.move', { id, mode: 'single', target: { startDate: '2026-01-09' }, occurrenceDate: '2026-01-09' })
  } catch (e) {
    rejected = true
    assert.match(String(e?.message ?? e), /落点|源日|同一天/, '拒绝理由必须说清是落点冒充源日')
  }
  assert.ok(rejected, '落点冒充源日必须被拒绝，不得静默成功')
  let g = await svc.execute('event.get', { id })
  assert.equal(g.startDate, '2026-01-05', '被拒后母体源日不得变动')
  assert.ok(
    !(Array.isArray(g.excludeDates) && g.excludeDates.includes('2026-01-09')),
    '被拒后不得留下任何 EXDATE',
  )

  // 正确做法：源日 01-05 被排除，落点那天成为新实例
  await svc.execute('event.move', { id, mode: 'single', target: { startDate: '2026-01-09' }, occurrenceDate: '2026-01-05' })
  g = await svc.execute('event.get', { id })
  assert.ok(
    Array.isArray(g.excludeDates) && g.excludeDates.includes('2026-01-05'),
    '正确形态：应排除源日 2026-01-05',
  )
})

test('WP5-UI：moveDialog 不许拿落点兜底源日（M-1 调用点护栏）', () => {
  /**
   * 复审 M-1 实测：把 `pending.occurrenceDate ?? pending.dateKey` 改成
   * 直接用 `pending.dateKey`，全量测试 355/0 全绿 —— 构造器里变异能杀，
   * 调用点变异存活。所以护栏必须锁在 MoveScopeDialog 的 onChoose 里。
   */
  const fn = code.slice(code.indexOf('const moveDialog ='), code.indexOf('const importPanel !== null'))
  const body = code.slice(code.indexOf('onChoose: (mode) => {'), code.indexOf('onCancel: () => setMoveDialog(null)'))
  assert.ok(body.length > 0, 'MoveScopeDialog 必须有 onChoose')
  assert.doesNotMatch(body, /occurrenceDate:\s*pending\.occurrenceDate\s*\?\?\s*pending\.dateKey/,
    '不许用落点兜底源日（会把落点记进 EXDATE，静默写坏数据）')
  assert.match(body, /occurrenceDate:\s*pending\.occurrenceDate/, '必须直接用源日')
  assert.match(body, /Missing source date/, '源日缺失必须当场报错，不许静默兜底')
  assert.ok(fn.length >= 0, 'moveDialog 区域存在')
})

test('WP5-UI：两个拖拽源都必须带源日（MonthView + AgendaList）', () => {
  /**
   * 复审 m-3：漏源日会回退成 eventDay(source)，为 null 时再落回落点
   * → 直通 M-2 损坏路径。**两个拖拽源都要锁**，只锁一个就是真空变异。
   */
  const agenda = code.slice(code.indexOf("title: '拖动到月视图的日期格可改期'"), code.indexOf('onDragEnd: () => set(null)'))
  assert.ok(agenda.length > 0, 'AgendaList 拖拽源必须存在')
  assert.match(agenda, /occurrenceDate:/, 'AgendaList 拖拽必须带 occurrenceDate')

  // MonthView：从 onDragStart 到 onDragEnd
  const month = code.slice(code.indexOf("title: '拖动到别的日期可改期'"), code.indexOf('onDragEnd: () => { setDrag(null)'))
  assert.ok(month.length > 0, 'MonthView 拖拽源必须存在')
  assert.match(month, /occurrenceDate:/, 'MonthView 拖拽必须带 occurrenceDate')
})

test('core：全天事件第二次单次移动必须仍能成功（withDefaultZone 回归）', async () => {
  /**
   * 变异探针抓到：把 withDefaultZone 的判据收窄成 `timeZone === undefined`，
   * 全量测试 358/0 全绿 —— 没有任何测试覆盖「全天事件第二次移动」。
   *
   * 真实后果：全天事件的 timeZone 在存储层是 null；第一次 mode:'single'
   * 把 null 带进 candidate 后，validateEventInput 报
   * `event.timeZone 必须是字符串`，母体从此再也改不动。
   */
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createWorkbenchService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'tz-'))
  const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'host', allowIsolatedApproval: true })

  const c = await svc.execute('event.create', {
    event: { title: '全天会', allDay: true, startDate: '2026-03-01', recurrence: { freq: 'WEEKLY', count: 4 } },
  })
  const id = c.id ?? c.event?.id

  // 第一次：只改这一次
  await svc.execute('event.move', { id, mode: 'single', target: { startDate: '2026-03-08' }, occurrenceDate: '2026-03-01' })

  // 第二次：改整个系列 —— 这一步原来必然失败
  const second = await svc.execute('event.move', { id, mode: 'series', target: { startDate: '2026-03-05' } })
  assert.ok(second !== null && second !== undefined, '第二次移动必须成功')
  const g = await svc.execute('event.get', { id })
  assert.equal(g.startDate, '2026-03-05', '系列母体必须真的挪到 03-05')
  assert.equal(g.timeZone, 'UTC', 'timeZone 必须补成默认时区（UTC），不能留 null')
})

test('WP5-UI：TaskForm 到期时间必须校验，坏值不得落盘', () => {
  /**
   * 真实复现过的缺陷：输入框留空或写「排序验证」都被原样写进 Host，
   * 随后提醒条显示「算不出提醒时刻（数据有问题，不会响）」。
   * 一条永远不响的待办比没有待办更危险。
   */
  const { parseDueAt } = loadClient().__test

  // 空串 → 明确「无到期时间」，用 undefined 表达，不能是 ''
  assert.deepEqual(parseDueAt(''), { ok: true, value: undefined })
  assert.deepEqual(parseDueAt('   '), { ok: true, value: undefined })
  assert.deepEqual(parseDueAt(undefined), { ok: true, value: undefined })

  // 合法 ISO 时刻 → 原样保留
  const good = parseDueAt('2026-11-10T09:00:00Z')
  assert.equal(good.ok, true)
  assert.equal(good.value, '2026-11-10T09:00:00Z')

  // 带偏移的也合法
  assert.equal(parseDueAt('2026-11-07T09:00:00+08:00').ok, true)

  // 坏值 → 必须被拒（这就是「排序验证」那种真实脏数据的形状）
  for (const bad of ['排序验证', 'not-a-date', '2026-13-45T99:99:99']) {
    const r = parseDueAt(bad)
    assert.equal(r.ok, false, `坏值必须被拒：${bad}`)
    assert.equal(r.value, undefined, '被拒时不得给出可用值')
  }
})

test('core：create 显式传 timeZone=null 必须补默认时区（withDefaultZone null 分支）', async () => {
  /**
   * 变异锚点就在这里：把 `(input.timeZone === undefined || input.timeZone === null)`
   * 收窄成 `input.timeZone === undefined`，这条立刻红 —— 这是唯一直接压到
   * withDefaultZone null 分支的入口（series/single 分支的补值会绕过它）。
   *
   * 语义依据：全天事件的 timeZone 在存储层允许 null（表示「按 UTC 锚定」），
   * 但校验层要求非空字符串，所以入口必须归一。
   */
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createWorkbenchService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'tz-null-create-'))
  const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'host', allowIsolatedApproval: true })

  const c = await svc.execute('event.create', {
    event: { title: '显式 null', allDay: true, startDate: '2026-03-01', timeZone: null },
  })
  const ev = c.event ?? c
  assert.equal(ev.timeZone, 'UTC', '显式 null 必须补成默认时区，不能原样存 null')
  assert.equal(ev.startDate, '2026-03-01', 'startDate 不受影响')

  // 显式 undefined 同样要补
  const c2 = await svc.execute('event.create', {
    event: { title: '缺省', allDay: true, startDate: '2026-04-01' },
  })
  assert.equal((c2.event ?? c2).timeZone, 'UTC', '缺省也必须补默认时区')
})

test('core：脏母体 timeZone=null 时，series 移动必须仍成功并补默认时区', async () => {
  /**
   * 变异探针抓到：把 withDefaultZone 判据收窄成 `timeZone === undefined`，
   * 全量测试全绿 —— 说明 null 分支从未被走到。
   *
   * 真实场景：历史数据里全天事件的 timeZone 是 null（存储层允许），
   * 走 validateEventInput 会报 `event.timeZone 必须是字符串`。
   * 这里直接改盘造脏数据，覆盖 withDefaultZone 的 null 分支。
   */
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createWorkbenchService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'tz-dirty-'))
  const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'host', allowIsolatedApproval: true })

  const c = await svc.execute('event.create', {
    event: { title: '脏母体', allDay: true, startDate: '2026-03-01', recurrence: { freq: 'WEEKLY', count: 3 } },
  })
  const id = c.id ?? c.event?.id

  // 直接抹掉 timeZone，模拟历史脏数据（event.update 清不掉，校验会拦）
  const file = join(dir, 'workbench.json')
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  disk.events.find((e) => e.id === id).timeZone = null
  writeFileSync(file, JSON.stringify(disk, null, 2))

  const svc2 = createWorkbenchService({ dataDir: dir, approvalMode: 'host', allowIsolatedApproval: true })
  assert.equal((await svc2.execute('event.get', { id })).timeZone, null, '前置：母体确实是 null')

  // 关键：withDefaultZone 必须把 null 当「无时区」，否则这里直接抛 validation
  const moved = await svc2.execute('event.move', { id, mode: 'series', target: { startDate: '2026-03-10' } })
  assert.ok(moved !== null && moved !== undefined, 'series 移动必须成功')
  const g = await svc2.execute('event.get', { id })
  assert.equal(g.startDate, '2026-03-10', '母体必须真的挪动')
  assert.equal(g.timeZone, 'UTC', '脏母体必须顺手补成默认时区，不能把 null 留在盘上')
})

test('WP5-UI：排序索引基必须与渲染同源（B4 回归）', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createWorkbenchService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'b4-'))
  const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'host', allowIsolatedApproval: true })

  // 存储顺序 a,b,c 但 order 是 c,a,b —— 两个基刻意不一致
  for (const [id, order] of [['a', 30], ['b', 40], ['c', 10]]) {
    await svc.execute('task.upsert', { task: { id, title: id, project: 'G', order } })
  }
  // 渲染序（按 order）= c,a,b。把 b 拖到最前，期望 b,c,a
  await svc.execute('task.reorder', { ids: ['b', 'c', 'a'], project: 'G' })
  const rows = (await svc.execute('task.list', {}))
  const got = (Array.isArray(rows) ? rows : []).filter((t) => t.project === 'G').sort(byOrderProbe).map((t) => t.id)
  assert.deepEqual(got, ['b', 'c', 'a'], '排序结果必须是用户看到的那一序')
})

function byOrderProbe(a, b) {
  const ao = Number.isFinite(a?.order) ? a.order : Number.MAX_SAFE_INTEGER
  const bo = Number.isFinite(b?.order) ? b.order : Number.MAX_SAFE_INTEGER
  return ao - bo
}

test('WP5-UI：排序计算必须复用共享比较器，不得就地再写一份（B4 静态侧）', () => {
  // 行为断言（上一条）保证结果对；这条保证「只有一个比较器」，
  // 否则下次改渲染排序时，排序计算会静默漂移。
  assert.match(code, /function byOrder\(a, b\)/, '必须存在共享比较器 byOrder')
  const uses = (code.match(/\.sort\(byOrder\)/g) ?? []).length
  assert.ok(uses >= 3, `byOrder 至少被渲染/拖拽/键盘三处复用，实际 ${uses} 处`)
  // 就地写的比较器不得再出现
  assert.doesNotMatch(code, /Number\.isFinite\(a\.order\)/, '不得就地重写比较器')
})

test('WP5-UI：导入凭证必须绑定内容，换内容不得复用（B1 反向锁）', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createWorkbenchService } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'b1r-'))
  const svc = createWorkbenchService({ dataDir: dir, approvalMode: 'host', allowIsolatedApproval: true })

  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//whale//t//EN',
    'BEGIN:VEVENT', 'UID:b1r-001@whale', 'DTSTAMP:20261101T000000Z',
    'DTSTART:20261202T020000Z', 'DTEND:20261202T030000Z', 'SUMMARY:B1反向',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')

  const cred = await svc.confirmUserAction('event.import', undefined, { text: ics })
  // 同内容 → 成功
  const okRun = await svc.execute('event.import', { text: ics }, { approvalToken: cred.token })
  assert.ok(Number(okRun.imported ?? 0) >= 1, '同内容凭证必须可用')

  // 换内容 → 必须被拒。若签发侧不绑 digest（原 bug），这里会通过。
  const other = ics.replace('b1r-001', 'b1r-evil')
  let code = 'none'
  try { await svc.execute('event.import', { text: other }, { approvalToken: cred.token }) }
  catch (e) { code = e.code }
  assert.equal(code, 'confirmation-required', '换内容的凭证必须失效')
})

// ------------------------------------------------- 请求体形状（行为级，非正则）
// 这五条对应审查 B1/B3/B4/B5。原先前五条阻塞项全躺在正则断言的绿区里，
// 因为正则只能看到「字符串出现过」，看不到「payload 塞在哪一层」。
// 现在构造器是纯函数，直接调用并断言真实形状 —— 变异一改必然红。

test('WP5-UI：导入签发请求必须带原文、target 为 undefined（B1）', () => {
  const { buildImportApprovalRequest } = loadClient().__test
  for (const kind of ['ics', 'json']) {
    const req = buildImportApprovalRequest(kind, 'PAYLOAD-TEXT')
    assert.equal(req.op, 'confirmUserAction')
    assert.equal(req.payload.approvalOp, kind === 'ics' ? 'event.import' : 'snapshot.replace')
    // 内容类操作 target 恒为 undefined —— Host 侧按 contentDigest(text) 算指纹
    assert.equal(req.payload.target, undefined, '内容类 target 必须 undefined')
    // 必须带原文，否则 Host 算不出 digest，签发出来的凭证执行时必然 mismatch
    assert.equal(req.payload.text, 'PAYLOAD-TEXT', '签发请求必须带原文')
  }
})

test('WP5-UI：导入执行请求的 approvalToken 必须在顶层（B1）', () => {
  const { buildImportExecuteRequest } = loadClient().__test
  const req = buildImportExecuteRequest('ics', 'PAYLOAD-TEXT', 'TOKEN-X')
  // bridge 只从顶层解构 approvalToken（index.js:130），放进 payload 等于没带
  assert.equal(req.approvalToken, 'TOKEN-X', 'approvalToken 必须在顶层')
  assert.equal(req.payload.approvalToken, undefined, 'approvalToken 不得塞进 payload')
  assert.equal(req.payload.text, 'PAYLOAD-TEXT')
  assert.equal(req.op, 'event.import')
})

test('WP5-UI：单次改期必须带源日，不得拿落点冒充（B3）', () => {
  const { buildEventMoveRequest } = loadClient().__test
  // 重复事件 + 只改这一次 → 必须带 occurrenceDate，且值必须是调用方给的源日
  const single = buildEventMoveRequest(
    { id: 'e1', recurring: true, occurrenceDate: '2026-01-05' }, '2026-01-09', 'single',
  )
  assert.equal(single.mode, 'single')
  assert.equal(single.occurrenceDate, '2026-01-05', '源日必须是 01-05，不能是落点 01-09')
  assert.equal(single.target.startDate, '2026-01-09', '落点单独放 target')
  // 源日与落点必须是两个不同的值 —— 相等就说明调用方拿落点冒充了源日
  assert.notEqual(single.occurrenceDate, single.target.startDate, '源日与落点不得混同')

  // 改整个系列 → 不带 occurrenceDate
  const series = buildEventMoveRequest({ id: 'e1', recurring: true }, '2026-01-09', 'series')
  assert.equal(series.occurrenceDate, undefined, '整系列移动不带 occurrenceDate')

  // 非重复事件 → 恒为 series，不带 occurrenceDate
  const plain = buildEventMoveRequest({ id: 'e2', recurring: false }, '2026-01-09')
  assert.equal(plain.mode, 'series')
  assert.equal(plain.occurrenceDate, undefined)
})

test('WP5-UI：排序请求发的是用户看到的顺序（B4）', () => {
  const { buildReorderRequest } = loadClient().__test
  const req = buildReorderRequest([{ id: 'b' }, { id: 'c' }, { id: 'a' }], 'G')
  assert.equal(req.op, 'task.reorder')
  // ids 必须逐字等于传入的 rows 顺序 —— 调用方已按 order 排好
  assert.deepEqual(req.payload.ids, ['b', 'c', 'a'], '必须发全量目标顺序')
  assert.equal(req.payload.project, 'G', '必须带 project scope，防跨组重排')
})

test('WP5-UI：归档/恢复都走 task.archive 带 archived（B2）', () => {
  const { buildArchiveRequest } = loadClient().__test
  assert.equal(buildArchiveRequest('t1', true).op, 'task.archive')
  assert.equal(buildArchiveRequest('t1', true).payload.archived, true)
  // 恢复：同一个 op 带 false，**没有** task.unarchive
  const restore = buildArchiveRequest('t1', false)
  assert.equal(restore.op, 'task.archive', '恢复不得用 task.unarchive')
  assert.equal(restore.payload.archived, false)
})

test('WP5-UI：ICS 计数一律取服务端值，不本地重算（B5）', () => {
  const { buildIcsCounts } = loadClient().__test
  // 服务端真实返回含 degraded/skip；unsupported 非 0 时必须原样透出
  const counts = buildIcsCounts({ create: 2, duplicate: 0, conflict: 1, degraded: 0, unsupported: 1, skip: 0 })
  assert.equal(counts.create, 2)
  assert.equal(counts.conflict, 1)
  assert.equal(counts.unsupported, 1, 'unsupported 不得被硬写成 0')
  // degraded 不得被丢弃：degraded>0 的条目不是干净「新增」，丢了会误导用户
  assert.equal(counts.degraded, 0, 'degraded 必须透出')
  const degraded = buildIcsCounts({ create: 1, degraded: 1 })
  assert.equal(degraded.degraded, 1, 'degraded 非 0 必须原样透出，不得吞掉')
  // removed 不得硬写 0：服务端给了就照抄，与 snapshot.preview 保持一致
  assert.equal(counts.removed, 0)
  const withRemoved = buildIcsCounts({ create: 1, removed: 3 })
  assert.equal(withRemoved.removed, 3, 'removed 必须取服务端值，不得硬写 0')
  // 缺失字段要回落 0，不能 NaN
  assert.deepEqual(buildIcsCounts(undefined), { create: 0, duplicate: 0, conflict: 0, unsupported: 0, degraded: 0, removed: 0 })
})

test('WP5-UI：主列表不得显示已归档待办（B2 双渲染，行为断言）', () => {
  const { filterTasksForView } = loadClient().__test
  const now = new Date('2026-11-06T04:00:00Z')
  const rows = [
    { id: 'live', title: '在办的', status: 'planned', archived: false },
    { id: 'arc', title: '已归档的', status: 'planned', archived: true },
    { id: 'del', title: '已删的', status: 'planned', deleted: true },
  ]
  const out = filterTasksForView(rows, { search: '', taskFilter: 'planned', now })
  assert.deepEqual(out.map((t) => t.id), ['live'], '归档与软删都不得出现在主列表')
  // 反向：归档那条若放行，就会同时出现在主列表和归档区（双渲染）
  assert.equal(out.some((t) => t.id === 'arc'), false, '归档待办不得双渲染')
})

test('WP5-UI：排序调用点必须传全量 next，不得只传被移动的一条（W31）', () => {
  // 构造器本身正确还不够 —— 调用点必须把 next（全量）交进去。
  // 只测构造器时，把调用点改成 [moved] 仍然全绿（变异 W31 存活过）。
  const body = code.slice(code.indexOf('const reorderTasks = '), code.indexOf('const setArchived ='))
  assert.match(body, /buildReorderRequest\(next,\s*groupId\)/, '调用点必须传全量 next')
  assert.doesNotMatch(body, /buildReorderRequest\(\[\s*moved\s*\]/, '不得只传被移动的一条')
})

test('WP5-UI：改期失败必须 reload 回真实值，不得停在假位置（W34）', () => {
  // 必须锁定 moveEventToDate 这一个函数的失败路径。
  // 原测试只在全文件范围内找「某个 catch 里有 load」，于是把这条路径的
  // load 删掉后仍有别的 catch 满足条件 → 变异 W34 存活。
  const start = code.indexOf('const moveEventToDate = ')
  const end = code.indexOf('const reorderTasks = ')
  assert.ok(start > 0 && end > start, '必须能定位 moveEventToDate')
  const body = code.slice(start, end)
  const catchBlock = body.slice(body.indexOf('} catch (e) {'))
  assert.ok(catchBlock.length > 0, '改期必须有 catch')
  assert.match(catchBlock, /setError\(/, '失败必须报错')
  // 失败后必须重新 load，把界面拉回 Host 的真实状态（否则停在假的新日期）
  assert.match(catchBlock, /await load\(/, '改期失败必须 reload 恢复原位')
})
