import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProofreadingScheduler } from '../src/composables/useProofreading.js'
import { fnv1a } from '../src/core/hash.js'

// 立即调度的调度器：把 debounce 去掉，便于断言。
class ImmediateScheduler extends ProofreadingScheduler {
  schedule() {
    this.runScan().catch(() => {})
  }
}

function makeTransport(scripted = {}) {
  const calls = { scans: [], addExceptions: [], deletedExceptions: [] }
  let scanVersion = scripted.version || 1
  let scanHits = scripted.hitsByHash || null
  return {
    calls,
    setVersion(v) {
      scanVersion = v
    },
    async getState() {
      await new Promise((r) => setImmediate(r))
      return { activeVersion: scanVersion, snapshot: { version: scanVersion } }
    },
    async listExceptions() {
      await new Promise((r) => setImmediate(r))
      return { exceptions: [] }
    },
    async addException(ex) {
      await new Promise((r) => setImmediate(r))
      calls.addExceptions.push(ex)
      return { exception: ex }
    },
    async deleteException(id) {
      calls.deletedExceptions.push(id)
      return { ok: true }
    },
    async scan(payload) {
      calls.scans.push(payload)
      await new Promise((r) => setImmediate(r)) // 模拟真实网络的异步边界
      const hash = fnv1a(payload.source)
      const hits = scanHits ? scanHits[payload.source] || [] : [{
        hitId: `h-${payload.source.length}`,
        ruleId: 'r1',
        ruleVersion: scanVersion,
        severity: 'error',
        message: 'x',
        suggestions: ['replaced'],
        start: 0,
        end: 1,
        line: 1,
        column: 1,
        snippet: payload.source.slice(0, 1),
        foldSnippet: payload.source.slice(0, 1),
        contextBefore: '',
        contextAfter: '',
        scopes: ['body'],
        nodeIds: ['n0'],
        suppressed: false,
        exception: null,
      }]
      return {
        mode:
          payload.base && payload.base.rulesVersion === scanVersion && payload.prevSummary.length
            ? 'incremental'
            : 'full',
        rulesVersion: scanVersion,
        mappingsVersion: scanVersion,
        exceptionsHash: 'eh1',
        summary: [{ id: 'n0', key: 'k', foldLen: payload.source.length }],
        hits,
      }
    },
    async publishCheck() {
      return {
        passed: true,
        rulesVersion: scanVersion,
        errors: [],
        warnings: [],
        suppressed: [],
      }
    },
  }
}

function flushTicks(n = 6) {
  return new Promise((r) => {
    let left = n
    const tick = () => (left -= 1) >= 0 ? setImmediate(tick) : r()
    setImmediate(tick)
  })
}
const flush = () => flushTicks(6)

test('输入法组字期间的未提交文本不触发扫描，compositionend 后才扫描', async () => {
  const t = makeTransport()
  const s = new ImmediateScheduler(t)
  await s.init()
  t.calls.scans.length = 0

  s.compositionStart()
  s.setSource('拼')
  s.setSource('拼音')
  s.setSource('拼音输入法') // 组字中连续变化
  assert.equal(t.calls.scans.length, 0)

  s.compositionEnd()
  await flush()
  assert.equal(t.calls.scans.length, 1)
  assert.equal(t.calls.scans[0].source, '拼音输入法')
})

test('快速连续修改：只有最后一次修改的响应被采纳，过期响应丢弃', async () => {
  const t = makeTransport()
  const s = new ImmediateScheduler(t)
  await s.init()
  t.calls.scans.length = 0

  s.setSource('a')
  s.setSource('ab')
  s.setSource('abc')
  await flushTicks(12)

  assert.ok(t.calls.scans.length >= 3)
  // 过期版本不落库；可见记录最多是初始空版本 + 当前版本
  const visible = s.state.versions.filter((v) => v.hash !== fnv1a(''))
  assert.equal(visible.length, 1)
  assert.equal(s.state.activeHash, fnv1a('abc'))
  assert.equal(s.currentHits().length, 1)
})

