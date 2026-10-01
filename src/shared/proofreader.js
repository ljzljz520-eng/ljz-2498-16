// 规则校对扫描引擎（浏览器 Worker 与 Node 服务端共用同一份实现，
// 保证“服务器发布检查”与“浏览器提示”使用同一规则快照版本。
//
// 设计要点：
//  1) snapshot = { version, rules:[{id,term,suggestions,scopes,wholeWord,
//     caseSensitive,rev,enabled}], wordForms:[{from,to}], exceptions }
//  2) 词形映射：把规则 term 的词形变体展开成等价模式（成份->成分 时，禁用词
//     “成分”也命中“成份”）。在折叠层展开，不改写原文，命中映射回原始片段。
//  3) 叶子片段折叠后首尾相接，块/项之间插入“分隔单元”（换行/空白）：
//     - 分隔单元不归属任何 scope，任何规则都不能把它算进命中；
//     - CJK 等非 ASCII 模式允许跨过分隔（换行/空白不断中文词）；
//     - 纯 ASCII 模式不得跨过任何片段边界或分隔单元，避免词粘连误报；
//     - 分隔空白同时作为英文整词边界（换行不会被误当成词字符）。
//  4) 人工例外绑定（ruleId + 折叠片段 + 规则 rev），不设全局忽略；规则撤回
//     或修订（rev 变化）后旧例外不能掩盖新版本命中。

import { foldText, isAsciiAlnum } from './unicode.js'

// 词形展开：以规则禁用词 term 为基准，沿 wordForms（from=异体，to=另一写法）
// 做等价别名闭包（双向），使同一写法的不同变体都能被标记。注意“建议词”由
// buildPatterns 在结果层排除（见 proofreader.scanTree），因此用户接受建议后
// 规范形不会立刻被再次标记。
function expandWordForms(term, wordForms, limit = 64) {
  const results = new Set([term])
  let changed = true
  let guard = 0
  while (changed && guard < 4) {
    guard += 1
    changed = false
    for (const cur of [...results]) {
      if (results.size >= limit) break
      for (const { from, to } of wordForms) {
        if (!from) continue
        if (to && cur.includes(to)) {
          const v = cur.split(to).join(from)
          if (!results.has(v)) { results.add(v); changed = true }
        }
        if (cur.includes(from)) {
          const v = cur.split(from).join(to || from)
          if (!results.has(v)) { results.add(v); changed = true }
        }
      }
    }
  }
  return [...results]
}

function buildAutomaton(patterns) {
  const gotoTable = [new Map()]
  const fail = [0]
  const output = [[]]

  const addPattern = (pattern, payload) => {
    let state = 0
    for (const ch of pattern) {
      let next = gotoTable[state].get(ch)
      if (next === undefined) {
        next = gotoTable.length
        gotoTable.push(new Map())
        fail.push(0)
        output.push([])
        gotoTable[state].set(ch, next)
      }
      state = next
    }
    output[state].push({ pattern, ...payload })
  }
  for (const p of patterns) addPattern(p.text, p.payload)

  const queue = []
  for (const [, s] of gotoTable[0]) queue.push(s)
  while (queue.length) {
    const r = queue.shift()
    for (const [ch, s] of gotoTable[r]) {
      queue.push(s)
      let state = fail[r]
      while (state !== 0 && !gotoTable[state].has(ch)) state = fail[state]
      const cand = gotoTable[state].get(ch) ?? 0
      fail[s] = cand === s ? 0 : cand
      output[s] = output[s].concat(output[fail[s]])
    }
  }

  return {
    step(state, ch) {
      let s = state
      while (s !== 0 && !gotoTable[s].has(ch)) s = fail[s]
      return gotoTable[s].get(ch) ?? 0
    },
    output,
  }
}

function checkScopes(scopes) {
  return scopes && scopes.length ? scopes : ['title', 'body', 'code']
}

