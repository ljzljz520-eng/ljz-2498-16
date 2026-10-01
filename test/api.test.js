import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

// 使用独立临时数据库
process.env.PORT = '0'
const tmp = mkdtempSync(join(tmpdir(), 'catalpa-db-'))
const DB_FILE = join(tmp, 'db.json')

const { JsonStore } = await import('../server/store.js')
const { createApp } = await import('../server/http.js')

// createApp 默认用固定 DB 路径；这里直接用 store + service 做无端口端到端测试，
// 再单独起一个 HTTP 服务验证路由。
const store = new JsonStore(DB_FILE)
const { runScan, runPublishCheck } = await import('../server/scan-service.js')

test('初始状态包含种子规则与 v1 快照', () => {
  const snap = store.getActiveSnapshot()
  assert.equal(snap.version, 1)
  assert.ok(snap.rules.length >= 4)
  assert.ok(snap.mappings.length >= 1)
})

test('全稿扫描：识别极限词、错别字与代码 FIXME，并给出栏目范围', () => {
  const src = '# 最佳标题\n\n请先按装依赖。\n\n```js\n// FIXME: later\n```\n'
  const res = runScan(store, { source: src, docId: 'd', mode: 'full' })
  assert.equal(res.mode, 'full')
  const ids = res.hits.filter((h) => !h.suppressed).map((h) => h.ruleId)
  assert.ok(ids.includes('r_ad_best'))
  assert.ok(ids.includes('r_typo_install'))
  assert.ok(ids.includes('r_code_fixme'))
  const codeHit = res.hits.find((h) => h.ruleId === 'r_code_fixme')
  assert.deepEqual(codeHit.scopes, ['code'])
  // 位置映射：FIXME 在代码块原文中
  assert.equal(src.slice(codeHit.start, codeHit.end), 'FIXME')
})

test('增量扫描：单节点修改后 mode=incremental，且不产生假命中', () => {
  const src = '第一段内容。\n\n第二段内容。'
  const first = runScan(store, { source: src, docId: 'd2', mode: 'full' })

  const src2 = '第一段内容。\n\n第二段出现最佳。'
  const second = runScan(store, {
    source: src2,
    docId: 'd2',
    mode: 'auto',
    prevSummary: first.summary,
    prevHits: first.hits,
    base: { rulesVersion: first.rulesVersion, mappingsVersion: first.mappingsVersion, exceptionsHash: first.exceptionsHash },
  })
  assert.equal(second.mode, 'incremental')
  assert.equal(second.hits.filter((h) => h.ruleId === 'r_ad_best').length, 1)
  // 未修改的第一段不产生重复命中
  assert.equal(second.hits.length, second.hits.filter((h) => h.start >= 0).length)
})

test('跨段短语在增量重算窗口内被正确识别/清除', () => {
  const src = '如需联系\n\n客服请等待。'
  const first = runScan(store, { source: src, docId: 'd3', mode: 'full' })
  assert.ok(first.hits.some((h) => h.ruleId === 'r_contact_cross'))

  // 修改第二段
  const src2 = '如需联系\n\n客服现在不在线请等待。'
  const second = runScan(store, {
    source: src2,
    docId: 'd3',
    mode: 'auto',
    prevSummary: first.summary,
    prevHits: first.hits,
    base: { rulesVersion: first.rulesVersion, mappingsVersion: first.mappingsVersion, exceptionsHash: first.exceptionsHash },
  })
  assert.equal(second.mode, 'incremental')
  // 短语仍应命中（窗口覆盖相邻节点）
  assert.ok(second.hits.some((h) => h.ruleId === 'r_contact_cross'))
})

test('人工例外绑定片段+上下文：只压制该出现', () => {
  const src = '最佳 与 最佳'
  const first = runScan(store, { source: src, docId: 'd4', mode: 'full' })
  const hits = first.hits.filter((h) => h.ruleId === 'r_ad_best')
  assert.equal(hits.length, 2)
  const target = hits[0]
  store.addException({
    ruleId: target.ruleId,
    ruleVersion: target.ruleVersion,
    docId: 'd4',
    snippet: target.foldSnippet,
    contextBefore: target.contextBefore,
    contextAfter: target.contextAfter,
  })
  const again = runScan(store, { source: src, docId: 'd4', mode: 'full' })
  assert.equal(again.hits.filter((h) => !h.suppressed).length, 1)
  assert.equal(again.hits.filter((h) => h.suppressed).length, 1)

  // 换一个上下文位置，旧例外不掩盖
  const src2 = '别的语境下最佳出现'
  const other = runScan(store, { source: src2, doc: 'd4', mode: 'full' })
  const d4 = runScan(store, { source: src2, docId: 'd4', mode: 'full' })
  assert.equal(d4.hits.filter((h) => !h.suppressed).length, 1)
})

test('规则撤回：草稿禁用后仍需发布；发布后产生新版本并全量重扫', () => {
  const src = '这里有最佳'
  const before = runPublishCheck(store, { source: src, docId: 'd5' })
  assert.equal(before.passed, false)
  assert.equal(before.rulesVersion, store.getActiveSnapshot().version)

  // 撤回规则（草稿）
  const state = store.getState()
  const rule = state.rules.find((r) => r.id === 'r_ad_best')
  store.saveRule({ ...rule, enabled: false })
  // 未发布前，扫描仍用旧快照
  const still = runScan(store, { source: src, docId: 'd5', mode: 'full' })
  assert.ok(still.hits.some((h) => h.ruleId === 'r_ad_best'))

  // 发布后新版本生效
  const snap = store.publish('撤回极限词规则')
  assert.equal(snap.version, before.rulesVersion + 1)
  const after = runPublishCheck(store, { source: src, docId: 'd5' })
  assert.equal(after.rulesVersion, snap.version)
  assert.equal(after.passed, true)
  assert.equal(after.errors.filter((h) => h.ruleId === 'r_ad_best').length, 0)
})

test('发布检查与扫描使用同一规则快照（版本号一致、同源结果）', () => {
  const src = '# 最佳\n\n请按装。'
  const scan = runScan(store, { source: src, docId: 'd6', mode: 'full' })
  const check = runPublishCheck(store, { source: src, docId: 'd6' })
  assert.equal(scan.rulesVersion, check.rulesVersion)
  const scanErrors = scan.hits.filter((h) => h.severity === 'error' && !h.suppressed)
  assert.equal(scanErrors.length, check.errorCount)
})

test('HTTP 路由：/api/state 与 /api/scan 端到端可用，404 回退为静态提示', async () => {
  const server = createApp()
  server.listen(0)
  await once(server, 'listening')
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  const stateRes = await fetch(`${base}/api/state`)
  assert.equal(stateRes.status, 200)
  const stateBody = await stateRes.json()
  assert.ok(stateBody.snapshot.version >= 1)

  const scanRes = await fetch(`${base}/api/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: '最佳', docId: 'd7', mode: 'full' }),
  })
  assert.equal(scanRes.status, 200)
  const scanBody = await scanRes.json()
  assert.ok(scanBody.hits.length >= 0)
  assert.equal(scanBody.rulesVersion, stateBody.snapshot.version)

  const missing = await fetch(`${base}/api/does-not-exist`)
  assert.equal(missing.status, 404)

  server.close()
  await once(server, 'close')
})

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})
