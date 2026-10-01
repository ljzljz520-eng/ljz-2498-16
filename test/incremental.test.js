// 增量扫描：与全稿重扫结果逐条一致；跨节点短语在编辑后仍被正确重算；
// 规则快照版本变化后强制必要重算（旧缓存全部失效）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IncrementalScanner } from '../src/shared/incremental.js'
import { scanTree } from '../src/shared/proofreader.js'
import { parseCatalpa } from '../src/shared/parse.js'

const baseSnap = (version = 1, extraRules = []) => ({
  version,
  rules: [
    { id: 'cf', term: '成分', scopes: ['title', 'body', 'code'], rev: 1 },
    { id: 'zj', term: '最佳', scopes: ['title', 'body'], rev: 1 },
    { id: 'todo', term: 'todo', scopes: ['code'], rev: 1 },
    ...extraRules,
  ],
  wordForms: [{ from: '成份', to: '成分' }],
  exceptions: [],
})

function keyOf(f) {
  return `${f.ruleId}:${f.start}:${f.end}:${f.coveredText}`
}
function equalFindings(a, b) {
  return JSON.stringify(a.map(keyOf).sort()) === JSON.stringify(b.map(keyOf).sort())
}

const BASE = `# 成分标题

第一段成分在这里，最佳方案。

- 列表成分项
- 最佳列表项

> 引用成分

\`\`\`js
const todo = 1 // 最佳不在代码范围
\`\`\`

尾部成分结束，最佳收尾。`

test('首次全量结果与 scanTree 一致', () => {
  const snap = baseSnap()
  const sc = new IncrementalScanner(snap, {})
  const inc = sc.fullScan(BASE)
  const full = scanTree(parseCatalpa(BASE), snap, {})
  assert.ok(equalFindings(inc, full))
})

test('增量扫描：随机插入/删除序列与全量始终一致', () => {
  let seed = 987654321
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const inserts = ['成分', '成份', 'x', '最佳', '\n', '\n\n# 新成分标题', 'todo ', ' ', '分']
  const sc = new IncrementalScanner(baseSnap(), {})
  let cur = BASE
  sc.fullScan(cur)
  let count = 0
  for (let i = 0; i < 200; i += 1) {
    const pos = Math.floor(rng() * cur.length)
    let next
    let change
    if (rng() < 0.55) {
      const ins = inserts[Math.floor(rng() * inserts.length)]
      next = cur.slice(0, pos) + ins + cur.slice(pos)
      change = { start: pos, end: pos, newEnd: pos + ins.length }
    } else {
      const dl = Math.min(cur.length - pos, 1 + Math.floor(rng() * 5))
      next = cur.slice(0, pos) + cur.slice(pos + dl)
      change = { start: pos, end: pos + dl, newEnd: pos }
    }
    const inc = sc.update(next, change)
    const full = scanTree(parseCatalpa(next), baseSnap(), {})
    assert.ok(equalFindings(inc, full), `iter ${i} mismatch: ${JSON.stringify(change)}`)
    cur = next
    count += 1
  }
  assert.ok(count === 200)
})

test('跨节点短语：在边界附近插入文字后增量仍能命中跨界短语', () => {
  const snap = baseSnap()
  const sc = new IncrementalScanner(snap, {})
  // 初始：两节点分别含半个词，不连续
  let cur = '- 项一成\n\n> 另一处'
  sc.fullScan(cur)
  // 把引用改成“分”开头，形成跨 list/quote 的“成分”
  const idx = cur.indexOf('另一处')
  const next = cur.slice(0, idx) + '分列引用' + cur.slice(idx + 3)
  const change = { start: idx, end: idx + 3, newEnd: idx + 4 }
  const inc = sc.update(next, change)
  const cross = inc.find((f) => f.ruleId === 'cf' && f.nodeIds.length >= 2)
  assert.ok(cross, '增量必须重算跨界窗口并命中跨节点“成分”')
  assert.equal(cross.coveredText, '成分')
  assert.ok(equalFindings(inc, scanTree(parseCatalpa(next), snap, {})))
})

test('远距离节点的命中在不相关编辑后保持正确（窗口外复用）', () => {
  const snap = baseSnap()
  const sc = new IncrementalScanner(snap, {})
  sc.fullScan(BASE)
  // 在文档开头插入，尾部“最佳收尾”不应丢失或错位
  const next = '新' + BASE
  const change = { start: 0, end: 0, newEnd: 1 }
  const inc = sc.update(next, change)
  const full = scanTree(parseCatalpa(next), snap, {})
  assert.ok(equalFindings(inc, full))
  assert.ok(inc.some((f) => f.coveredText.includes('最佳')  && f.start > 80))
})

test('规则快照版本变化：setSnapshot 丢弃缓存，按新规则全量重算', () => {
  const sc = new IncrementalScanner(baseSnap(1), {})
  sc.fullScan(BASE)
  const beforeCount = scanTree(parseCatalpa(BASE), baseSnap(1), {}).length
  assert.ok(beforeCount > 0)
  // v2 撤回“最佳”（从规则集合移除）并新增“方案”规则
  const v2 = baseSnap(2, [{ id: 'fa', term: '方案', scopes: ['body'], rev: 1 }])
  v2.rules = v2.rules.filter((r) => r.id !== 'zj')
  sc.setSnapshot(v2)
  const inc = sc.update(BASE, { start: 0, end: 0, newEnd: 0 })
  const full = scanTree(parseCatalpa(BASE), v2, {})
  assert.ok(equalFindings(inc, full))
  assert.ok(!inc.some((f) => f.ruleId === 'zj'))
  assert.ok(inc.some((f) => f.term === '方案'))
})

test('无 change 信息时退化为全量重算', () => {
  const snap = baseSnap()
  const sc = new IncrementalScanner(snap, {})
  sc.fullScan(BASE)
  const inc = sc.update(BASE + '\n\n新增成分', null)
  const full = scanTree(parseCatalpa(BASE + '\n\n新增成分'), snap, {})
  assert.ok(equalFindings(inc, full))
})
