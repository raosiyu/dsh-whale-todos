/**
 * 验收套件的**定位表达式不许绑死一种界面语言**（issue #12 回归面，2026-10-22 实测踩过）。
 *
 * 现象：verify 库把界面语言设成 en-US 后，面板头部那个按钮渲染成 `Back`
 *（src/shared/i18n.ts 的 `'返回对话': 'Back'`），而 legacy-acceptance 与 legacy-final-2
 * 各自用中文字面量定位它 —— 于是 LEG-A10/A11、LEG-F05/F06 全红，报错写的是
 * "找不到按钮"，把"定位写法过时"伪装成"面板收不起来"的业务回归。
 *
 * 这里的判据就是当时该有的那条政策：
 * - 可翻译文案→英文的对照必须来自 i18n 表（翻译改了，本测试跟着红，而不是等到真机才红）；
 * - 「返回对话」这种会翻译的按钮，定位表达式只许从 `_harness.backButtonExpr()` 取一处；
 * - 套房不许再自己拼 `includes('返回对话')` 这种只认一种语言的定位。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BACK_BUTTON_LABELS, backButtonExpr } from '../scripts/verify/suites/_harness.mjs'

const SUITE_DIR = join('scripts', 'verify', 'suites')
const I18N = join('src', 'shared', 'i18n.ts')

const suiteFiles = () => readdirSync(SUITE_DIR).filter((name) => name.endsWith('.mjs'))
const readSuite = (name) => readFileSync(join(SUITE_DIR, name), 'utf8')

test('返回对话：中文原文与英文译文都认，且译文来自 i18n 表（改翻译会红）', () => {
  const source = readFileSync(I18N, 'utf8')
  const hit = /'返回对话':\s*'([^']+)'/.exec(source)
  assert.ok(hit !== null, 'i18n 表里必须还有 \'返回对话\' 这条（否则英文界面下按钮文案与这里脱节）')
  const english = hit[1]
  assert.ok(BACK_BUTTON_LABELS.includes('返回对话'), `labels 缺中文原文：${JSON.stringify(BACK_BUTTON_LABELS)}`)
  assert.ok(BACK_BUTTON_LABELS.includes(english), `labels 缺 i18n 表里的译文 "${english}"：${JSON.stringify(BACK_BUTTON_LABELS)}`)
})

test('backButtonExpr：只找 button、两种文案都接受、保持"找不到就返回 null"', () => {
  const expr = backButtonExpr()
  for (const label of BACK_BUTTON_LABELS) assert.ok(expr.includes(label), `表达式里没有文案 "${label}"`)
  assert.match(expr, /querySelectorAll\('button'\)/, '必须只在 button 里找（面板里还有别的同名文本）')
  assert.match(expr, /return null/, '找不到必须返回 null，调用方才知道要记 fail（不许条件少测）')
  assert.match(expr, /getBoundingClientRect/, '要返回中心点坐标，调用方按坐标点击')
})

test('套房不许自己硬编码「返回对话」的中文定位（定位规则只有 backButtonExpr 一处）', () => {
  const offenders = suiteFiles()
    .filter((name) => name !== '_harness.mjs')
    .filter((name) => /includes\('返回对话'\)|===\s*'返回对话'/.test(readSuite(name)))
  assert.deepEqual(offenders, [], `这些套件自己拼了中文定位，英文界面下会假红：${offenders.join(', ')}`)
})

test('用到「返回对话」的套件都从 _harness 取表达式（不是复制一份）', () => {
  const users = suiteFiles().filter((name) => name !== '_harness.mjs' && /const FIND_BACK = /.test(readSuite(name)))
  assert.ok(users.length >= 2, `至少两套历史回归需要点「返回对话」，实际：${users.join(', ')}`)
  for (const name of users) {
    const source = readSuite(name)
    assert.match(source, /const FIND_BACK = backButtonExpr\(\)/, `${name} 的 FIND_BACK 必须来自 backButtonExpr()`)
    assert.match(source, /import \{[^}]*backButtonExpr[^}]*\} from '\.\/_harness\.mjs'/, `${name} 必须从 _harness 导入 backButtonExpr`)
  }
})
