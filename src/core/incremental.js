// 增量扫描规划：
//   全稿重扫 vs 按节点增量扫描的判定，以及规则/例外变更后必要的重算范围。
//
// 节点身份：用 (type, contentHash) 作为键，通过 LCS 对齐旧节点序列与新节点序列，
// 从而复用稳定 id。节点发生移动（相同内容换位置）不视为脏节点。
//
// 跨节点短语边界：某节点变脏时，把“折叠距离 <= 最长规则模式长度”的相邻节点
// 一并纳入重算窗口，否则跨越边界的短语会被漏掉。
//
// 位置稳定性：保留命中的绝对偏移在节点插入/删除后会漂移，因此命中带“节点相对锚点”，
// 合并时在新节点树上重新计算 start/end；锚点失效（节点删除或文本变短）则丢弃该命中。

import { fnv1a } from './hash.js'
import { remapAnchor } from './scanner.js'

// 最长公共子序列对齐，返回 prev 下标 -> next 下标的映射。
export function alignNodes(prevKeys, nextKeys) {
  const n = prevKeys.length
  const m = nextKeys.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (prevKeys[i] === nextKeys[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const alignment = new Map()
  const usedNext = new Set()
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (prevKeys[i] === nextKeys[j]) {
      alignment.set(i, j)
      usedNext.add(j)
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  return { alignment, usedNext }
}

// 计算增量计划。
// prev: [{ id, key, foldLen }]；nextKeys/nextFoldLens 来自当前解析。
export function planIncremental(prev, nextKeys, nextFoldLens, maxPatternFoldLen) {
  const prevKeys = prev.map((p) => p.key)
  const { alignment, usedNext } = alignNodes(prevKeys, nextKeys)

  const assignment = new Array(nextKeys.length)
  let freshSeq = prev.length
  for (const [pi, ni] of alignment) assignment[ni] = prev[pi].id
  for (let ni = 0; ni < nextKeys.length; ni += 1) {
    if (!usedNext.has(ni)) assignment[ni] = `n${freshSeq++}`
  }

  const alignedPrev = new Set(alignment.keys())
  const deletedPrev = new Set()
  for (let pi = 0; pi < prev.length; pi += 1) {
    if (!alignedPrev.has(pi)) deletedPrev.add(pi)
  }

  const dirty = new Set()
  for (let ni = 0; ni < nextKeys.length; ni += 1) {
    if (!usedNext.has(ni)) dirty.add(assignment[ni])
  }

  // 脏节点按折叠文本距离向两侧扩张一个最长模式窗口（节点边界零宽，不扣预算）。
  const affected = new Set()
  const expand = (center) => {
    let budget = maxPatternFoldLen
    for (let k = center; k >= 0; k -= 1) {
      affected.add(assignment[k])
      budget -= nextFoldLens[k] || 0
      if (budget < 0) break
    }
    budget = maxPatternFoldLen
    for (let k = center; k < nextKeys.length; k += 1) {
      affected.add(assignment[k])
      budget -= nextFoldLens[k] || 0
      if (budget < 0) break
    }
  }
  for (let ni = 0; ni < nextKeys.length; ni += 1) {
    if (dirty.has(assignment[ni])) expand(ni)
  }
  // 删除节点：以旧邻居（现存）为锚点扩张。
  for (const pi of deletedPrev) {
    for (const npi of [pi - 1, pi + 1]) {
      if (npi >= 0 && npi < prev.length && alignment.has(npi)) expand(alignment.get(npi))
    }
  }

  return {
    full: false,
    assignment,
    dirty,
    affected,
    deletedIds: new Set([...deletedPrev].map((pi) => prev[pi].id)),
  }
}

function lineCol(source, offset) {
  let line = 1
  let col = 1
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') { line += 1; col = 1 } else col += 1
  }
  return { line, col }
}

// 合并增量结果。nodeById: id -> 当前节点；source: 当前文稿。
//  - 命中任一覆盖节点在 affected/deleted 中 -> 废弃，由新结果取代；
//  - 其余命中用 anchor 在当前节点树重定位（漂移/失效则丢弃）；
//  - 同一 hitId 去重，新结果优先。
export function mergeIncremental(prevHits, newHits, affectedIds, deletedIds, nodeById, source) {
  const retained = []
  for (const h of prevHits) {
    let invalid = false
    for (const nid of h.nodeIds || []) {
      if (affectedIds.has(nid) || deletedIds.has(nid)) {
        invalid = true
        break
      }
    }
    if (invalid) continue
    const remapped = remapAnchor(h.anchor, nodeById)
    if (!remapped) continue
    const { line, col } = lineCol(source, remapped.start)
    retained.push({
      ...h,
      start: remapped.start,
      end: remapped.end,
      line,
      column: col,
      snippet: source.slice(remapped.start, remapped.end),
    })
  }
  const map = new Map()
  for (const h of retained) map.set(h.hitId, h)
  for (const h of newHits) map.set(h.hitId, h)
  return [...map.values()].sort((a, b) => a.start - b.start || b.end - a.end)
}

// 规则集 / 词形 / 例外集合变更时必须全量重扫。
export function mustFullScan(prevMeta, nextMeta) {
  if (!prevMeta) return true
  return (
    prevMeta.rulesVersion !== nextMeta.rulesVersion ||
    prevMeta.mappingsVersion !== nextMeta.mappingsVersion ||
    prevMeta.exceptionsHash !== nextMeta.exceptionsHash
  )
}

export function hashExceptions(exceptions) {
  return fnv1a(
    exceptions
      .map((e) => [e.ruleId, e.docId || '', e.snippet, e.contextBefore, e.contextAfter].join('::'))
      .sort()
      .join('||'),
  )
}
