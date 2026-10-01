// 扫描引擎：栏目范围、词形映射、零宽、跨段/跨节点命中、整词、大小写、
// 人工例外（规则+片段+rev 绑定，无全局忽略，规则撤回/修订后旧例外失效）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalpa } from '../src/shared/parse.js'
import { scanTree, normalizeKey } from '../src/shared/proofreader.js'

const snap = (rules, extras = {}) => ({
  version: 1,
  rules,
  wordForms: extras.wordForms || [],
  exceptions: extras.exceptions || [],
})

const key = (f) => `${f.ruleId}:${f.start}:${f.end}`
const terms = (fs) => fs.map((f) => f.matchedText)

test('栏目范围：title/body/code 互不串扰', () => {
  const src = '# TODO\n\n正文 TODO\n\n```\nTODO\n```'
  const tree = parseCatalpa(src)
  assert.equal(scanTree(tree, snap([{ id: 'r', term: 'TODO', scopes: ['title'], rev: 1 }])).length, 1)
  assert.equal(scanTree(tree, snap([{ id: 'r', term: 'TODO', scopes: ['body'], rev: 1 }])).length, 1)
  assert.equal(scanTree(tree, snap([{ id: 'r', term: 'TODO', scopes: ['code'], rev: 1 }])).length, 1)
  const all = scanTree(tree, snap([{ id: 'r', term: 'TODO', scopes: ['title', 'body', 'code'], rev: 1 }]))
  assert.equal(all.length, 3)
})

test('规则仅在指定栏目命中（标题规则不在正文命中）', () => {
  const src = '# 最佳\n\n最佳正文'
  const tree = parseCatalpa(src)
  const titleOnly = scanTree(tree, snap([{ id: 'r', term: '最佳', scopes: ['title'], rev: 1 }]))
  assert.deepEqual(titleOnly.map((f) => f.start), [2])
})

test('词形映射：异体“成份”命中禁用词“成份”规则', () => {
  const tree = parseCatalpa('成份与成分都应命中')
  const fs = scanTree(tree, snap(
    [{ id: 'r', term: '成份', suggestions: ['成分'], scopes: ['body'], rev: 1 }],
    { wordForms: [{ from: '成份', to: '成分' }] },
  ))
  // 禁用词成份与其异体形态被标记；建议词“成分”不作为模式（避免替换后再报）
  assert.deepEqual(terms(fs), ['成份'])
})

test('禁用词与建议词同时出现在词形闭包中时，建议词写法不产生命中', () => {
  const tree = parseCatalpa('已经改成成分了')
  const fs = scanTree(tree, snap(
    [{ id: 'r', term: '成份', suggestions: ['成分'], scopes: ['body'], rev: 1 }],
    { wordForms: [{ from: '成份', to: '成分' }] },
  ))
  assert.equal(fs.length, 0)
})

test('零宽字符与全角：命中位置映射回原始文本', () => {
  const zw = '​'
  const src = `这${zw}Ｔ${zw}ＯＤＯ${zw}哦`
  const tree = parseCatalpa(src)
  const fs = scanTree(tree, snap([{ id: 'r', term: 'TODO', scopes: ['body'], rev: 1 }]))
  assert.equal(fs.length, 1)
  const f = fs[0]
  // 起点必须是第一个被折叠的可见字符 Ｔ（不能落在前导零宽上）
  assert.equal(src[f.start], 'Ｔ')
  assert.equal(f.start, src.indexOf('Ｔ'))
  // 终点必须在最后一个 Ｏ 之后（不能落在尾随零宽上）
  assert.equal(f.end, src.lastIndexOf('Ｏ') + 1)
  assert.equal(src.slice(f.start, f.end).replace(/[​‌‍﻿]/g, ''), 'ＴＯＤＯ')
})

