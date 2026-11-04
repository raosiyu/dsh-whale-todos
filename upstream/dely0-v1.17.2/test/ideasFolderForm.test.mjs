/**
 * issue #15 回归守卫：点子页的「新建 / 重命名文件夹」（= 新建点子王）必须真的能渲染出来。
 *
 * ## 为什么要有这组测试
 *
 * D17 客户端拆分（b9182b8）把文件夹表单的**渲染层**丢了：五个入口照样 `setFolderForm`、
 * hook 里的 `saveFolder` 照样能发 POST / PATCH，但没有任何组件读 `folderForm` ——
 * 于是「点了没反应、也不报错」，用户以为按钮坏了。
 *
 * 当时整个测试金字塔都是绿的：
 * - 组件测试给的是 `onCreateFolder: () => {}` 桩（回调被调用当然不报错）；
 * - 接线测试只断言"回调被传给了组件"，从没断言"它改的状态有人读"。
 *
 * 所以这里补的正是漏掉的那一层：**状态必须有人读**（源码级扫描，与本仓 §3「政策 = 一次扫描断言」一致）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { read, readClientSources, stripComments } from './_clientSources.mjs'

/**
 * 从 hook 的返回类型里解析它暴露了哪些字段（顶层 + `actions`）。
 * 不手抄清单：手抄的清单会和实现脱节，而脱节的清单正是下一个 #15。
 */
function useIdeasResultFields() {
  const source = read('src/client/hooks/useIdeas.ts')
  const start = source.indexOf('export type UseIdeasResult = {')
  assert.ok(start !== -1, '找不到 UseIdeasResult 类型 —— 解析锚点失效，请同步本测试')
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, 'UseIdeasResult 的结尾锚点失效')
  const block = source.slice(start, end)
  const topLevel = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]).filter((name) => name !== 'actions')
  const actionsBlock = block.slice(block.indexOf('  actions: {'))
  const actions = [...actionsBlock.matchAll(/^ {4}(\w+)\??:/gm)].map((match) => match[1])
  assert.ok(topLevel.includes('folderForm'), 'UseIdeasResult 里必须仍有 folderForm')
  assert.ok(actions.includes('saveFolder'), 'actions 里必须仍有 saveFolder')
  return { topLevel, actions }
}

/**
 * 允许"没有渲染层读者"的已知遗留项（必须有理由，且只许收窄不许放宽）。
 *
 * - `setKind`：`ideaKind` 从来没有 UI 写入点，只是请求参数（见 useIdeas.ts 头注释）。
 *   它是**遗留请求参数**，不是"本该驱动 UI 却没人渲染"的状态 —— 与 #15 不是一类。
 */
const ALLOWED_WITHOUT_READER = new Set(['setKind'])

test('useIdeas 暴露的每个状态 / 动作都有渲染层读者（防 D17 式"只写不读"回归）', () => {
  const { topLevel, actions } = useIdeasResultFields()
  // 只认渲染层（.tsx）：纯逻辑模块里出现同名标识符不算"有人用"，那正是本 bug 的形态。
  const renderSources = readClientSources()
    .filter((file) => file.rel.endsWith('.tsx'))
    .map((file) => ({ rel: file.rel, text: stripComments(file.text) }))

  const orphans = [...topLevel, ...actions].filter((name) => {
    if (ALLOWED_WITHOUT_READER.has(name)) return false
    const pattern = new RegExp(`\\b${name}\\b`)
    return !renderSources.some((file) => pattern.test(file.text))
  })

  assert.deepEqual(
    orphans,
    [],
    `这些状态在 src/client 的 .tsx 里没有任何读者，会表现为"点了没反应、也不报错"：${orphans.join(', ')}`,
  )
})

test('接线：文件夹表单由提示层渲染，并接上 hook 的 patch / save / close', () => {
  const overlays = stripComments(read('src/client/app/WorkbenchOverlays.tsx'))
  assert.match(overlays, /const \{ folderForm, patchFolderForm, setFolderForm \} = props\.ideas/, '状态必须从 ideas 域取（不另存一份）')
  assert.match(overlays, /\{folderForm !== null && \(/, '必须按 folderForm 决定是否渲染')
  assert.match(overlays, /mode === 'create' \? '新建文件夹' : '重命名文件夹'/, '新建与改名两种模式都要有标题')
  assert.match(overlays, /onChange=\{\(e\) => patchFolderForm\(\{ title: e\.target\.value \}\)\}/, '标题输入必须回写 hook')
  assert.match(overlays, /onChange=\{\(e\) => patchFolderForm\(\{ summaryMd: e\.target\.value \}\)\}/, '说明输入必须回写 hook')
  assert.match(overlays, /saveFolder\(\)/, '提交必须调 hook 的 saveFolder（校验 / POST / notice 都在那里）')
  assert.match(overlays, /disabled=\{folderForm\.title\.trim\(\) === ''\}/, '标题为空时不允许提交（不在弹窗背后留一条看不见的错误）')
})

test('打开即聚焦名称输入框：模态弹窗必须优先聚焦 data-autofocus 的主字段', () => {
  const modal = stripComments(read('src/client/components/Modal.tsx'))
  assert.match(
    modal,
    /querySelector<HTMLElement>\('\[data-autofocus\]:not\(\[disabled\]\)'\)/,
    'Modal 必须先找 data-autofocus：FOCUSABLE 的第一个永远是标题栏关闭按钮',
  )
  assert.match(modal, /const first = preferred \?\? panel\?\.querySelector<HTMLElement>\(FOCUSABLE\)/, '找不到主字段时才退回第一个可聚焦元素')

  const overlays = stripComments(read('src/client/app/WorkbenchOverlays.tsx'))
  const input = overlays.slice(overlays.indexOf('文件夹名称'), overlays.indexOf('一句话说明'))
  assert.match(input, /data-autofocus="true"/, '文件夹名称输入框必须标 data-autofocus，否则打开弹窗后打字没反应')
  assert.doesNotMatch(input, /\bautoFocus\b/, '同一语义只留一处：靠 data-autofocus 由 Modal 统一聚焦')
})
