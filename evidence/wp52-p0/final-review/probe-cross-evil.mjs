import { reminderIdentity, decodeIdentity } from '/tmp/wp52-p0-freeze-246e401/workbench-core/src/reminder-sync.js'
const evil = [
  ['scope含换行', 'a\nb', 't1'],
  ['scope含tab', 'a\tb', 't1'],
  ['scope含点', 'a.b', 't1'],
  ['scope含下划线', '_', 't1'],
  ['scope含反斜杠', 'a\\b', 't1'],
  ['scope含NUL', 'a\u0000b', 't1'],
  ['entityId含换行', 'a', 't1\nx'],
  ['entityId含点', 'a', 't1.x'],
  ['两者都空', '', ''],
  ['超长scope', 'x'.repeat(500), 't1'],
]
let bad = 0
for (const [name, sc, eid] of evil) {
  const id = reminderIdentity('task', eid, sc)
  const d = decodeIdentity(id)
  const ok = d !== null && d.scope === sc && d.entityId === eid
  if (!ok) bad++
  console.log((ok ? '✅' : '❌'), name.padEnd(14),
    'scope=' + JSON.stringify(d?.scope), 'id=' + JSON.stringify(d?.entityId))
}
console.log(bad === 0 ? '全部边界通过 ✅' : '有 ' + bad + ' 项失败 ❌')
