// Unicode 规范化偏移映射测试：零宽字符、全角、合字展开后命中位置必须映射回
// 原始文本，不能因长度变化标错字。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldText, origRangeForMatch, isCjk, ZERO_WIDTH_CHARS } from '../src/shared/unicode.js'

test('全角字母 NFKC 折叠后可命中，偏移映射回原始全角字符', () => {
  const text = 'ＡＢｃ'
  const f = foldText(text)
  assert.equal(f.folded, 'abc')
  const at = f.folded.indexOf('abc')
  const r = origRangeForMatch(f, at, at + 3)
  assert.equal(text.slice(r.start, r.end), 'ＡＢｃ')
})

test('零宽字符被跳过：夹零宽的命中仍精确还原原始区间', () => {
  const zw = ZERO_WIDTH_CHARS[0]
  const zwj = ZERO_WIDTH_CHARS[2]
  const text = `前${zw}Ｔ${zwj}ＯＤＯ后`
  const f = foldText(text)
  // 折叠后零宽消失，ＴＯＤＯ -> todo
  const idx = f.folded.indexOf('todo')
  assert.ok(idx >= 0)
  const r = origRangeForMatch(f, idx, idx + 4)
  const sliced = text.slice(r.start, r.end)
  assert.ok(sliced.includes('Ｔ'))
  assert.ok(sliced.includes('Ｏ'))
  // 起始必须是第一个命中字符 Ｔ，而不是前面的零宽或“前”
  assert.equal(r.start, text.indexOf('Ｔ'))
})

test('合字 ﬁ/ﬀ NFKC 展开为多字符，映射覆盖整个原始码点', () => {
  const text = 'ﬀoo'
  const f = foldText(text)
  assert.equal(f.folded, 'ffoo')
  const idx = f.folded.indexOf('ffoo')
  const r = origRangeForMatch(f, idx, idx + 4)
  assert.equal(text.slice(r.start, r.end), 'ﬀoo')
  assert.equal(r.start, 0)
  assert.equal(r.end, 3) // ﬀ 是 1 个 UTF-16 单元 + oo
})

test('代理对（emoji/CJK 扩展 B）锚点不越界', () => {
  const text = '𠀀好x'
  const f = foldText(text)
  assert.equal(f.folded, '𠀀好x')
  assert.deepEqual(f.origIndex, [0, 0, 2, 3])
  const r = origRangeForMatch(f, 0, 1)
  assert.equal(text.slice(r.start, r.end), '𠀀')
})

test('anchorOf 对零宽删除点回填到下一锚点', () => {
  const zw = ZERO_WIDTH_CHARS[0]
  const text = `a${zw}b`
  const f = foldText(text)
  assert.equal(f.folded, 'ab')
  // 零宽位置（索引1）回填到 'b' 的折叠位置
  assert.equal(f.anchorOf(1), 1)
  assert.equal(f.anchorOf(0), 0)
  assert.equal(f.anchorOf(2), 1)
})

test('isCjk 覆盖基本区', () => {
  assert.equal(isCjk('成'), true)
  assert.equal(isCjk('a'), false)
})

void ZERO_WIDTH_CHARS
