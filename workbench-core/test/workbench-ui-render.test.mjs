/**
 * WP4：**组件渲染测试**（回应第三轮 Review 的 MAJOR-1）。
 *
 * ## 为什么需要它
 *
 * 第三轮 Review 抓到：`t` 只定义在 WorkbenchPage 内部，而 EventForm /
 * TaskForm / ConfirmDelete 是工厂作用域的兄弟函数 → 渲染即
 * `ReferenceError: t is not defined` → React 卸载整棵子树 → 整页白屏。
 *
 * 现有测试**没有一条渲染组件**：standards 是正则静态断言，bridge 只测
 * callHost。于是「源码长什么样」全绿，而「跑起来对不对」全崩。
 *
 * ## 本文件的做法与边界
 *
 * 这里**不伪造画面**（不模拟 React-DOM 渲染像素、不做截图），
 * 只**真实调用组件函数**以捕获渲染期异常（ReferenceError / TypeError）。
 * 这是正当的单元测试手段；真正的视觉验证仍按 references/verification.md
 * 列为 UNVERIFIED。
 *
 * 组件在 client.js 的工厂闭包里，外部拿不到；client.js 通过 `__test`
 * 导出它们，测试用**真实工厂**执行后取用（不是复刻实现）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CLIENT = new URL('../../packages/workbench-ui/client.js', import.meta.url)
const clientSource = readFileSync(CLIENT, 'utf8')

/** 最小 React：createElement 记录结构；渲染时递归调用函数组件。 */
function makeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
  }
}

/** 执行组件树，返回渲染出的文本片段。函数组件会被真实调用。 */
function render(element) {
  if (element === null || element === undefined || element === false || element === true) return []
  if (typeof element === 'string' || typeof element === 'number') return [String(element)]
  if (Array.isArray(element)) return element.flatMap((e) => render(e))
  if (typeof element !== 'object') return []
  const { type, props, children } = element
  if (typeof type === 'function') return render(type(props))
  return children.flatMap((c) => render(c))
}

/**
 * 真实执行 client.js 的工厂，取出 `__test` 导出的组件与 callHost。
 *
 * client.js 通过 `window.__ModuleLoader__.load({ factory(require) {...} })` 注册，
 * 这里提供最小 React 后执行工厂。
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
    new Function('window', clientSource)(globalThis.window)
    assert.ok(plugin !== null, 'client.js 应注册模块')
    return plugin
  } finally {
    globalThis.window = originalWindow
  }
}

test('WP4：client.js 工厂可执行，且无相对 require', () => {
  const plugin = loadClient()
  assert.equal(typeof plugin.apply, 'function', '插件必须导出 apply')
  const code = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
  assert.equal(
    /require\(['"](\.|\/|\\\\)/.test(code),
    false,
    '不得有相对 require（浏览器模块表只解析包名）',
  )
})

test('WP4：三个弹窗组件渲染不得抛异常（第三轮 BLOCKER-1 守卫）', () => {
  const plugin = loadClient()
  const probe = plugin.__test
  assert.ok(probe !== undefined, 'client.js 必须导出 __test 供测试取用真实组件')
  for (const name of ['EventForm', 'TaskForm', 'ConfirmDelete']) {
    const Comp = probe[name]
    assert.equal(typeof Comp, 'function', `__test 必须导出 ${name}`)
    const props = {
      initial: undefined,
      onSave: () => {},
      onCancel: () => {},
      onConfirm: () => {},
      saving: false,
      approving: false,
      label: 'x',
    }
    assert.doesNotThrow(
      () => render(Comp(props)),
      `${name} 渲染不得抛异常（t 必须在作用域内可见）`,
    )
  }
})

test('WP4：WorkbenchPage 渲染不得抛异常', () => {
  const plugin = loadClient()
  const Comp = plugin.__test.WorkbenchPage
  const ctx = {
    remote: { commands: { execute: async () => ({ ok: true, value: { commandId: 'c', result: { kind: 'success', text: '{"ok":true,"value":[]}' } } }) } },
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
  }
  assert.doesNotThrow(
    () => render(Comp({ ctx })),
    'WorkbenchPage 渲染不得抛异常',
  )
})

test('WP4：t 必须在工厂作用域可见（防止退回 WorkbenchPage 内部）', () => {
  const code = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
  // 工厂层必须有 defaultT
  assert.match(code, /const defaultT = \(key\) =>/, '工厂层必须有 defaultT')
  // 三个组件必须从 props 取 t（带默认），否则会引用作用域外的 t
  for (const name of ['EventForm', 'TaskForm', 'ConfirmDelete']) {
    const marker = `\n    function ${name}(`
    const start = code.indexOf(marker)
    assert.ok(start >= 0, `client.js 必须定义 ${name}`)
    const signature = code.slice(start, code.indexOf(') =>', start))
    assert.match(signature, /t\s*=\s*defaultT/, `${name} 必须从 props 取 t（带默认实现）`)
  }
})

test('WP4：ConfirmDelete 必须收到页面的 t（第四轮 N1，终审 B1）', () => {
  const plugin = loadClient()
  const clientSource = readFileSync(CLIENT, 'utf8')
  // 调用点必须传 t：否则中文界面下确认删除弹窗仍是英文
  assert.match(
    clientSource,
    /h\(ConfirmDelete,\s*\{[^}]*approving,\s*t,/s,
    'ConfirmDelete 调用点必须传入 t',
  )
  // 组件本身必须有 defaultT 兜底
  const probe = plugin.__test
  assert.equal(typeof probe.ConfirmDelete, 'function')
  assert.doesNotThrow(
    () => render(probe.ConfirmDelete({
      label: 'x', onConfirm: () => {}, onCancel: () => {}, approving: false,
    })),
    'ConfirmDelete 无 t 时也必须用 defaultT 兜底，不抛异常',
  )
})