// 线性化文稿树。
// unit 边界：同一块不同 unit（段落物理行）之间 soft；块首/list item/quote 行
// 为 hard。hard 边界插 '\n'，soft 边界插 ''（保留 boundary 记录）。
// 片段（语法标记切开的叶子）之间 soft，不插字符。
function buildStream(tree, caseInsensitive) {
  let folded = ''
  const streamUnits = []
  const boundaryKinds = new Map()

  const emitText = (node, seg) => {
    const fold = foldText(seg.text, { caseInsensitive, stripZeroWidth: true })
    const globalStart = folded.length
    const meta = {
      kind: 'text',
      nodeId: node.id,
      scope: seg.scope,
      segStart: seg.start,
      segEnd: seg.end,
      fold,
      globalStart,
    }
    for (let fi2 = 0; fi2 < fold.folded.length; fi2 += 1) streamUnits.push(meta)
    folded += fold.folded
  }
  const emitSeparator = (ch) => {
    if (ch) {
      for (let si = 0; si < ch.length; si += 1) streamUnits.push({ kind: 'sep' })
      folded += ch
    }
  }
  const markBoundary = (kind) => {
    if (folded.length === 0) return
    const prev = boundaryKinds.get(folded.length)
    if (kind === 'hard' || prev === undefined) boundaryKinds.set(folded.length, kind)
  }

  let prevNode = null
  for (const node of tree.nodes) {
    if (prevNode && folded.length > 0) {
      markBoundary('hard')
      emitSeparator('\n') // 块间换行：分隔且作为英文词边界
    }
    prevNode = node
    let firstUnit = true
    for (const blockUnit of node.units) {
      const hard = firstUnit || blockUnit.hardBefore
      markBoundary(hard ? 'hard' : 'soft')
      if (!firstUnit) emitSeparator(hard ? '\n' : '')
      firstUnit = false
      let segInUnit = true
      for (const seg of blockUnit.segments) {
        if (!segInUnit) markBoundary('soft')
        segInUnit = false
        emitText(node, seg)
      }
    }
  }

  const boundaries = [...boundaryKinds.keys()].sort((a, b) => a - b)
  return { folded, units: streamUnits, boundaries }
}

// 纯 ASCII 模式不得跨过任何边界（片段边界/软/硬/分隔）。
function crossesBoundaryAscii(start, end, stream) {
  return stream.boundaries.some((b) => b > start && b < end)
}

// 命中区间内是否包含分隔单元（scope=null）
function containsSeparator(start, end, stream) {
  for (let p = start; p < end; p += 1) {
    if (stream.units[p] && stream.units[p].kind === 'sep') return true
  }
  return false
}

function wholeWordOk(stream, start, end) {
  const before = start > 0 ? stream.folded[start - 1] : ''
  const after = end < stream.folded.length ? stream.folded[end] : ''
  return !isAsciiAlnum(before) && !isAsciiAlnum(after)
}

export function normalizeKey(text) {
  return foldText(String(text), { caseInsensitive: true, stripZeroWidth: true }).folded
}

// 片段内折叠子区间 [fs,fe) -> 原始码点区间
function origRangeWithin(fold, fs, fe) {
  const idx = fold.origIndex
  if (idx.length === 0) return { start: 0, end: 0 }
  const s = idx[Math.max(0, Math.min(fs, idx.length - 1))]
  const last = Math.max(0, Math.min(Math.max(fe - 1, fs), idx.length - 1))
  const tail = idx[last]
  const cp = fold.origText.codePointAt(tail)
  return { start: s, end: tail + (cp > 0xffff ? 2 : 1) }
}

// 前向对齐匹配：从 from 位置尝试匹配 pattern；非 ASCII 模式允许跨过块间分隔
// 单元（\n）以及软边界（片段之间，不插入字符），即“换行/标记不断中文词”。
// 返回 {start,end}（折叠流位置，end 为排他）或 null。
function alignMatch(stream, pattern, from) {
  let pi = 0
  let p = from
  let start = -1
  while (pi < pattern.length) {
    if (p >= stream.folded.length) return null
    const m = stream.units[p]
    if (m && m.kind === 'sep') {
      p += 1 // 跳过块间换行
      continue
    }
    if (stream.folded[p] !== pattern[pi]) return null
    if (start < 0) start = p
    pi += 1
    p += 1
  }
  return { start, end: p }
}

