import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore, STORE_SCHEMA_VERSION, emptyStore, WorkbenchError, ERROR_CODES } from '../src/index.js'

const mkTmp = () => mkdtempSync(join(tmpdir(), 'wb-store-'))

test('存储：首次打开创建空快照，版本正确', () => {
  const dir = mkTmp()
  const store = openStore(dir)
  const data = store.read()
  assert.equal(data.version, STORE_SCHEMA_VERSION)
  assert.deepEqual(data.events, [])
  assert.deepEqual(data.tasks, [])
  assert.ok(existsSync(join(dir, 'workbench.json')))
})

test('存储：写入后可重开读到同样内容（持久化）', () => {
  const dir = mkTmp()
  const s1 = openStore(dir)
  s1.mutate((draft) => {
    draft.events.push({ id: 'e1', title: 'x' })
    return draft
  })
  const s2 = openStore(dir)
  assert.equal(s2.read().events.length, 1)
  assert.equal(s2.read().events[0].id, 'e1')
})

test('存储：mutate 前自动备份，backups 目录有文件', () => {
  const dir = mkTmp()
  const store = openStore(dir)
  store.mutate((draft) => {
    draft.events.push({ id: 'e1' })
    return draft
  })
  const backups = store.listBackups()
  assert.ok(backups.length >= 1)
})

test('存储：回滚能恢复上一份内容', () => {
  const dir = mkTmp()
  const store = openStore(dir)
  store.mutate((draft) => { draft.events.push({ id: 'e1' }); return draft })
  store.mutate((draft) => { draft.events.push({ id: 'e2' }); return draft })
  assert.equal(store.read().events.length, 2)
  const r = store.rollback()
  assert.ok(r.restored)
  assert.equal(store.read().events.length, 1)
})

test('存储：中断残留 journal 时，重开自动回滚到备份', () => {
  const dir = mkTmp()
  const store = openStore(dir)
  store.mutate((draft) => { draft.events.push({ id: 'e1' }); return draft })
  // 模拟中断：写 journal 但不写新数据
  writeFileSync(join(dir, 'workbench.journal'), JSON.stringify({ intent: 'write' }))
  // 同时把主文件破坏成半截（模拟写入中断）
  writeFileSync(join(dir, 'workbench.json'), '{"version":1,"events":[{"id":"e1"},')
  const reopened = openStore(dir)
  assert.equal(reopened.read().events.length, 1)
  assert.equal(existsSync(join(dir, 'workbench.journal')), false)
})

test('存储：schema 版本高于支持时拒绝启动（不猜不降级）', () => {
  const dir = mkTmp()
  openStore(dir)
  const file = join(dir, 'workbench.json')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  data.version = STORE_SCHEMA_VERSION + 1
  writeFileSync(file, JSON.stringify(data))
  assert.throws(
    () => openStore(dir),
    (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.SCHEMA_TOO_NEW,
  )
})

test('存储：损坏 JSON 报 store-corrupt 而不是静默重置', () => {
  const dir = mkTmp()
  openStore(dir)
  writeFileSync(join(dir, 'workbench.json'), 'not json at all')
  assert.throws(
    () => openStore(dir),
    (err) => err instanceof WorkbenchError && err.code === ERROR_CODES.STORE_CORRUPT,
  )
})

test('存储：缺字段的存储被拒绝', () => {
  const dir = mkTmp()
  openStore(dir)
  const file = join(dir, 'workbench.json')
  writeFileSync(file, JSON.stringify({ version: 1, events: [] }))
  assert.throws(() => openStore(dir), /必须是数组/)
})

test('存储：fingerprint 随内容变化，且不含 audit 噪音', () => {
  const dir = mkTmp()
  const store = openStore(dir)
  const f1 = store.fingerprint()
  store.mutate((draft) => { draft.events.push({ id: 'e1' }); return draft })
  const f2 = store.fingerprint()
  assert.notEqual(f1, f2)
})

test('存储：collection 返回副本，外部修改不污染内部状态', () => {
  const dir = mkTmp()
  const store = openStore(dir)
  store.mutate((draft) => { draft.events.push({ id: 'e1', title: 'a' }); return draft })
  const copy = store.collection('events')
  copy[0].title = 'HACKED'
  assert.equal(store.read().events[0].title, 'a')
})

test('存储：replace 整体替换并保留版本', () => {
  const dir = mkTmp()
  const store = openStore(dir)
  store.replace({ version: STORE_SCHEMA_VERSION, updatedAt: new Date().toISOString(), events: [{ id: 'x' }], tasks: [], audit: [] })
  assert.deepEqual(store.read().events.map((e) => e.id), ['x'])
})

test('存储：emptyStore 是纯函数，两次调用互不影响', () => {
  const a = emptyStore()
  const b = emptyStore()
  a.events.push({ id: 'x' })
  assert.equal(b.events.length, 0)
})
