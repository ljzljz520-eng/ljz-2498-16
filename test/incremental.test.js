import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalpa, toNodes } from '../src/core/parser.js'
import { compileRules, scanDocument, maxPatternLength } from '../src/core/scanner.js'
import { foldString } from '../src/core/fold.js'
import {
  alignNodes,
  planIncremental,
  mergeIncremental,
  mustFullScan,
  hashExceptions,
} from '../src/core/incremental.js'

const rules = [
  { id: 'r1', version: 1, pattern: '最佳', scopes: ['title', 'body', 'quote'], enabled: true },
  { id: 'r2', version: 1, pattern: '联系客服', scopes: ['body'], enabled: true },
]
const mappings = []

function build(source) {
  const nodes = toNodes(parseCatalpa(source))
  const compiled = compileRules(rules, mappings)
  for (const n of nodes) n._foldLen = [...foldString(n.rawText, mappings).text].length
  return { nodes, compiled, maxLen: maxPatternLength(compiled) }
}

function fullScan(source) {
  const { nodes, compiled } = build(source)
  nodes.forEach((n, i) => (n.id = `n${i}`))
  const { hits } = scanDocument(nodes, compiled, mappings, { source })
  return { nodes, hits }
}

test('LCS 对齐：内容相同、位置移动的节点复用同一 id', () => {
  const { alignment } = alignNodes(['a', 'b', 'c'], ['x', 'a', 'c', 'y'])
  // a:0->1, c:2->2；b 被删除，x/y 为新增
  assert.equal(alignment.get(0), 1)
  assert.equal(alignment.get(2), 2)
  assert.ok(!alignment.has(1))
})

test('编辑中间节点：仅脏节点及其模式窗口邻居受影响', () => {
  const src = ['第一段内容', '第二段内容', '第三段内容'].join('\n\n')
  const { nodes } = build(src)
  const prev = nodes.map((n, i) => ({ id: `n${i}`, key: n.key, foldLen: n._foldLen }))

  const src2 = ['第一段内容', '第二段改成了最佳', '第三段内容'].join('\n\n')
  const next = build(src2)
  const plan = planIncremental(
    prev,
    next.nodes.map((n) => n.key),
    next.nodes.map((n) => n._foldLen),
    next.maxLen,
  )
  assert.equal(plan.dirty.size, 1)
  assert.ok(plan.affected.has([...plan.dirty][0]))
  // 未变化的首尾节点保持原 id
  assert.equal(plan.assignment[0], 'n0')
  assert.equal(plan.assignment[2], 'n2')
})

test('增量重扫 + 合并：新增禁用词出现，无关旧命中保留，窗口内旧命中原位更新', () => {
  const src = ['开头最佳', '中间内容', '结尾最佳'].join('\n\n')
  const before = fullScan(src)
  assert.equal(before.hits.length, 2)

  const src2 = ['开头最佳', '中间内容改成最佳', '结尾最佳'].join('\n\n')
  const next = build(src2)
  const prevSummary = before.nodes.map((n, i) => ({
    id: n._scanId,
    key: n.key,
    foldLen: n._foldLen,
  }))
  const plan = planIncremental(
    prevSummary,
    next.nodes.map((n) => n.key),
    next.nodes.map((n) => n._foldLen),
    next.maxLen,
  )
  next.nodes.forEach((n, i) => (n.id = plan.assignment[i]))

  const { hits: windowHits } = scanDocument(next.nodes, compileRules(rules, []), [], {
    source: src2,
    nodeFilter: plan.affected,
  })
  const merged = mergeIncremental(before.hits, windowHits, plan.affected, plan.deletedIds)
  assert.equal(merged.length, 3) // 两个旧命中 + 一个新命中
})

test('删除节点：相邻节点进入重算窗口，跨边界旧短语被清除', () => {
  // “联系”在段 A、“客服”在段 B（相邻段落，折叠后命中跨节点短语）
  const src = '文首联系\n\n客服在后\n\n结尾内容'
  const before = fullScan(src)
  const crossHits = before.hits.filter((h) => h.ruleId === 'r2')
  assert.equal(crossHits.length, 1)

  // 删除中间的“客服”段
  const src2 = '文首联系\n\n结尾内容'
  const next = build(src2)
  const prevSummary = before.nodes.map((n) => ({
    id: n._scanId,
    key: n.key,
    foldLen: n._foldLen,
  }))
  const plan = planIncremental(
    prevSummary,
    next.nodes.map((n) => n.key),
    next.nodes.map((n) => n._foldLen),
    next.maxLen,
  )
  next.nodes.forEach((n, i) => (n.id = plan.assignment[i]))
  const { hits: windowHits } = scanDocument(next.nodes, compileRules(rules, []), [], {
    source: src2,
    nodeFilter: plan.affected,
  })
  const merged = mergeIncremental(before.hits, windowHits, plan.affected, plan.deletedIds)
  assert.equal(merged.filter((h) => h.ruleId === 'r2').length, 0)
})

