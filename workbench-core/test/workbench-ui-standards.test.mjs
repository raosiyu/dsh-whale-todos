/**
 * WP4-5：UI 规范静态核查（references/verification.md 允许的无浏览器控制检查）。
 *
 * 无浏览器控制时，verification.md 允许：JS 语法、manifest、样式只用 theme
 * tokens、不 import Harness Client 包、无 slot crash 的静态检查。
 * 本测试把授权里的 UI 硬约束变成机器可校验的断言：
 *   - main keyed slot + sidebar.panellist，key 不等于 conversation
 *   - 只用 --dsw-alias-* 令牌，无硬编码颜色
 *   - 不 require Client primitives / 无 iframe / 不写 document.body
 *   - 正文 16px、标题 20–28px、间距 4/8 倍数、点击区 >=44px
 *   - focus-visible、role/aria、键盘（Ctrl/Cmd+K）
 *   - locale meta.title/description（en + zh）、图标存在且 <=256KiB
 *   - manifest exports / dsh.client / files / patch 行
 *
 * ⚠️ 这些是**静态**检查，不证明真实渲染。真实深浅色截图、窗口缩放、
 * 点击交互在 Client Inspect 不可用时列为 UNVERIFIED（见 docs/wp4 报告）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync, existsSync } from 'node:fs'

const ROOT = new URL('../../packages/workbench-ui/', import.meta.url)
const read = (name) => readFileSync(new URL(name, ROOT), 'utf8')
const client = read('client.js')
const host = read('index.js')
/** 去掉块注释与行注释，只留可执行代码，避免文档文字误伤静态断言。 */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1')
const clientCode = codeOnly(client)
const hostCode = codeOnly(host)
const pkg = JSON.parse(read('package.json'))
const patch = read('cordis.patch.yml')


/**
 * 读出 client.js 插件 inject 数组里的服务名。
 * 与 workbench-ui-bridge.test.mjs 同口径：逐名检查，不钉整串字面量。
 */
function readInjectNames(source) {
  const match = /inject:\s*\[([\s\S]*?)\]/.exec(source)
  if (match === null) return []
  return [...new Set([...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]))]
}

