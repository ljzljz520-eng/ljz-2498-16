import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldString, createFolder } from '../src/core/fold.js'

test('零宽字符被删除且不改变后续字符的原始偏移映射', () => {
  // a + ZWSP + ZWNJ + b
  const raw = 'a​‌b'
  const { text, chars } = foldString(raw, [])
  assert.equal(text, 'ab')
  assert.deepEqual(chars[0].from, [0, 1])
  assert.deepEqual(chars[1].from, [3, 4]) // 两个零宽字符（每个 1 码元）被跳过
})

test('NFKC 收缩：ﬁ 拆为 f/i，但都映射回原始 ligature 区间', () => {
  const raw = 'ﬁ'
  const { text, chars } = foldString(raw, [])
  assert.equal(text, 'fi')
  assert.deepEqual(chars[0].from, [0, 1])
  assert.deepEqual(chars[1].from, [0, 1])
  // 用映射回的区间切片原文，两个字符都指向同一个原始字符
  assert.equal(raw.slice(chars[0].from[0], chars[0].from[1]), 'ﬁ')
})

test('NFKC 扩展：单个兼容字符展开为多字符，位置都指向原单字符', () => {
  // U+337F SQUARE PA -> 'PA'; U+FF21 全角 A -> A（单码元，验证偏移不串）
  const raw = '㍿'
  const { text, chars } = foldString(raw, [])
  assert.equal(text, '株式会社')
  assert.equal(chars.length, 4)
  for (const c of chars) assert.deepEqual(c.from, [0, 1])
})

test('自定义多字词形映射（最长优先），命中区间覆盖被替换的整段原文', () => {
  const { text, chars } = foldString('我们聯係你们', [['聯係', '联系']])
  assert.equal(text, '我们联系你们')
  const lian = chars[2]
  const xi = chars[3]
  assert.equal(lian.ch, '联')
  assert.equal(xi.ch, '系')
  assert.deepEqual(lian.from, [2, 4])
  assert.deepEqual(xi.from, [2, 4])
})

test('折叠流跨多次 push 仍能命中跨段多字映射', () => {
  const folder = createFolder([['聯係', '联系']])
  folder.push('聯', 0)
  folder.push('係', 1)
  const { text, chars } = folder.finish()
  assert.equal(text, '联系')
  // 映射替换了整段原文，两个折叠字符都覆盖 [0,2)，切片仍精确指向被映射片段
  assert.deepEqual(chars[0].from, [0, 2])
  assert.deepEqual(chars[1].from, [0, 2])
})

test('基字符 + 组合记号被 NFC 组合时区间合并', () => {
  // e + U+0301
  const raw = 'é'
  const { text, chars } = foldString(raw, [])
  assert.equal(text, 'é')
  assert.equal(chars.length, 1)
  assert.deepEqual(chars[0].from, [0, 2])
})