test('跨段命中：短语跨越 粗体/行内代码 等片段边界', () => {
  // “禁用短语”被粗体标记切成两段：禁用**短语**
  const src = '禁用**短语**结束'
  const tree = parseCatalpa(src)
  const fs = scanTree(tree, snap([{
    id: 'r', term: '禁用短语', scopes: ['body'], suggestions: ['X'], rev: 1,
  }]))
  assert.equal(fs.length, 1)
  const f = fs[0]
  assert.equal(f.start, 0)
  // 叶子拼接文本不含 ** 标记；原文切片会包含标记
  assert.equal(f.coveredText, '禁用短语')
  // 原文切片：从“禁”到“语”之后（第二个 * 是闭标记，不含在叶子区间内）
  assert.ok(f.matchedText.startsWith('禁用**短语'))
  assert.ok(!f.matchedText.endsWith('**'), f.matchedText)
  // 高亮由 renderer 与每段求交：两个叶子片段区间各自完整
  assert.equal(f.coveredRanges[0].end - f.coveredRanges[0].start, 2) // 禁用
  assert.equal(f.coveredRanges[1].end - f.coveredRanges[1].start, 2) // 短语
  // 覆盖两个叶子片段区间
  assert.equal(f.coveredRanges.length, 2)
  assert.ok(f.nodeIds.length === 1)
})

test('跨节点命中：CJK 短语跨越段落物理行（软边界）', () => {
  const src = '第一段结尾成\n分在下一行'
  const tree = parseCatalpa(src)
  const fs = scanTree(tree, snap([{ id: 'r', term: '成分', scopes: ['body'], rev: 1 }]))
  assert.equal(fs.length, 1)
  assert.equal(fs[0].matchedText.replace(/\n/g, ''), '成分')
})

test('跨节点命中：CJK 短语跨越两个块节点（硬边界）也能识别', () => {
  // 列表末字 + 引用首字
  const src = '- 项一成\n\n> 分列在引用'
  const tree = parseCatalpa(src)
  const fs = scanTree(tree, snap([{ id: 'r', term: '成分', scopes: ['body'], rev: 1 }]))
  // 命中“成…分”，跨 list 与 quote 两个 node
  const cross = fs.find((f) => f.nodeIds.length >= 2)
  assert.ok(cross, '应存在跨节点命中')
  assert.equal(cross.coveredText, '成分')
  // 覆盖片段区间分别落在两个节点
  assert.equal(cross.coveredRanges.length, 2)
})

test('ASCII 词不得跨片段粘连误报（foo+bar 不命中 foobar）', () => {
  const src = 'foo **bar**'
  const tree = parseCatalpa(src)
  const fs = scanTree(tree, snap([{ id: 'r', term: 'foobar', scopes: ['body'], rev: 1 }]))
  assert.equal(fs.length, 0)
})

test('整词：子串不命中，单词边界正确', () => {
  const tree = parseCatalpa('todo todolist atodo')
  const fs = scanTree(tree, snap([{ id: 'r', term: 'todo', scopes: ['body'], rev: 1 }]))
  assert.equal(fs.length, 1)
  assert.equal(fs[0].matchedText, 'todo')
})

test('区分大小写规则', () => {
  const tree = parseCatalpa('Todo TODO todo')
  const cs = scanTree(tree, snap([{ id: 'r', term: 'TODO', scopes: ['body'], rev: 1, caseSensitive: true }]))
  assert.equal(cs.length, 1)
  const ci = scanTree(tree, snap([{ id: 'r', term: 'TODO', scopes: ['body'], rev: 1 }]))
  assert.equal(ci.length, 3)
})

test('人工例外：规则+具体片段精确绑定，可静默命中', () => {
  const tree = parseCatalpa('成份和成份')
  const fs = scanTree(tree, snap(
    [{ id: 'r', term: '成分', scopes: ['body'], rev: 1 }],
    {
      wordForms: [{ from: '成份', to: '成分' }],
      exceptions: [{ ruleId: 'r', fragment: '成份', ruleRev: 1 }],
    },
  ))
  // 例外只静默“成份”，不静默“成分”；两个“成份”都是同一片段形态故都静默
  assert.equal(fs.length, 2)
  assert.ok(fs.every((f) => f.suppressed))
})

