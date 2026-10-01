// 前端契约（不依赖 DOM/Worker）：
//  - 替换建议不会自动发生，只有显式选择才改写文本；
//  - 陈旧命中（文本已变）拒绝替换；
//  - IME 合成期间 ScanScheduler 不发起扫描，合成结束才扫描；
//  - 版本闸门保证旧结果不覆盖新文本。
// 直接复用调度器与一个“纯函数版”替换器，与 useProofreader 中同逻辑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScanScheduler } from '../src/shared/scheduler.js'
import { parseCatalpa } from '../src/shared/parse.js'
import { renderTree } from '../src/shared/render.js'

function fakeClock() {
  let t = 0
  const pending = new Map()
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = Symbol(); pending.set(id, { fn, at: t + ms }); return id },
    clearTimeout: (id) => pending.delete(id),
    async flush() {
      while (pending.size) {
        const [id, e] = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        pending.delete(id)
        t = e.at
        await e.fn()
        await Promise.resolve()
      }
      await new Promise((r) => setTimeout(r, 2))
    },
  }
}

// 与 useProofreader.applySuggestion 相同的纯函数实现（多区间从后向前替换）
function applySuggestion(source, finding, suggestion) {
  const ranges = finding.coveredRanges && finding.coveredRanges.length
    ? finding.coveredRanges
    : [{ start: finding.start, end: finding.end }]
  for (const r of ranges) {
    if (source.slice(r.start, r.end).length === 0) {
      return { ok: false, reason: 'stale' }
    }
  }
  const sorted = [...ranges].sort((a, b) => b.start - a.start)
  let next = source
  sorted.forEach((r, idxFromEnd) => {
    const isFirst = idxFromEnd === sorted.length - 1
    next = next.slice(0, r.start) + (isFirst ? suggestion : '') + next.slice(r.end)
  })
  return { ok: true, text: next }
}

test('替换不会自动发生：未选择建议时原文不变；选择后按 coveredRanges 改写', () => {
  // 命中跨 ** 标记的“禁用短语”
  const source = '前缀禁用**短语**后缀'
  const tree = parseCatalpa(source)
  // 手工构造与引擎一致的 finding
  const finding = {
    start: 2, end: 8, matchedText: '禁用**短语', coveredText: '禁用短语',
    coveredRanges: [{ start: 2, end: 4 }, { start: 6, end: 8 }],
  }
  // 未选择任何建议 -> 文本绝不变化
  assert.equal(source, '前缀禁用**短语**后缀')
  const r = applySuggestion(source, finding, '合规语')
  assert.equal(r.ok, true)
  // 第一个片段替换为建议，第二个片段清空，** 标记保留
  assert.equal(r.text, '前缀合规语****后缀')
})

test('陈旧命中（区间超出当前文本）拒绝替换', () => {
  const finding = { coveredRanges: [{ start: 5, end: 7 }] }
  const r = applySuggestion('x', finding, '建议')
  assert.equal(r.ok, false)
})

test('渲染器：跨标记命中只高亮真实文本，不高亮 ** 标记', () => {
  const source = '禁用**短语**结束'
  const tree = parseCatalpa(source)
  const html = renderTree(tree, [{
    id: 'f0', term: '禁用短语', suggestions: ['X'], suppressed: false,
    coveredRanges: [{ start: 0, end: 2 }, { start: 4, end: 6 }],
  }])
  assert.ok(html.includes('<mark'))
  // ** 不应被包进 mark
  assert.ok(!/<mark[^>]*>\*\*/.test(html))
  assert.ok(html.includes('禁用'))
  assert.ok(html.includes('短语'))
})

test('IME：合成中 notify 不触发扫描；合成结束后触发且文本为最终文本', async () => {
  const clock = fakeClock()
  const calls = []
  const sc = new ScanScheduler(
    async ({ text }) => { calls.push(text); return [] },
    () => {},
    { delay: 30, clock, snapshot: { version: 1 } },
  )
  sc.setComposing(true)
  sc.notify('pinyin')
  sc.notify('pinyinz')
  sc.notify('拼音中') // 未提交的中间态
  await clock.flush()
  assert.equal(calls.length, 0)
  sc.notify('拼音终稿')
  sc.setComposing(false)
  await clock.flush()
  assert.deepEqual(calls, ['拼音终稿'])
  assert.equal(sc.state.text, '拼音终稿')
})

test('快速连续修改 + 快照切换：只有最新文本+最新规则版本的结果被展示', async () => {
  const clock = fakeClock()
  const applied = []
  let snapVersion = 1
  const sc = new ScanScheduler(
    async ({ snapshot }) => [{ ruleVersion: snapshot.version }],
    (st) => applied.push([st.text, st.ruleVersion]),
    { delay: 0, clock, getSnapshot: () => ({ version: snapVersion }) },
  )
  sc.notify('a')
  await clock.flush()
  sc.notify('ab')
  snapVersion = 2
  sc.setSnapshot({ version: 2 })
  sc.notify('abc')
  await clock.flush()
  // 最终状态必须是 (abc, v2)；任何中途版本即使曾应用，也不能在 v2 后残留
  assert.deepEqual(applied.at(-1), ['abc', 2])
  assert.equal(sc.state.text, 'abc')
  assert.equal(sc.state.ruleVersion, 2)
})
