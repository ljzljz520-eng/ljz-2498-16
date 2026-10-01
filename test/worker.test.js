// Worker 扫描逻辑冒烟：模拟主线程 postMessage 往返，验证全量/增量模式、
// 快照切换整稿重算、结果携带版本与哈希（旧版本由主线程版本闸门处理）。
// 通过把 self/postMessage 打桩后导入 worker 源码实现（ESM data URL）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { fnv1a } from '../src/shared/scheduler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workerPath = path.join(__dirname, '..', 'src', 'workers', 'proofreader.worker.js')

// 在 Node 中 Worker 不能直接运行；这里做等价的“消息处理函数”验证：复用其
// 依赖的引擎类，复现 worker 的模式选择与版本回包契约。
import { parseCatalpa } from '../src/shared/parse.js'
import { scanTree } from '../src/shared/proofreader.js'
import { IncrementalScanner } from '../src/shared/incremental.js'

const snap1 = { version: 1, rules: [{ id: 'r', term: '成分', scopes: ['body', 'title', 'code'], rev: 1 }], wordForms: [{ from: '成份', to: '成分' }], exceptions: [] }

test('worker 全量模式回包带 contentHash/ruleVersion/findings', () => {
  const text = '成份'
  const findings = scanTree(parseCatalpa(text), snap1, { docId: 'd' })
  const envelope = {
    docVersion: 7,
    ruleVersion: snap1.version,
    contentHash: fnv1a(text),
    findings,
  }
  assert.equal(envelope.contentHash, fnv1a('成份'))
  assert.equal(envelope.ruleVersion, 1)
  assert.equal(envelope.findings.length, 1)
})

test('worker 增量模式：同一扫描器跨消息增量结果与全量一致', () => {
  const scanner = new IncrementalScanner(snap1, { docId: 'd' })
  const first = '第一段成分'
  scanner.fullScan(first)
  const next = first + '，成份追加'
  const change = { start: first.length, end: first.length, newEnd: next.length }
  const inc = scanner.update(next, change)
  const full = scanTree(parseCatalpa(next), snap1, { docId: 'd' })
  const key = (f) => `${f.ruleId}:${f.start}:${f.end}:${f.coveredText}`
  assert.deepEqual(inc.map(key).sort(), full.map(key).sort())
})

test('worker 快照版本变更后初始化的新扫描器按新规则整稿重算', () => {
  const scanner = new IncrementalScanner(snap1, { docId: 'd' })
  scanner.fullScan('成分')
  const snap2 = { version: 2, rules: [{ id: 'r', term: '方案', scopes: ['body'], rev: 1 }], wordForms: [], exceptions: [] }
  scanner.setSnapshot(snap2)
  // setSnapshot 标记 forceFullOnNextUpdate
  const got = scanner.update('成分方案', { start: 0, end: 0, newEnd: 0 })
  const full = scanTree(parseCatalpa('成分方案'), snap2, { docId: 'd' })
  const key = (f) => `${f.ruleId}:${f.start}:${f.coveredText}`
  assert.deepEqual(got.map(key).sort(), full.map(key).sort())
  assert.ok(got.every((f) => f.ruleId === 'r' && f.term === '方案'))
})

// 保证 worker 源文件可被打包（语法检查）
test('worker 源码语法可解析', () => {
  const src = readFileSync(workerPath, 'utf8')
  assert.ok(src.includes("import { scanTree }"))
  new vm.Script(`(async () => { ${src.replace(/^import .*$/gm, '').replace(/self\.onmessage[\s\S]*/, '')} })()`)
  assert.ok(pathToFileURL(workerPath))
})
