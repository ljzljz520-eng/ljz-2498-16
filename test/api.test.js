// 服务端 API 集成测试：规则/词形/例外维护、快照发布与 rev 提升、扫描 API
// （全量 vs 增量对照）、文稿版本、发布检查闸门、浏览器提示与发布检查同快照。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { tmpdir } from 'node:os'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DATA_DIR = fs.mkdtempSync(path.join(tmpdir(), 'proof-test-'))

const PORT = 3311
const BASE = `http://127.0.0.1:${PORT}`
let child
let ready = false

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

before(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PROOF_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) ready = true })
  child.stderr.on('data', () => {})
  for (let i = 0; i < 50 && !ready; i += 1) await sleep(100)
  assert.ok(ready, 'server should start')
})

after(async () => {
  child?.kill('SIGTERM')
  await sleep(100)
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

test('健康检查与初始快照播种', async () => {
  const { data } = await api('GET', '/api/health')
  assert.equal(data.ok, true)
  assert.ok(data.snapshot >= 1)
})

test('浏览器拉取的当前快照包含规则/词形/例外结构', async () => {
  const { data } = await api('GET', '/api/snapshots/current')
  assert.ok(Array.isArray(data.snapshot.rules))
  assert.ok(Array.isArray(data.snapshot.wordForms))
  assert.ok(Array.isArray(data.snapshot.exceptions))
})

test('创建带栏目范围的规则并发布，扫描只在指定范围命中', async () => {
  const created = await api('POST', '/api/rules', {
    term: '禁止语',
    note: '测试规则',
    suggestions: ['合规说法'],
    scopes: ['title'],
  })
  assert.equal(created.status, 200)
  const pub = await api('POST', '/api/snapshots/publish', { note: '标题规则' })
  assert.equal(pub.status, 200)
  const content = '# 禁止语标题\n\n正文也有禁止语但不应命中'
  const scan = await api('POST', '/api/scan', { content, version: pub.data.version })
  const hits = scan.data.findings.filter((f) => f.term === '禁止语')
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0].scopes, ['title'])
})

test('全量 vs 增量扫描结果一致（modeReport.equal）', async () => {
  const baseline = '# 成份报告\n\n旧内容成分'
  const content = '# 成份报告\n\n新内容成分，更多文字'
  const r = await api('POST', '/api/scan', {
    content,
    baseline,
    mode: 'incremental',
    change: { start: 9, end: 13, newEnd: 18 },
    includeSuppressed: true,
  })
  assert.equal(r.status, 200)
  assert.equal(r.data.modeReport.equal, true)
  assert.equal(r.data.modeReport.incrementalFindingCount, r.data.modeReport.fullFindingCount)
})

test('零宽/全角内容扫描：命中位置映射回原始文本', async () => {
  const zw = '​'
  // TODO 规则仅在 code 范围：用行内代码包裹；零宽/全角在折叠层归一化
  const content = '正文 `' + `${zw}ＴＯＤＯ${zw}` + '` 结束'
  const r = await api('POST', '/api/scan', { content })
  const todo = r.data.findings.find((f) => f.term === 'TODO')
  assert.ok(todo, '应在 code 范围命中全角+零宽 TODO')
  assert.equal(content[todo.start], 'Ｔ')
  assert.equal(content.slice(todo.start, todo.end).replace(/[​‌‍﻿]/g, ''), 'ＴＯＤＯ')
})

test('人工例外绑定具体片段后静默；另一个词不受影响', async () => {
  const content = '这里有成份，也有账号'
  const snap = await api('GET', '/api/snapshots/current')
  const cfRule = snap.data.snapshot.rules.find((x) => x.term === '成份')
  assert.ok(cfRule)
  const ex = await api('POST', '/api/exceptions', {
    ruleId: cfRule.id,
    ruleRev: cfRule.rev,
    docId: '*',
    fragment: '成份',
    snapshotVersion: snap.data.snapshot.version,
  })
  assert.equal(ex.status, 200)
  // 发布使例外进入快照
  await api('POST', '/api/snapshots/publish', { note: '加入成份例外' })
  const r = await api('POST', '/api/scan', { content, includeSuppressed: true })
  const cf = r.data.findings.find((f) => f.ruleId === cfRule.id)
  assert.equal(cf.suppressed, true)
  // 账号规则未加例外，仍提示
  assert.ok(r.data.findings.some((f) => f.term === '账号' && !f.suppressed))
})

test('规则修订（替换建议变化）发布后 rev+1，旧 rev 例外不再掩盖命中', async () => {
  const snap = await api('GET', '/api/snapshots/current')
  const cfRule = snap.data.snapshot.rules.find((x) => x.term === '成份')
  // 修改规则 -> 发布 -> rev 增加
  await api('PUT', `/api/rules/${cfRule.id}`, {
    suggestions: ['成分', '化学成分'],
    scopes: cfRule.scopes,
  })
  const pub = await api('POST', '/api/snapshots/publish', { note: '修订成份建议' })
  const changed = pub.data.revChanges.find((c) => c.ruleId === cfRule.id)
  assert.ok(changed)
  assert.equal(changed.rev, cfRule.rev + 1)
  const r = await api('POST', '/api/scan', { content: '成份', includeSuppressed: true })
  const f = r.data.findings.find((x) => x.ruleId === cfRule.id)
  assert.equal(f.suppressed, false)
  assert.equal(f.suppressedReason, 'rule-revision-changed')
})

test('规则撤回（停用）后发布：该规则不再产生命中', async () => {
  const snap = await api('GET', '/api/snapshots/current')
  const zj = snap.data.snapshot.rules.find((x) => x.term === '账号')
  assert.ok(zj)
  await api('POST', `/api/rules/${zj.id}/retract`)
  await api('POST', '/api/snapshots/publish', { note: '撤回账号规则' })
  const r = await api('POST', '/api/scan', { content: '这里有账号' })
  assert.equal(r.data.findings.some((f) => f.ruleId === zj.id), false)
})

test('文稿版本与发布检查：有命中则拒绝，处理后通过并记录发布', async () => {
  const docId = `doc_${Date.now()}`
  // 先保存一个“有命中”的版本
  const bad = '成份又出现了'
  const saveBad = await api('POST', `/api/documents/${docId}/versions`, { content: bad })
  const check1 = await api('POST', '/api/publish-check', {
    docId,
    docVersion: saveBad.data.version.version,
  })
  assert.equal(check1.data.allowed, false)
  assert.ok(check1.data.blocking.length >= 1)
  assert.equal(check1.data.published, null)
  // 保存一个干净版本（成份规则已撤回建议修订？此规则仍启用；用合规词）
  const good = '这是一份完全合规的文稿'
  const saveGood = await api('POST', `/api/documents/${docId}/versions`, { content: good })
  const check2 = await api('POST', '/api/publish-check', {
    docId,
    docVersion: saveGood.data.version.version,
    confirm: true,
  })
  assert.equal(check2.data.allowed, true)
  assert.equal(check2.data.blocking.length, 0)
  assert.equal(check2.data.published.ruleVersion, check2.data.ruleVersion)
})

test('发布检查使用的 ruleVersion 与浏览器 /snapshots/current 一致（同快照）', async () => {
  const cur = await api('GET', '/api/snapshots/current')
  const r = await api('POST', '/api/publish-check', { content: '干净文本' })
  assert.equal(r.data.ruleVersion, cur.data.snapshot.version)
  assert.equal(r.data.rulePublishedAt, cur.data.snapshot.publishedAt)
})