function scanOnStream(tree, stream, patterns, snapshot, docId, exceptionMap, findings, seen) {
  const asciiPatterns = patterns.filter((p) => /^[\x00-\x7f]+$/.test(p.text))
  const cjkPatterns = patterns.filter((p) => !/^[\x00-\x7f]+$/.test(p.text))

  // 第一趟：ASCII 模式走 AC（多模式线性）
  const automaton = buildAutomaton(asciiPatterns)
  let state = 0
  for (let pos = 0; pos < stream.folded.length; pos += 1) {
    state = automaton.step(state, stream.folded[pos])
    for (const hit of automaton.output[state] || []) {
      recordHit(tree, stream, hit, pos + 1, pos + 1 - hit.pattern.length,
        snapshot, docId, exceptionMap, findings, seen)
    }
  }

  // 第二趟：非 ASCII 模式逐起点对齐（可跳块间分隔）。规则数通常很少。
  if (cjkPatterns.length) {
    // 以首字符分组加速
    const byFirst = new Map()
    for (const p of cjkPatterns) {
      const ch = p.text[0]
      if (!byFirst.has(ch)) byFirst.set(ch, [])
      byFirst.get(ch).push(p)
    }
    for (let pos = 0; pos < stream.folded.length; pos += 1) {
      const m = stream.units[pos]
      if (m && m.kind === 'sep') continue
      const cands = byFirst.get(stream.folded[pos])
      if (!cands) continue
      for (const cand of cands) {
        const r = alignMatch(stream, cand.text, pos)
        if (r) {
          recordHit(tree, stream, { pattern: cand.text, ...cand.payload }, r.end, r.start,
            snapshot, docId, exceptionMap, findings, seen)
        }
      }
    }
  }
}

// 校验并记录一次命中。hit 为 AC output 形态（pattern + 展开的 payload 字段）。
// endPos 为排他折叠位置；startPos 为起始折叠位置。
function recordHit(tree, stream, hit, end, start, snapshot, docId, exceptionMap, findings, seen) {
  const pattern = hit.pattern
  const ascii = /^[\x00-\x7f]+$/.test(pattern)
  if (start < 0) return
  const startMeta = stream.units[start]
  const endMeta = stream.units[end - 1]
  if (!startMeta || startMeta.kind !== 'text' || !endMeta || endMeta.kind !== 'text') return

  // scope：每个文本折叠单元都必须在规则栏目内（分隔不参与 scope）
  const scopeSet = new Set(hit.scopes)
  for (let p = start; p < end; p += 1) {
    const m = stream.units[p]
    if (m.kind === 'sep') continue
    if (!scopeSet.has(m.scope)) return
  }
  if (ascii && (crossesBoundaryAscii(start, end, stream) || containsSeparator(start, end, stream))) {
    return
  }
  if (hit.asciiWholeWord && !wholeWordOk(stream, start, end)) return

// 折叠区间 -> 原始区间。命中可能横跨多个叶子片段（中间隔着 ** 等标记）
// 或块间分隔（换行）。逐叶子片段求“局部原始子区间”：
//  - 零宽字符（折叠删除）不会让端点落在看不见的位置；
//  - 语法标记 ** > 不进入任何片段区间；
//  - coveredRanges 供 renderer/替换在每个叶子片段内精确标注。
const covered = new Map() // meta -> {fs,fe} 片段内折叠覆盖区间
for (let p = start; p < end; p += 1) {
  const m = stream.units[p]
  if (m.kind !== 'text') continue
  const local = p - m.globalStart
  const cur = covered.get(m)
  if (cur) {
    cur.fs = Math.min(cur.fs, local)
    cur.fe = Math.max(cur.fe, local + 1)
  } else {
    covered.set(m, { fs: local, fe: local + 1 })
  }
}
if (covered.size === 0) return
const coveredList = [...covered.entries()]
const coveredRanges = coveredList.map(([m, r]) => {
  const rr = origRangeWithin(m.fold, r.fs, r.fe)
  return { start: m.segStart + rr.start, end: m.segStart + rr.end }
})
coveredRanges.sort((a, b) => a.start - b.start)
const origStart = coveredRanges[0].start
const origEnd = coveredRanges[coveredRanges.length - 1].end
if (origEnd <= origStart) return

// coveredText：命中覆盖到的叶子文本拼接（不含标记/换行），用于例外 key
// 与替换；matchedText：原文首尾切片（跨标记时含 ** 等字符，仅展示）。
const coveredText = coveredRanges
  .map((r) => tree.source.slice(r.start, r.end))
  .join('')
const matchedText = tree.source.slice(origStart, origEnd)
const dedupeKey = `${hit.ruleId}:${origStart}:${origEnd}`
if (seen.has(dedupeKey)) return
seen.add(dedupeKey)

const nodeIds = new Set()
for (const [m] of coveredList) nodeIds.add(m.nodeId)

const ex = exceptionMap.get(`${hit.ruleId} ${normalizeKey(coveredText)}`)
let suppressed = false
let suppressedReason = null
if (ex) {
  if (ex.docId && ex.docId !== '*' && ex.docId !== docId) {
    suppressedReason = 'exception-bound-to-other-doc'
  } else if (ex.ruleRev != null && hit.rev != null && ex.ruleRev !== hit.rev) {
    suppressedReason = 'rule-revision-changed'
  } else {
    suppressed = true
  }
}

findings.push({
  ruleId: hit.ruleId,
  rev: hit.rev,
  ruleVersion: snapshot.version || null,
  term: hit.term,
  variant: hit.variant,
  start: origStart,
  end: origEnd,
  matchedText,
  coveredText,
  coveredRanges,
  scopes: hit.scopes,
  nodeIds: [...nodeIds],
  suggestions: hit.suggestions,
  suppressed,
  suppressedReason,
  contentKey: normalizeKey(coveredText),
})
}

