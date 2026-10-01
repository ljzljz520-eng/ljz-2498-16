// 文稿树解析：节点/片段的源码偏移与栏目 scope 必须准确。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalpa, allSegments } from '../src/shared/parse.js'

test('标题文本为 title scope，# 标记不入流', () => {
  const src = '# 标题词'
  const tree = parseCatalpa(src)
  assert.equal(tree.nodes[0].type, 'heading')
  const segs = allSegments(tree)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].scope, 'title')
  assert.equal(src.slice(segs[0].start, segs[0].end), '标题词')
})

test('段落/列表/引用为 body，围栏代码与行内代码为 code', () => {
  const src = [
    '正文 `x` 啊',
    '',
    '- 项一',
    '',
    '> 引用',
    '',
    '```js',
    'code line',
    '```',
  ].join('\n')
  const tree = parseCatalpa(src)
  const types = tree.nodes.map((n) => n.type)
  assert.deepEqual(types, ['paragraph', 'list', 'quote', 'code'])
  const byScope = { title: [], body: [], code: [] }
  for (const s of allSegments(tree)) byScope[s.scope].push(s)
  assert.ok(byScope.code.length >= 2)
  assert.ok(byScope.body.some((s) => src.slice(s.start, s.end).includes('正文')))
  // 行内 code 片段文本恰为 x
  const inlineCode = byScope.code.find((s) => src.slice(s.start, s.end) === 'x')
  assert.ok(inlineCode)
  const fence = byScope.code.find((s) => src.slice(s.start, s.end).includes('code line'))
  assert.ok(fence)
})

test('片段切片与原文字符逐一对应（偏移健全性）', () => {
  const src = '# A **粗** 体\n\n链 [文字](https://x.io) 尾\n'
  const tree = parseCatalpa(src)
  for (const s of allSegments(tree)) {
    assert.equal(src.slice(s.start, s.end), s.text)
    assert.ok(s.start >= 0 && s.end <= src.length)
  }
})

test('代码块整体 unit 保留内部换行，支持代码内跨行', () => {
  const src = '```\nab\ncd\n```'
  const tree = parseCatalpa(src)
  const code = tree.nodes[0]
  assert.equal(code.type, 'code')
  assert.equal(code.units.length, 1)
  assert.equal(src.slice(code.units[0].start, code.units[0].end), 'ab\ncd')
})
