/**
 * 括号平衡检查器。
 *
 * 为什么需要它：`node --check` 只报「第 N 行少一个 )」，而手写深层 `h()` 嵌套时
 * 肉眼数括号会反复数错。这个脚本逐行算余额，直接指出**哪一行开始不平衡**，
 * 而不是让人从报错行往回猜。
 *
 * 用法：node scripts/check-parens.mjs <file> [startLine] [endLine]
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (file === undefined) {
  console.error('用法：node scripts/check-parens.mjs <file> [start] [end]')
  process.exit(2)
}
const lines = readFileSync(file, 'utf8').split('\n')
const start = Number(process.argv[3] ?? 1) - 1
const end = Number(process.argv[4] ?? lines.length)

/** 去掉字符串、模板字面量与注释，只留结构括号。 */
function structural(line) {
  let out = ''
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue }
        if (line[i] === quote) { i++; break }
        i++
      }
      out += 'S'
      continue
    }
    if (ch === '/' && line[i + 1] === '/') break
    out += ch
    i++
  }
  return out
}

let bal = 0
let worst = { line: 0, bal: 0 }
let reported = false
for (let i = start; i < end; i++) {
  const s = structural(lines[i])
  bal += s.split('(').length - s.split(')').length
  if (bal < 0 && !reported) {
    console.log(`第一个「多一个 )」的位置：第 ${i + 1} 行 (bal=${bal})`)
    console.log(`  ${lines[i]}`)
    reported = true
  }
  if (bal > worst.bal) worst = { line: i + 1, bal }
}
console.log(`末尾余额 = ${bal}（0 表示括号平衡）`)
if (bal > 0) {
  console.log(`最深位置：第 ${worst.line} 行 (bal=${worst.bal})，最可能从这里开始没闭合`)
}
process.exit(bal === 0 ? 0 : 1)
