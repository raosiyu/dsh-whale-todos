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
  // 失败时不得乐观改本地 events：只能 reload 回真实值
  assert.match(code, /setError\(String\(e\?\.message \?\? e\)\)\s*\n\s*await load\(\)/, '失败必须重新 load 以恢复原位')
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
  assert.match(code, /'task\.reorder'/, '排序必须走 Host')
  assert.match(code, /ids:\s*next\.map/, '必须传完整的目标顺序，不是「挪到谁前面」')
  assert.match(code, /project:\s*groupId/, '必须带 project scope，防跨组重排')
})

test('WP5-UI：排序有键盘替代操作', () => {
  assert.match(code, /nudgeTask/, '必须有键盘上移/下移')
  assert.match(code, /上移/, '上移按钮')
  assert.match(code, /下移/, '下移按钮')
})

test('WP5-UI：项目分组与归档/恢复', () => {
  assert.match(code, /groupedTasks/, '必须按 project 分组')
  assert.match(code, /'task\.archive'/, '归档走 Host')
  assert.match(code, /'task\.unarchive'/, '必须能恢复归档')
  // 归档不是删除：不得复用软删字段
  assert.doesNotMatch(code, /archived:\s*true\s*,\s*deleted/, '归档不得与软删混用')
})

test('WP5-UI：导入先预览再确认，执行走真 Host 审批', () => {
  assert.match(code, /'snapshot\.preview'/, 'JSON 导入必须预览')
  assert.match(code, /'event\.previewIcs'/, 'ICS 导入必须预览')
  assert.match(code, /ImportPreview/, '必须有预览面板')
  // 精确到 op 字面量，且必须出现在 confirmImport 函数体内——
  // 只看全文件会被删除路径那处 confirmUserAction 骗过（变异探针抓到过）
  const importFn = code.slice(code.indexOf('const confirmImport ='), code.indexOf('const saveEvent ='))
  assert.ok(importFn.length > 0, 'confirmImport 必须存在')
  assert.match(importFn, /op:\s*'confirmUserAction'/, '导入执行前必须申请宿主签发的确认凭证')
  assert.match(code, /approvalToken:\s*token/, '执行必须带 token')
  assert.doesNotMatch(code, /confirmed:\s*true/, '不得用 confirmed 布尔绕过审批')
  // 四类必须分开，且每一类都必须是**独立的 row 行**——
  // 只断言字符串出现过，被改名成 row('X', ...) 也照样通过（变异探针抓到过）
  for (const k of ['新增', '重复', '冲突', '不支持']) {
    assert.match(code, new RegExp(`row\\('${k}'`), `预览必须有独立的「${k}」行`)
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
  assert.match(fn, /op: archived \? 'task\.archive' : 'task\.unarchive'/, '归档/恢复必须走专用 op')
  assert.doesNotMatch(fn, /deleted:\s*true/, '归档不得写软删字段')
  assert.doesNotMatch(fn, /task\.upsert/, '归档不得复用 upsert')
})

test('WP5-UI：键盘改期 ref 必须真的指向函数（W33 回归）', () => {
  // ref 恒为 null 时，按下 ←/→ 会静默无反应 —— 比报错更糟，
  // 用户以为快捷键坏了却不知道原因。
  assert.match(code, /nudgeRef\.current = nudgeEventDay/, 'ref 必须赋值真实函数')
  assert.doesNotMatch(code, /nudgeRef\.current = null/, 'ref 不得被赋成 null')
  // 键盘处理里必须真的调用它，而不是只判空
  const kb = code.slice(code.indexOf("k === 'arrowleft'"), code.indexOf("k === 'arrowleft'") + 300)
  assert.match(kb, /nudgeRef\.current\(/, '键盘分支必须真的调用改期函数')
})
