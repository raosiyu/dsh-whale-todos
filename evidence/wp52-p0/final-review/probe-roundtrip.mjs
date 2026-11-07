/**
 * WP5.2-P0 独立复审 · 探针 A：往返一致 + 无碰撞 + base64url 字母表
 *
 * 只 import 冻结副本（/tmp/wp52-p0-freeze-246e401.regenerated），
 * 不改任何文件。运行：node probe-roundtrip.mjs
 */
import {
  reminderIdentity,
  decodeIdentity,
  IDENTITY_FORMAT_V2,
} from '/tmp/wp52-p0-freeze-246e401.regenerated/workbench-core/src/reminder-sync.js'

let pass = 0
let fail = 0
const failures = []

function check(label, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${label}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ❌ ${label}  ${detail}`)
  }
}

console.log('=== Q1: base64url 字母表不含 . ===')
// 穷举一组含极端字符的输入，确认编码产物不含 '.'（这是分段分隔符）
const samples = [
  'a::b', 'proj:sub', '_', '', '中文:作用域', 'emoji🙂', ']]', '[[wb:',
  'a\nb', 'a\tb', 'a\u0000b', 'x.y.z', 'a/b?c#d%e&f', 'a b  c',
  'Z'.repeat(500), '\u0001\u0002\u0003', 'line1\nline2\r\nline3',
]
let allNoDot = true
for (const s of samples) {
  const id = reminderIdentity('task', 't1', s)
  const b64part = id.split('.')[2]
  if (b64part.includes('.')) {
    allNoDot = false
    console.log(`  ❌ 含 . : scope=${JSON.stringify(s)} b64=${b64part}`)
  }
}
check('任意 scope 编码产物不含 .（分段分隔符安全）', allNoDot)

console.log('\n=== Q1: 任意 scope/entityId 往返一致（逐字节还原）===')
const scopes = [
  'a::b', 'proj:sub', '_', '', '中文:作用域', 'emoji🙂', ']]', '[[wb:',
  'a\nb', 'a\tb', 'a\u0000b', 'x.y.z', 'a/b?c#d%e&f', 'a b  c',
  'Z'.repeat(500), '\u0001\u0002\u0003', 'line1\nline2\r\nline3',
  '🌊🐋💙', 'scope.with.many.dots.and:colons::', ' leading', 'trailing ',
]
const entityIds = [
  't1', 'a::b', 'id:with:colons', '中文id', 'x.y', 'a]]b', 'e/1?2#3',
  'emoji🐟', 'id\nwith\nnewlines', 'id\u0000nul', 'Z'.repeat(500),
  '[[wb:fake]]', '\u200B\u2060', 'tab\there', 'space id',
]
let roundtripOk = true
let roundtripCount = 0
for (const sc of scopes) {
  for (const eid of entityIds) {
    const id = reminderIdentity('task', eid, sc)
    const d = decodeIdentity(id)
    roundtripCount += 1
    if (d === null || d.scope !== sc || d.entityId !== eid || d.kind !== 'task' || d.legacyAmbiguous === true) {
      roundtripOk = false
      console.log(`  ❌ 往返失败 scope=${JSON.stringify(sc)} id=${JSON.stringify(eid)} got=${JSON.stringify(d)}`)
    }
  }
}
check(`全组合 ${scopes.length}×${entityIds.length}=${roundtripCount} 往返一致`, roundtripOk)

console.log('\n=== Q2: 无碰撞 ===')
// 空 scope 与真实 '_'
const emptyScope = reminderIdentity('task', 't1', '')
const underscoreScope = reminderIdentity('task', 't1', '_')
check('空 scope 与真实 "_" 身份不同', emptyScope !== underscoreScope,
  `empty=${emptyScope} vs _=${underscoreScope}`)
check('空 scope 解码回 ""', decodeIdentity(emptyScope).scope === '')
check('"_" scope 解码回 "_"', decodeIdentity(underscoreScope).scope === '_')

// 旧格式会撞：scope=a, id=b:c  vs  scope=a:b, id=c
// v1 旧格式两者都是 `task:a:b:c`（同一个字符串）
const v1_ab_c = 'task:a:b:c' // scope=a, id=b:c  或  scope=a:b, id=c
const v2_a_bc = reminderIdentity('task', 'b:c', 'a')
const v2_ab_c = reminderIdentity('task', 'c', 'a:b')
check('v2 中 (scope=a,id=b:c) 与 (scope=a:b,id=c) 身份不同', v2_a_bc !== v2_ab_c,
  `a_bc=${v2_a_bc} vs ab_c=${v2_ab_c}`)
// 且它们各自能无损解码回不同实体
check('(a, b:c) 解码 scope=a id=b:c',
  decodeIdentity(v2_a_bc).scope === 'a' && decodeIdentity(v2_a_bc).entityId === 'b:c')
check('(a:b, c) 解码 scope=a:b id=c',
  decodeIdentity(v2_ab_c).scope === 'a:b' && decodeIdentity(v2_ab_c).entityId === 'c')

// v2 格式带版本前缀，段数固定 4
const probeId = reminderIdentity('task', 't1', 'a::b')
check('身份带版本前缀 wb2.', probeId.startsWith(`${IDENTITY_FORMAT_V2}.`))
check('段数固定为 4', probeId.split('.').length === 4, `got ${probeId.split('.').length}: ${probeId}`)

console.log('\n=== 汇总 ===')
console.log(`PASS ${pass}  FAIL ${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
