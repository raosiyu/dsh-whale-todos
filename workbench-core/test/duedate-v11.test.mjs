/**
 * V1.1 · 待办到期时间修复的针对性测试。
 *
 * 缺陷现场：新建待办的表单里「到期时间」是裸文本框 + placeholder
 * `2026-11-10T09:00:00Z`。灰字看起来像已填好，实际 useState 拿到空串，
 * 提交时走 `delete next.dueAt` —— 用户以为设了今天，落库是无截止，
 * 待办掉进「计划中 › 未分组」而不是「今日」。
 *
 * 这里只测修复后的两个纯函数与表单默认值，不复跑历史全量。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const client = readFileSync(join(ROOT, 'packages', 'workbench-ui', 'client.js'), 'utf8')

function makeReact() {
  const h = (tag, props, ...children) => ({ tag, props: props ?? {}, children })
  return {
    h,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    createElement: h,
  }
}

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

function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (typeof node === 'object' && node.tag) {
    out.push(node.tag)
    if (node.props && typeof node.props === 'object') {
      for (const [k, v] of Object.entries(node.props)) {
        if (typeof v === 'string') out.push(v)
        if (typeof v === 'boolean') out.push(`${k}:${v}`)
        if (typeof v === 'number') out.push(String(v))
      }
    }
    flatten(node.children, out)
  }
  return out
}

/** 深搜 h() 树里的 input 节点，按 type 取。 */
function findInputs(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findInputs(n, out); return out }
  if (node.tag === 'input') out.push(node)
  findInputs(node.children, out)
  return out
}

const T = (k) => k

// ------------------------------------------------------------ composeDueAt

test('V1.1：composeDueAt 补本机时区偏移，不是裸墙钟也不是 UTC', () => {
  const { composeDueAt } = loadClient().__test
  const r = composeDueAt('2026-11-10', '09:00')
  assert.match(r, /^2026-11-10T09:00:00[+-]\d{2}:\d{2}$/,
    `必须带偏移后缀，否则服务端 isoInstant 拒收；实际 ${r}`)
})

test('V1.1：composeDueAt 生成的时刻经 Date 解析后本地钟点仍是 09:00', () => {
  const { composeDueAt } = loadClient().__test
  const r = composeDueAt('2026-11-10', '09:00')
  const d = new Date(r)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 10, '月应为 11 月（0 基）')
  assert.equal(d.getDate(), 10, '跨天错位会让待办进错桶')
  assert.equal(d.getHours(), 9)
  assert.equal(d.getMinutes(), 0)
})

test('V1.1：composeDueAt 保留用户选的任意时刻', () => {
  const { composeDueAt } = loadClient().__test
  const r = composeDueAt('2026-12-31', '23:59')
  const d = new Date(r)
  assert.equal(d.getDate(), 31)
  assert.equal(d.getHours(), 23)
  assert.equal(d.getMinutes(), 59)
})

test('V1.1：composeDueAt 拒绝不存在的日期，不默默顺延', () => {
  const { composeDueAt } = loadClient().__test
  assert.equal(composeDueAt('2026-02-31', '09:00'), undefined, '2月31日必须拒绝而不是变成3月3日')
  assert.equal(composeDueAt('2026-13-01', '09:00'), undefined)
})

test('V1.1：composeDueAt 拒绝非法时刻', () => {
  const { composeDueAt } = loadClient().__test
  assert.equal(composeDueAt('2026-11-10', '24:00'), undefined)
  assert.equal(composeDueAt('2026-11-10', '09:60'), undefined)
})

test('V1.1：composeDueAt 对空值返回 undefined（交给上层 delete，不写空串）', () => {
  const { composeDueAt } = loadClient().__test
  assert.equal(composeDueAt('', '09:00'), undefined)
  assert.equal(composeDueAt('2026-11-10', ''), undefined)
  assert.equal(composeDueAt(undefined, undefined), undefined)
})

// -------------------------------------------------------------- splitDueAt

test('V1.1：splitDueAt 按本地时区回填，跨天不错位', () => {
  const { splitDueAt } = loadClient().__test
  // 构造一个 UTC 当日、本地次日的时刻（GMT+8 下 17:00Z 是次日 01:00）
  const local = new Date(2026, 10, 10, 1, 0, 0, 0)
  const iso = local.toISOString()
  const r = splitDueAt(iso)
  assert.equal(r.date, '2026-11-10', `回填日期必须用本地时区，不能用 slice；实际 ${r.date}`)
  assert.equal(r.time, '01:00')
})

test('V1.1：splitDueAt 与 composeDueAt 往返一致', () => {
  const { composeDueAt, splitDueAt } = loadClient().__test
  const iso = composeDueAt('2026-11-10', '09:00')
  const back = splitDueAt(iso)
  assert.equal(back.date, '2026-11-10')
  assert.equal(back.time, '09:00')
})

