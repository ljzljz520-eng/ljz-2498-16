// 调度器：输入不阻塞（防抖异步）、快速连续修改只应用最新版本、旧结果只展示
// 在对应版本、IME 合成期间不扫描、规则快照版本变化使在途结果失效。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScanScheduler, fnv1a } from '../src/shared/scheduler.js'

function fakeClock() {
  let t = 0
  const pending = new Map()
  return {
    now: () => t,
    tick(ms) { t += ms },
    setTimeout(fn, ms) {
      const id = Symbol('timer')
      pending.set(id, { fn, runAt: t + ms })
      return id
    },
    clearTimeout(id) { pending.delete(id) },
    async flush() {
      while (pending.size) {
        const [id, e] = [...pending.entries()].sort((a, b) => a[1].runAt - b[1].runAt)[0]
        pending.delete(id)
        t = e.runAt
        await e.fn()
        await Promise.resolve()
        await Promise.resolve()
      }
      await delay(2)
    },
    pendingCount: () => pending.size,
  }
}

const snap1 = { version: 1 }
const snap2 = { version: 2 }

test('快速连续修改：只有最新文本版本的扫描结果被应用', async () => {
  const clock = fakeClock()
  const seen = []
  const sc = new ScanScheduler(
    async ({ text }) => { seen.push(text); await Promise.resolve(); return [{ text }] },
    () => {},
    { delay: 100, clock, snapshot: snap1 },
  )
  sc.notify('a')
  sc.notify('ab')
  sc.notify('abc')
  await clock.flush()
  assert.equal(sc.state.status, 'current')
  assert.equal(sc.state.text, 'abc')
  assert.equal(sc.state.findings.length, 1)
  assert.equal(sc.state.findings[0].text, 'abc')
  assert.equal(sc.state.docVersion, 3)
  // 只有最后一次防抖后真正发起了扫描
  assert.deepEqual(seen, ['abc'])
})

test('扫描在途时文本再变化：先完成的旧结果被版本闸门丢弃', async () => {
  const clock = fakeClock()
  let releaseFirst
  const results = []
  const sc = new ScanScheduler(
    ({ text }) => new Promise((resolve) => {
      if (text === 'one') {
        releaseFirst = () => resolve([{ text: 'old' }])
      } else {
        delay(1).then(() => resolve([{ text: 'new' }]))
      }
    }),
    (st) => results.push(st.text),
    { delay: 0, clock, snapshot: snap1 },
  )
  sc.notify('one')
  await clock.flush() // 触发第一次扫描（挂起在 releaseFirst）
  sc.notify('two')
  await clock.flush() // 第二次扫描完成
  releaseFirst() // 旧扫描晚到
  await delay(10)
  assert.equal(sc.state.text, 'two')
  assert.deepEqual(results, ['two'])
  assert.equal(sc.state.findings[0].text, 'new')
})

test('旧结果只展示在对应版本：contentHash 不匹配即丢弃', async () => {
  const clock = fakeClock()
  const stale = []
  const sc = new ScanScheduler(
    async ({ text }) => [{ text }],
    () => {},
    { delay: 0, clock, snapshot: snap1, onStaleVersion: (x) => stale.push(x) },
  )
  sc.notify('hello')
  await clock.flush()
  assert.equal(sc.state.contentHash, fnv1a('hello'))
  // 人为制造一个过期回包场景（通过快速修改）
  sc.notify('hello world')
  await clock.flush()
  assert.equal(sc.state.text, 'hello world')
})

test('IME 合成期间不调度扫描；合成结束后才扫描', async () => {
  const clock = fakeClock()
  let calls = 0
  const sc = new ScanScheduler(
    async () => { calls += 1; return [] },
    () => {},
    { delay: 50, clock, snapshot: snap1 },
  )
  sc.setComposing(true)
  sc.notify('拼音未提交')
  await clock.flush()
  assert.equal(calls, 0)
  assert.equal(sc.state.status, 'scanning')
  sc.setComposing(false)
  await clock.flush()
  assert.equal(calls, 1)
  assert.equal(sc.state.status, 'current')
})

test('规则快照切换：在途/当前结果立即失效并触发重扫（新版本规则）', async () => {
  const clock = fakeClock()
  const sc = new ScanScheduler(
    async () => [],
    () => {},
    { delay: 50, clock, snapshot: snap1 },
  )
  sc.notify('x')
  await clock.flush()
  assert.equal(sc.state.ruleVersion, 1)
  sc.setSnapshot(snap2)
  assert.equal(sc.state.ruleVersion, 2)
  assert.equal(sc.state.status, 'scanning')
  await clock.flush()
  assert.equal(sc.state.ruleVersion, 2)
  assert.equal(sc.state.status, 'current')
})

test('在途扫描以旧快照完成时因 ruleVersion 不符被丢弃', async () => {
  const clock = fakeClock()
  let release
  const applied = []
  const sc = new ScanScheduler(
    ({ snapshot }) => new Promise((res) => {
      if (snapshot.version === 1) release = () => res([])
      else delay(1).then(() => res([]))
    }),
    (st) => applied.push(st.ruleVersion),
    { delay: 0, clock, snapshot: snap1 },
  )
  sc.notify('a')
  await clock.flush() // v1 扫描挂起
  sc.setSnapshot(snap2)
  await clock.flush() // v2 扫描完成并应用
  release() // v1 迟到
  await delay(10)
  assert.deepEqual(applied, [2])
})

test('扫描函数抛错：状态置 error 且不阻塞后续修改', async () => {
  const clock = fakeClock()
  let shouldThrow = true
  const sc = new ScanScheduler(
    async () => { if (shouldThrow) throw new Error('boom'); return [] },
    () => {},
    { delay: 0, clock, snapshot: snap1 },
  )
  sc.notify('x')
  await clock.flush()
  assert.equal(sc.state.status, 'error')
  shouldThrow = false
  sc.notify('xy')
  await clock.flush()
  assert.equal(sc.state.status, 'current')
})

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