test('旧结果只属于其来源版本：切回旧文本时看到的是该版本自己的结果，不与新版本混淆', async () => {
  const hitsByHash = {
    '版本一内容X': [{
      hitId: 'old1', ruleId: 'r', ruleVersion: 1, severity: 'warn', message: 'old',
      suggestions: [], start: 0, end: 1, line: 1, column: 1, snippet: '版',
      foldSnippet: '版', contextBefore: '', contextAfter: '', scopes: ['body'],
      nodeIds: ['n0'], suppressed: false, exception: null,
    }],
    '版本二内容YY': [{
      hitId: 'new1', ruleId: 'r', ruleVersion: 1, severity: 'error', message: 'new',
      suggestions: [], start: 0, end: 1, line: 1, column: 1, snippet: '版',
      foldSnippet: '版', contextBefore: '', contextAfter: '', scopes: ['body'],
      nodeIds: ['n0'], suppressed: false, exception: null,
    }],
  }
  const t = makeTransport({ hitsByHash })
  const s = new ImmediateScheduler(t)
  await s.init()

  s.setSource('版本一内容X')
  await flush()
  s.setSource('版本二内容YY')
  await flush()

  assert.equal(s.state.versions.filter((v) => v.hash !== fnv1a('')).length, 2)
  assert.equal(s.currentHits()[0].hitId, 'new1')

  // 回到旧版本：高亮必须切换为旧版本自己的命中
  s.setSource('版本一内容X')
  await flush()
  assert.equal(s.currentHits()[0].hitId, 'old1')
})

test('规则版本变化后下一次扫描回退全量重算（规则撤回场景）', async () => {
  const t = makeTransport()
  const s = new ImmediateScheduler(t)
  await s.init()
  s.setSource('某段文稿内容')
  await flush()
  assert.equal(s.state.versions[0].mode, 'full')

  // 同样的文本再扫一次 -> 增量
  s.setSource('某段文稿内容')
  await flush()
  assert.equal(t.calls.scans.at(-1).base.rulesVersion, 1)

  // 管理页发布了 v2（规则撤回）
  t.setVersion(2)
  await s.refreshSnapshot()
  await flushTicks(12)
  const last = t.calls.scans.at(-1)
  assert.equal(last.base.rulesVersion, undefined) // prev 被清空 -> 全量
  const current = s.state.versions.find((v) => v.hash === fnv1a('某段文稿内容'))
  assert.equal(current.mode, 'full')
  assert.equal(current.rulesVersion, 2)
})

test('创建人工例外会上传“规则+片段+上下文”，并强制全量重扫', async () => {
  const t = makeTransport()
  const s = new ImmediateScheduler(t)
  await s.init()
  s.setSource('最佳产品')
  await flush()

  const hit = s.currentHits()[0]
  // 手工伪造 foldSnippet/context（真实数据由扫描器提供）
  hit.foldSnippet = '最佳'
  hit.contextBefore = ''
  hit.contextAfter = '产品'
  await s.addException(hit, '此处是品牌名')

  assert.equal(t.calls.addExceptions.length, 1)
  assert.deepEqual(
    { ...t.calls.addExceptions[0], note: t.calls.addExceptions[0].note },
    {
      ruleId: 'r1', ruleVersion: 1, docId: 'doc-main',
      snippet: '最佳', contextBefore: '', contextAfter: '产品', note: '此处是品牌名',
    },
  )
  const scanCall = t.calls.scans.at(-1)
  assert.deepEqual(scanCall.base, {}) // 例外集合变化 -> 全量
})

test('真实 debounce 场景：组字期间的中间态不扫描，且组字结束前的定时器不发起请求', async () => {
  class DebouncedScheduler extends ProofreadingScheduler {}
  const t = makeTransport()
  const s = new DebouncedScheduler(t)
  s.debounceMs = 50
  await s.init()
  t.calls.scans.length = 0

  s.compositionStart()
  // 模拟拼音中间态快速变化（即使越过防抖时间也不扫描）
  s.setSource('z')
  await new Promise((r) => setTimeout(r, 70))
  s.setSource('zui')
  await new Promise((r) => setTimeout(r, 70))
  assert.equal(t.calls.scans.length, 0, '组字期间零请求')

  // compositionend：组字结束，调度挂起扫描（内容是最后一次 setSource 的文本）
  s.compositionEnd()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(t.calls.scans.length, 1)
  assert.equal(t.calls.scans[0].source, 'zui')
})

test('扫描请求可被中止：AbortController 触发且不会污染状态', async () => {
  let rejectWithAbort = false
  const t = makeTransport()
  const origScan = t.scan.bind(t)
  t.scan = async (payload, signal) => {
    if (rejectWithAbort) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    return origScan(payload, signal)
  }
  const s = new ImmediateScheduler(t)
  await s.init()
  rejectWithAbort = true
  s.setSource('触发一次中止')
  await flush()
  assert.equal(s.state.scanning, false)
  assert.equal(s.state.lastError, '')
})