test('插入不相邻窗口不会产生跨窗口假命中（屏障）', () => {
  // 两个受影响窗口分别以“联系”“客服”结尾/开头但中间隔了未变节点
  const src = '联系\n\n中间很长的一段隔开内容\n\n客服'
  const { nodes, compiled } = build(src)
  nodes.forEach((n, i) => (n.id = `n${i}`))
  // 只把第 0 与第 2 个节点放入过滤窗口（模拟它们各自变脏但中间节点不在窗口）
  const filter = new Set(['n0', 'n2'])
  const { hits } = scanDocument(nodes, compiled, [], { source: src, nodeFilter: filter })
  assert.equal(hits.length, 0) // 屏障阻止“联系客服”假命中
})

test('规则/词形/例外集合版本变化时必须全量重算', () => {
  assert.equal(mustFullScan(null, { rulesVersion: 1 }), true)
  assert.equal(
    mustFullScan({ rulesVersion: 1, mappingsVersion: 1, exceptionsHash: 'x' },
      { rulesVersion: 2, mappingsVersion: 1, exceptionsHash: 'x' }),
    true,
  )
  assert.equal(
    mustFullScan({ rulesVersion: 1, mappingsVersion: 1, exceptionsHash: 'x' },
      { rulesVersion: 1, mappingsVersion: 1, exceptionsHash: 'y' }),
    true,
  )
  assert.equal(
    mustFullScan({ rulesVersion: 1, mappingsVersion: 1, exceptionsHash: 'x' },
      { rulesVersion: 1, mappingsVersion: 1, exceptionsHash: 'x' }),
    false,
  )
})

test('例外集合哈希随内容变化（新增/撤销例外都会触发全量）', () => {
  const h1 = hashExceptions([{ ruleId: 'r', snippet: 'a', contextBefore: '', contextAfter: '' }])
  const h2 = hashExceptions([
    { ruleId: 'r', snippet: 'a', contextBefore: '', contextAfter: '' },
    { ruleId: 'r', snippet: 'b', contextBefore: '', contextAfter: '' },
  ])
  assert.notEqual(h1, h2)
})

test('在命中节点之前插入节点：保留命中用锚点重定位，绝对偏移随之下移', () => {
  const src = '前文最佳\n\n第二段内容'
  const before = fullScan(src)
  const bestHit = before.hits.find((h) => h.ruleId === 'r1')
  assert.equal(bestHit.start, src.indexOf('最佳'))
  assert.ok(bestHit.anchor, '命中带节点相对锚点')

  // 在最前面插入一个新段落，旧节点整体下移
  const insertion = '新插入的开头段落\n\n'
  const src2 = insertion + src
  const next = build(src2)
  const prevSummary = before.nodes.map((n) => ({
    id: n._scanId, key: n.key, foldLen: n._foldLen,
  }))
  const plan = planIncremental(
    prevSummary,
    next.nodes.map((n) => n.key),
    next.nodes.map((n) => n._foldLen),
    next.maxLen,
  )
  next.nodes.forEach((n, i) => (n.id = plan.assignment[i]))

  // 新插入节点变脏；旧“前文最佳”节点不在受影响窗口（距插入点超过最长模式长度）
  const { hits: windowHits } = scanDocument(next.nodes, compileRules(rules, []), [], {
    source: src2,
    nodeFilter: plan.affected,
  })
  const nodeById = new Map(next.nodes.map((n) => [n.id, n]))
  const merged = mergeIncremental(
    before.hits, windowHits, plan.affected, plan.deletedIds, nodeById, src2,
  )
  const moved = merged.find((h) => h.hitId === bestHit.hitId)
  assert.ok(moved, '旧命中通过锚点保留')
  assert.equal(moved.start, src2.indexOf('最佳'), '绝对偏移正确下移')
  assert.equal(src2.slice(moved.start, moved.end), '最佳', '高亮罩住的仍是原文中的“最佳”')
})