test('WP4：main 是 keyed slot，且不覆盖 conversation', () => {
  assert.match(client, /ctx\.slots\.inject\('main'/, '必须注入 main')
  assert.match(client, /key:\s*PANEL_ID/, 'main 必须带 key（keyed slot）')
  assert.match(client, /const PANEL_ID\s*=\s*'workbench'/, 'PANEL_ID 必须是独立 key')
  assert.doesNotMatch(client, /key:\s*'conversation'/, '不得占用 conversation key')
  assert.match(client, /ctx\.slots\.inject\('sidebar\.panellist'/, '必须注入 sidebar.panellist')
  assert.match(client, /id:\s*PANEL_ID/, 'sidebar.panellist 必须带 id')
})

test('WP4：样式只用 --dsw-alias-* 令牌，无硬编码颜色', () => {
  // 抽出 CSS 块
  const css = client.slice(client.indexOf('const CSS = `'), client.indexOf('`\n\n    // ---'))
  const colorLiterals = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g) ?? []
  // 唯一允许的 rgba 是 overlay 遮罩（装饰性，非内容色）；令牌引用不算
  const nonOverlay = colorLiterals.filter((c) => !/rgba\(0,0,0,\.4\)/.test(c))
  assert.deepEqual(nonOverlay, [], `不得有硬编码颜色：${JSON.stringify(nonOverlay)}`)
  const tokens = [...css.matchAll(/--dsw-alias-[a-z0-9-]+/g)].map((m) => m[0])
  assert.ok(tokens.length >= 8, `应引用多个真实令牌，实际 ${tokens.length}`)
  for (const t of tokens) {
    assert.match(t, /^--dsw-alias-[a-z0-9-]+$/)
  }
})

test('WP4：不 import Harness Client 包 / 无 iframe / 不写 document.body', () => {
  assert.doesNotMatch(client, /@deepseek-ai\/dsh-client-ui-primitives/, '不得 require primitives')
  assert.doesNotMatch(client, /require\(['"]@deepseek-ai\/dsh-client-ui-/, '不得 require 任何 Client UI 包')
  assert.doesNotMatch(clientCode, /iframe/i, '不得用 iframe')
  assert.doesNotMatch(clientCode, /document\.body/, '不得写 document.body')
  assert.match(client, /require\('react'\)/, 'React 必须来自浏览器模块表')
  assert.match(client, /window\.__ModuleLoader__\.load/, '必须用模块加载器')
})

test('WP4：设计尺寸合规（16px 正文 / 20-28px 标题 / >=44px 点击区 / 4-8 倍数）', () => {
  assert.match(client, /font-size:16px/, '正文 16px')
  assert.match(client, /\.wb-title\{font-size:24px/, '主标题 24px（20-28 区间）')
  assert.match(client, /\.wb-section h2\{font-size:20px/, '二级标题 20px')
  assert.match(client, /min-height:44px/g, '点击区 >=44px')
  assert.match(client, /min-width:44px/, '点击区宽度 >=44px')
  // 间距取值应全为 4/8 倍数（抽查主要 padding/gap）
  const spacing = [...clientCode.matchAll(/(?:^|[;{,\s])(?:padding|gap|margin)[^:;]*:\s*([\d.]+)px/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n))
  for (const n of spacing) {
    assert.ok(n % 4 === 0, `间距 ${n}px 必须是 4 的倍数`)
  }
})

test('WP4：键盘、焦点与可访问性基础', () => {
  assert.match(client, /:focus-visible/, '必须有 focus-visible 样式')
  assert.match(client, /role: 'tablist'/, 'tablist role')
  assert.match(client, /role: 'alert'/, '错误用 alert')
  assert.match(client, /role: 'status'/, '状态用 status')
  assert.match(client, /role: 'dialog'/, '确认框用 dialog')
  assert.match(client, /aria-modal/, 'dialog 需 aria-modal')
  assert.match(client, /aria-label/, '交互控件需 aria-label')
  // Ctrl/Cmd+K 聚焦搜索：允许两种等价写法（直接比较 或 先取 key 再比较）。
  // 断言必须仍然能抓住「快捷键丢了」——只匹配 toLowerCase 不够，
  // 必须同时出现 k 分支和 searchRef.focus()。
  assert.match(client, /toLowerCase\(\)/, '按键需归一化大小写')
  assert.match(client, /=== 'k'/, 'Ctrl/Cmd+K 分支存在')
  assert.match(client, /searchRef\.current\?\.focus\(\)/, 'Ctrl/Cmd+K 必须真的聚焦搜索框')
  assert.match(client, /onKeyDown|addEventListener\('keydown'/, '键盘监听需在 effect 内清理')
})

test('WP4：加载 / 成功 / 失败状态齐全，错误不静默', () => {
  assert.match(client, /Loading…/, '加载态')
  assert.match(client, /Ready/, '就绪态')
  assert.match(client, /role: 'alert'/, '失败态')
  assert.match(client, /Retry/, '失败可重试')
  assert.match(client, /setError\(String\(e\?\.message \?\? e\)\)/, '异常必须转成可见错误')
})

test('WP4：删除走真 Host 审批，不读 confirmed 布尔', () => {
  // UI 删除的授权来自**用户在确认对话框的显式点击**，凭证由宿主签发
  // （DSH 的 ctx.approval.request 只能在模型回合内发起，UI 删除是回合外操作）。
  assert.match(client, /confirmUserAction/, '必须先申请宿主签发的用户确认凭证')
  assert.match(client, /approvalToken: token/, '带 token 调用删除')
  assert.match(host, /confirmUserAction/, 'Host 侧必须提供用户确认签发入口')
  assert.doesNotMatch(clientCode, /confirmed:\s*true/, '不得用 confirmed 布尔绕过')
  assert.match(host, /op === 'requestApproval'/, 'Host 有审批桥')
  assert.match(host, /service\.askApproval/, '审批走真 service.askApproval')
})

test('WP4：manifest / patch / locale / icon 完整', () => {
  assert.equal(pkg.name, '@local/dsh-workbench-ui')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.exports['./client'], '必须导出 client')
  assert.ok(pkg.exports['./locale/*.json'], '必须导出 locale')
  assert.ok(pkg.exports['./icon'], '必须导出 icon')
  for (const f of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(pkg.files.includes(f), `files 需含 ${f}`)
  }
  assert.match(patch, /id:\s*workbench-ui/)
  assert.match(patch, /name:\s*'@local\/dsh-workbench-ui'/)
  for (const lang of ['en', 'zh']) {
    const loc = JSON.parse(read(`locale/${lang}.json`))
    assert.ok(loc.meta.title.length > 0, `${lang} 需 meta.title`)
    assert.ok(loc.meta.description.length > 0, `${lang} 需 meta.description`)
  }
  const icon = new URL('icon.svg', ROOT)
  assert.ok(existsSync(icon), '图标存在')
  assert.ok(statSync(icon).size <= 256 * 1024, '图标 <=256KiB')
  assert.match(read('icon.svg'), /<svg/, '图标是 SVG')
})

test('WP4：数据只来自 Host Service（无本地假数据）', () => {
  assert.match(client, /ctx\.remote\.commands\.execute/, 'Client 必须走真 commands.execute')
  assert.match(host, /ctx\.provide\('workbench'/, 'Host 提供真 workbench service')
  // 不得出现硬编码的示例事件/任务数组
  assert.doesNotMatch(client, /const MOCK_EVENTS|const FAKE_TASKS|sampleEvents|demoData/i, '不得内置假数据')
  assert.match(client, /setEvents\(/, '事件来自 setState(load)')
  assert.match(client, /setTasks\(/, '任务来自 setState(load)')
})

test('WP4：UI 文案走真 Client locale 服务（不再是硬编码英文）', () => {
  const client = read('client.js')
  // 真契约：ctx.locale.register(NS, { zh, en })；取值 ctx.locale.bind(NS)('key')
  // 证据：dsh-client-ui-approval/lib/client.js:316
  assert.match(client, /ctx\.locale\.register\(NS, LOCALE\)/, '必须注册 locale 字典')
  assert.match(client, /ctx\.locale\.bind\(NS\)/, '必须用 bind 取文案')
  // WP5 真机修复：inject 逐服务名精确匹配。按名逐个检查，不钉整串字面量——
  // 补声明一个漏掉的服务是合法修复，不该把测试弄红。
  const injects = readInjectNames(client)
  for (const required of ['slots', 'remote', 'remote.commands', 'sessions', 'locale']) {
    assert.ok(injects.includes(required), `必须声明 ${required} 依赖（实际: ${injects.join(', ')}）`)
  }
  // 主要面板文案必须走 t()
  assert.match(client, /t\('panel'\)/, '面板标题必须走 locale')
  assert.match(client, /t\('calendar'\)/, '日历标签必须走 locale')
  assert.match(client, /t\('todos'\)/, '待办标签必须走 locale')
  // 不应再有硬编码的英文面板名
  const code = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
  assert.doesNotMatch(code, /'Workbench'\s*\)/, '面板名不得硬编码')
})
