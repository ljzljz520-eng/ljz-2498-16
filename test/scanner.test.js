import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalpa, toNodes } from '../src/core/parser.js'
import { compileRules, scanDocument, exceptionKey } from '../src/core/scanner.js'

function scan(source, rules, mappings = [], exceptions = [], opts = {}) {
  const nodes = toNodes(parseCatalpa(source))
  const compiled = compileRules(rules, mappings)
  return scanDocument(nodes, compiled, mappings, { source, docId: 'd1', exceptions, ...opts })
}

const bestRule = (over = {}) => ({
  id: 'r1',
  version: 1,
  pattern: '最佳',
  severity: 'error',
  message: '极限词',
  suggestions: ['很出色'],
  scopes: ['title', 'body', 'quote'],
  crossNode: true,
  enabled: true,
  ...over,
})

test('不同栏目（标题/正文/引用/代码）采用不同适用范围', () => {
  const src = '# 最佳标题\n\n正文最佳\n\n> 引用最佳\n\n```\n最佳code\n```\n'
  const textRule = bestRule()
  const codeRule = { id: 'r2', version: 1, pattern: '最佳code', scopes: ['code'], enabled: true }

  const { hits } = scan(src, [textRule, codeRule])
  const r1 = hits.filter((h) => h.ruleId === 'r1')
  const r2 = hits.filter((h) => h.ruleId === 'r2')

  assert.equal(r1.length, 3) // 标题、正文、引用；代码中的“最佳”不被文本规则命中
  assert.deepEqual(r1.map((h) => h.scopes[0]).sort(), ['body', 'quote', 'title'])
  assert.equal(r2.length, 1)
  assert.deepEqual(r2[0].scopes, ['code'])

  // 命中位置映射回原始文本
  assert.equal(src.slice(r1[0].start, r1[0].end), '最佳')
})

test('跨段（段落内换行）短语命中，片段保留真实原文', () => {
  const src = '如需联系\n客服请说明问题。'
  const rule = { id: 'r', version: 1, pattern: '联系客服', scopes: ['body'], enabled: true }
  const { hits } = scan(src, [rule])
  assert.equal(hits.length, 1)
  assert.equal(hits[0].snippet, '联系\n客服')
  assert.deepEqual([hits[0].start, hits[0].end], [2, 7])
  assert.equal(src.slice(hits[0].start, hits[0].end), '联系\n客服')
})

test('跨节点（两个段落）短语命中，nodeIds 覆盖多个节点', () => {
  const src = '第一段末尾联系\n\n客服在第二段。'
  const rule = { id: 'r', version: 1, pattern: '联系客服', scopes: ['body'], enabled: true }
  const { hits } = scan(src, [rule])
  assert.equal(hits.length, 1)
  assert.ok(hits[0].nodeIds.length >= 2)
  assert.equal(hits[0].snippet, '联系\n\n客服') // 原始切片保留段落空行；折叠态才是连续的“联系客服”
})

test('crossNode=false 时不允许跨节点短语', () => {
  const src = '第一段末尾联系\n\n客服在第二段。'
  const rule = { id: 'r', version: 1, pattern: '联系客服', scopes: ['body'], crossNode: false, enabled: true }
  const { hits } = scan(src, [rule])
  assert.equal(hits.length, 0)
})

test('分割线阻断跨节点短语', () => {
  const src = '这里说联系\n\n---\n\n客服在下一部分。'
  const rule = { id: 'r', version: 1, pattern: '联系客服', scopes: ['body'], enabled: true }
  const { hits } = scan(src, [rule])
  assert.equal(hits.length, 0)
})

test('零宽字符插在禁用词中间仍命中，且命中区间精确覆盖原始字符（不会因长度变化标错字）', () => {
  const src = '最​佳产品'
  const { hits } = scan(src, [bestRule()])
  assert.equal(hits.length, 1)
  // 原始区间包含零宽字符，高亮只会罩住真正相关的 3 个码元
  assert.deepEqual([hits[0].start, hits[0].end], [0, 3])
  assert.equal(src.slice(0, 3), '最​佳')
})

test('词形映射：异体写法命中同一规则，位置映射回原始异体字符', () => {
  const src = '这里是帳号问题'
  const rule = { id: 'r', version: 1, pattern: '账号', scopes: ['body'], enabled: true }
  const { hits } = scan(src, [rule], [['帳', '账']])
  assert.equal(hits.length, 1)
  assert.equal(src.slice(hits[0].start, hits[0].end), '帳号')
})

test('人工例外绑定规则与具体片段+上下文：只压制该位置，不影响其它出现', () => {
  const src = '最佳 与 最佳'
  const { hits: all } = scan(src, [bestRule()])
  assert.equal(all.length, 2)

  const target = all[0]
  const exceptions = [
    {
      ruleId: 'r1',
      docId: 'd1',
      snippet: target.foldSnippet,
      contextBefore: target.contextBefore,
      contextAfter: target.contextAfter,
    },
  ]
  const { hits } = scan(src, [bestRule()], [], exceptions)
  const active = hits.filter((h) => !h.suppressed)
  const suppressed = hits.filter((h) => h.suppressed)
  assert.equal(active.length, 1)
  assert.equal(suppressed.length, 1)
  assert.equal(active[0].start, target.end + (5 - target.end))
})

test('例外不是全局忽略：上下文变化后旧例外不再掩盖命中', () => {
  const src = '这里最佳很好'
  const { hits: first } = scan(src, [bestRule()])
  const target = first[0]
  const exceptions = [
    { ruleId: 'r1', docId: 'd1', snippet: target.foldSnippet, contextBefore: target.contextBefore, contextAfter: target.contextAfter },
  ]
  // 文本改为不同上下文（新版本文稿）
  const src2 = '那里最佳很差'
  const { hits } = scan(src2, [bestRule()], [], exceptions)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].suppressed, false) // 旧例外无法掩盖新版本
})

test('规则撤回（enabled=false / 新版本缺失）后不再命中', () => {
  const src = '最佳产品'
  const { hits: before } = scan(src, [bestRule()])
  assert.equal(before.length, 1)
  const { hits: after } = scan(src, [bestRule({ enabled: false })])
  assert.equal(after.length, 0)
})

test('行内标记不阻断短语，且标记内文本范围正确', () => {
  const src = '这是**最佳**方案'
  const { hits } = scan(src, [bestRule({ scopes: ['body'] })])
  assert.equal(hits.length, 1)
  assert.equal(src.slice(hits[0].start, hits[0].end), '最佳')
})

test('exceptionKey 与规则版本解耦但与片段/上下文绑定，规则重写产生新片段签名', () => {
  const k1 = exceptionKey('r1', 'd1', '最佳', '这里', '很好')
  const k2 = exceptionKey('r1', 'd1', '最佳', '这里', '很好')
  const k3 = exceptionKey('r1', 'd1', '最佳', '那里', '很好')
  assert.equal(k1, k2)
  assert.notEqual(k1, k3)
})