test('V1.1：splitDueAt 对空值与坏值返回空串，不炸', () => {
  const { splitDueAt } = loadClient().__test
  assert.deepEqual(splitDueAt(undefined), { date: '', time: '' })
  assert.deepEqual(splitDueAt(''), { date: '', time: '' })
  assert.deepEqual(splitDueAt('排序验证'), { date: '', time: '' })
})

// --------------------------------------------------------------- TaskForm

test('V1.1：新建待办时表单真的预填今天，不是只给 placeholder', () => {
  const { TaskForm } = loadClient().__test
  const tree = TaskForm({ initial: undefined, onSave: () => {}, onCancel: () => {}, saving: false, t: T })
  const inputs = findInputs(tree)
  const dateInput = inputs.find((n) => n.props.type === 'date')
  assert.ok(dateInput !== undefined, '必须有真正的 date 控件')
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  assert.equal(dateInput.props.value, today,
    `新建时日期必须预填今天（可见且会被提交）；实际 ${dateInput.props.value}`)
  assert.notEqual(dateInput.props.value, '', '空串是原缺陷的根因')
})

test('V1.1：新建待办表单有 time 控件且默认 09:00', () => {
  const { TaskForm } = loadClient().__test
  const tree = TaskForm({ initial: undefined, onSave: () => {}, onCancel: () => {}, saving: false, t: T })
  const timeInput = findInputs(tree).find((n) => n.props.type === 'time')
  assert.ok(timeInput !== undefined, '必须有 time 控件')
  assert.equal(timeInput.props.value, '09:00')
})

test('V1.1：新建待办表单不再有不带 type 的裸 dueAt 文本框', () => {
  const { TaskForm } = loadClient().__test
  const tree = TaskForm({ initial: undefined, onSave: () => {}, onCancel: () => {}, saving: false, t: T })
  const textInputs = findInputs(tree).filter((n) => n.props.type === undefined || n.props.type === 'text')
  for (const n of textInputs) {
    assert.notEqual(n.props.placeholder, '2026-11-10T09:00:00Z',
      '旧的 ISO placeholder 是误导源：看起来像默认值，实际不提交')
  }
})

test('V1.1：编辑已有待办时回填已存时刻', () => {
  const { TaskForm, composeDueAt } = loadClient().__test
  const iso = composeDueAt('2026-12-25', '18:30')
  const tree = TaskForm({
    initial: { id: 't-1', title: '已有待办', dueAt: iso, priority: 'normal' },
    onSave: () => {}, onCancel: () => {}, saving: false, t: T,
  })
  const inputs = findInputs(tree)
  assert.equal(inputs.find((n) => n.props.type === 'date').props.value, '2026-12-25')
  assert.equal(inputs.find((n) => n.props.type === 'time').props.value, '18:30')
})

test('V1.1：编辑无截止日期的待办时，勾选「无截止」且日期控件禁用', () => {
  const { TaskForm } = loadClient().__test
  const tree = TaskForm({
    initial: { id: 't-2', title: '无截止待办', priority: 'normal' },
    onSave: () => {}, onCancel: () => {}, saving: false, t: T,
  })
  const inputs = findInputs(tree)
  const noDueBox = inputs.find((n) => n.props.type === 'checkbox')
  assert.ok(noDueBox !== undefined, '必须有「无截止日期」开关')
  assert.equal(noDueBox.props.checked, true, '已存的无截止待办必须回填为勾选')
  assert.equal(inputs.find((n) => n.props.type === 'date').props.disabled, true)
})

test('V1.1：新建待办默认不勾「无截止」，否则用户永远进不了今日', () => {
  const { TaskForm } = loadClient().__test
  const tree = TaskForm({ initial: undefined, onSave: () => {}, onCancel: () => {}, saving: false, t: T })
  const noDueBox = findInputs(tree).find((n) => n.props.type === 'checkbox')
  assert.equal(noDueBox.props.checked, false)
})

// ------------------------------------------------------------ 分桶联动

test('V1.1：带今日 dueAt 的待办必须进 today 桶（缺陷的最终表现）', () => {
  const { taskBucket, composeDueAt } = loadClient().__test
  const now = new Date(2026, 10, 10, 12, 0, 0, 0)
  const due = composeDueAt('2026-11-10', '09:00')
  assert.equal(taskBucket({ title: 'x', dueAt: due, status: 'planned' }, now), 'today')
})

test('V1.1：无 dueAt 的待办仍进 planned 桶（不能为了修 bug 破坏原语义）', () => {
  const { taskBucket } = loadClient().__test
  const now = new Date(2026, 10, 10, 12, 0, 0, 0)
  assert.equal(taskBucket({ title: 'x', status: 'planned' }, now), 'planned')
})

test('V1.1：明天的 dueAt 不能误进 today 桶', () => {
  const { taskBucket, composeDueAt } = loadClient().__test
  const now = new Date(2026, 10, 10, 12, 0, 0, 0)
  const due = composeDueAt('2026-11-11', '09:00')
  assert.equal(taskBucket({ title: 'x', dueAt: due, status: 'planned' }, now), 'planned')
})
