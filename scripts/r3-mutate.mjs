#!/usr/bin/env node
/**
 * 变异验证：逐个删掉保护代码，测试必须变红。
 *
 * 为什么用 Node 而不是 shell：上一版用 shell 传替换文本，`${...}` 模板串与
 * 反引号会被 shell 展开，导致脚本自身崩溃/改错文件。改成 JSON 定义 + Node 执行，
 * 替换文本原样传递，不经过任何 shell 插值。
 *
 * 判定：
 *   CAUGHT  删掉保护后测试变红 → 该保护有测试约束
 *   VACUUM  删掉保护后仍全绿   → 测试真空，必须补测试
 *   SKIP    锚点未找到         → 变异定义与代码脱节，需修正定义
 *
 * 用法：node scripts/r3-mutate.mjs [输出日志路径]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = join(ROOT, 'workbench-core')
const MUTATIONS = join(ROOT, 'scripts', 'r3-mutations.json')
const OUT = process.argv[2] ?? join(ROOT, 'evidence', 'wp2-r3', '01-mutation.log')

const lines = []
const say = (s) => { console.log(s); lines.push(s) }

/** 跑测试，返回 { pass, fail } */
function runTests() {
  let stdout = ''
  try {
    stdout = execFileSync(process.execPath, ['--test', ...listTestFiles()], {
      cwd: CORE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    // node --test 在有失败时退出码非 0，stdout 仍有汇总
    stdout = String(error?.stdout ?? '')
  }
  const n = (label) => {
    const m = stdout.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))
    return m === null ? 0 : Number(m[1])
  }
  return { pass: n('pass'), fail: n('fail') }
}

function listTestFiles() {
  const { readdirSync } = require$fs()
  return readdirSync(join(CORE, 'test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => `test/${f}`)
}

// ESM 下用动态 import 取 fs 的 readdirSync（顶部已 import readFileSync 等）
import * as fs from 'node:fs'
function require$fs() { return fs }

const mutations = JSON.parse(readFileSync(MUTATIONS, 'utf8'))

say('=== 变异验证（删保护代码，测试应失败）===')
say(`变异定义：${mutations.length} 项（scripts/r3-mutations.json）`)
say('')

let caught = 0
let vacuum = 0
let skip = 0

for (const m of mutations) {
  const file = join(ROOT, m.file)
  if (!existsSync(file)) {
    say(`SKIP   ${m.id} ${m.name}（文件不存在：${m.file}）`)
    skip += 1
    continue
  }
  const original = readFileSync(file, 'utf8')
  if (!original.includes(m.from)) {
    say(`SKIP   ${m.id} ${m.name}（锚点未找到）`)
    skip += 1
    continue
  }

  const backup = `${file}.mutation-backup`
  copyFileSync(file, backup)
  try {
    writeFileSync(file, original.replace(m.from, m.to), 'utf8')
    const { pass, fail } = runTests()
    if (fail > 0) {
      say(`CAUGHT ${m.id} ${m.name}  → pass ${pass} fail ${fail}`)
      caught += 1
    } else {
      say(`VACUUM ${m.id} ${m.name}  → pass ${pass} fail ${fail}  ← 测试未捕获，必须补测试`)
      vacuum += 1
    }
  } finally {
    copyFileSync(backup, file)
    unlinkSync(backup)
  }
}

say('')
say('=== 汇总 ===')
say(`CAUGHT: ${caught}`)
say(`VACUUM: ${vacuum}`)
say(`SKIP:   ${skip}`)
say('')
if (skip > 0) {
  say(`注意：${skip} 个变异锚点未命中（SKIP）——这些保护点本轮**未被检验**。`)
  say('      锚点漂移等于静默失效，必须修正变异定义或代码后再跑。')
}
say(vacuum === 0 && skip === 0
  ? '结论：全部保护点都有测试约束（0 真空，0 跳过）'
  : `结论：vacuum=${vacuum} skip=${skip}——两者都必须为 0 才算验证充分`)

try {
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
  console.log(`\n日志已写入 ${OUT}`)
} catch {
  console.log(`\n（无法写入 ${OUT}，仅输出到终端）`)
}

process.exit(vacuum === 0 && skip === 0 ? 0 : 1)