test('例外不影响其他规则：r1 的例外不能静默 r2 的命中（无全局忽略）', () => {
  const tree = parseCatalpa('最佳成分')
  const fs = scanTree(tree, snap(
    [
      { id: 'r1', term: '最佳', scopes: ['body'], rev: 1 },
      { id: 'r2', term: '成分', scopes: ['body'], rev: 1 },
    ],
    { exceptions: [{ ruleId: 'r1', fragment: '最佳', ruleRev: 1 }] },
  ))
  const r1 = fs.find((f) => f.ruleId === 'r1')
  const r2 = fs.find((f) => f.ruleId === 'r2')
  assert.equal(r1.suppressed, true)
  assert.equal(r2.suppressed, false)
})

test('例外绑定文档：其他文档不静默', () => {
  const tree = parseCatalpa('成分')
  const fs = scanTree(
    tree,
    snap([{ id: 'r', term: '成分', scopes: ['body'], rev: 1 }],
      { exceptions: [{ ruleId: 'r', fragment: '成分', ruleRev: 1, docId: 'docA' }] }),
    { docId: 'docB' },
  )
  assert.equal(fs[0].suppressed, false)
  assert.equal(fs[0].suppressedReason, 'exception-bound-to-other-doc')
})

test('规则撤回（enabled=false）不产生命中', () => {
  const tree = parseCatalpa('成分')
  const fs = scanTree(tree, snap([{ id: 'r', term: '成分', scopes: ['body'], rev: 2, enabled: false }]))
  assert.equal(fs.length, 0)
})

test('规则修订 rev 提升后，旧 rev 的例外不能掩盖新版本命中', () => {
  const tree = parseCatalpa('成分')
  const snapshot = snap(
    [{ id: 'r', term: '成分', suggestions: ['组分'], scopes: ['body'], rev: 2 }],
    { exceptions: [{ ruleId: 'r', fragment: '成分', ruleRev: 1 }] },
  )
  const fs = scanTree(tree, snapshot)
  assert.equal(fs.length, 1)
  assert.equal(fs[0].suppressed, false)
  assert.equal(fs[0].suppressedReason, 'rule-revision-changed')
})

test('同 rev 的例外在规则内容未变时继续有效', () => {
  const tree = parseCatalpa('成分')
  const fs = scanTree(tree, snap(
    [{ id: 'r', term: '成分', scopes: ['body'], rev: 2 }],
    { exceptions: [{ ruleId: 'r', fragment: '成分', ruleRev: 2 }] },
  ))
  assert.equal(fs[0].suppressed, true)
})

test('例外按折叠形态比对：夹零宽/全角的“同一片段”视为同一片段', () => {
  const zw = '​'
  assert.equal(normalizeKey(`成${zw}份`), normalizeKey('成份'))
  assert.equal(normalizeKey('ＴＯＤＯ'), normalizeKey('todo'))
})

test('重叠多规则命中各自报告', () => {
  const tree = parseCatalpa('最佳成分')
  const fs = scanTree(tree, snap([
    { id: 'a', term: '最佳', scopes: ['body'], rev: 1 },
    { id: 'b', term: '佳成', scopes: ['body'], rev: 1 },
    { id: 'c', term: '成分', scopes: ['body'], rev: 1 },
  ]))
  assert.equal(fs.length, 3)
  const ids = fs.map((f) => f.ruleId).sort()
  assert.deepEqual(ids, ['a', 'b', 'c'])
})

test('行内代码按 code scope，链接 url 不入校对流但 label 入流', () => {
  const src = '[成分 label](https://example.com/成分)'
  const tree = parseCatalpa(src)
  const body = scanTree(tree, snap([{ id: 'r', term: '成分', scopes: ['body'], rev: 1 }]))
  assert.equal(body.length, 1) // 只命中 label 中一次，url 内不命中
})

void key