export function scanTree(tree, snapshot, opts = {}) {
  const docId = opts.docId || '_doc'

  const wfFor = (ci) => (snapshot.wordForms || []).map((w) => ({
    from: foldText(w.from, { caseInsensitive: ci }).folded,
    to: foldText(w.to || '', { caseInsensitive: ci }).folded,
  }))

  const buildPatterns = (ci) => {
    const patterns = []
    for (const rule of snapshot.rules || []) {
      if (rule.enabled === false) continue
      const termFold = foldText(rule.term, { caseInsensitive: ci, stripZeroWidth: true }).folded
      if (!termFold) continue
      const asciiOnly = /^[\x00-\x7f]+$/.test(termFold)
      // 建议词（用户接受替换后的目标写法）不作为本规则的命中模式，避免
      // “替换为建议 → 立刻又被标记”。
      const suggestionFolds = new Set(
        (rule.suggestions || []).map((s) =>
          foldText(s, { caseInsensitive: ci, stripZeroWidth: true }).folded),
      )
      for (const variant of new Set(expandWordForms(termFold, wfFor(ci)))) {
        if (suggestionFolds.has(variant)) continue
        patterns.push({
          text: variant,
          payload: {
            ruleId: rule.id,
            scopes: checkScopes(rule.scopes),
            asciiWholeWord: asciiOnly && rule.wholeWord !== false,
            rev: rule.rev || 1,
            suggestions: rule.suggestions || [],
            term: rule.term,
            variant,
          },
        })
      }
    }
    return patterns
  }

  const exceptionMap = new Map()
  const putEx = (ex) => {
    if (!ex || !ex.ruleId || ex.fragment == null) return
    exceptionMap.set(`${ex.ruleId} ${normalizeKey(ex.fragment)}`, ex)
  }
  for (const ex of snapshot.exceptions || []) putEx(ex)
  for (const ex of opts.exceptions || []) putEx(ex)

  const findings = []
  const seen = new Set()

  // 分流：大小写敏感规则在原样折叠流上匹配；其余在小写折叠流上匹配。
  const hasCI = (snapshot.rules || []).some((r) => r.enabled !== false && !r.caseSensitive)
  const hasCS = (snapshot.rules || []).some((r) => r.enabled !== false && r.caseSensitive)
  if (hasCI) {
    const stream = buildStream(tree, true)
    scanOnStream(tree, stream, buildPatterns(true), snapshot, docId, exceptionMap, findings, seen)
  }
  if (hasCS) {
    const stream = buildStream(tree, false)
    scanOnStream(tree, stream, buildPatterns(false), snapshot, docId, exceptionMap, findings, seen)
  }

  findings.sort((a, b) => a.start - b.start || a.end - b.end || (a.ruleId < b.ruleId ? -1 : 1))
  findings.forEach((f, idx) => { f.id = `f${idx}` })
  return findings
}

export { expandWordForms }
