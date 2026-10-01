// 校对扫描内核（浏览器与服务器共用，保证“浏览器提示”与“发布检查”同一规则快照、同一结果）。
//
// 输入：toNodes() 得到的文稿节点树 + 已编译规则 + 词形映射 + 人工例外
// 输出：命中列表，start/end 全部是【原始文稿】的 UTF-16 码元偏移。
//
// 设计要点：
//  - 扫描在 Unicode 折叠后的文本上进行，但每个折叠字符带来源区间；
//    NFKC 长度变化、零宽字符删除、多字词形替换都不会造成错位。
//  - 节点边界在折叠流中是“零宽间隙”，因此跨节点/跨行/跨段短语可以命中；
//    每个折叠字符记录经过的节点与范围，命中后据此做栏目范围过滤与归属。
//  - 例外按“规则 + 具体片段 + 两侧上下文”绑定，而不是全局忽略；
//    规则撤回/新版本会产生新的片段签名，旧例外无法掩盖新命中。
//  - 每条命中带节点相对锚点 anchor：增量扫描时节点会插入/删除，绝对偏移会漂移，
//    合并后用锚点在新节点树上重新定位。

import { createFolder, foldString, isBarrierChar } from './fold.js'
import { fnv1a } from './hash.js'
import { toNodes, parseCatalpa } from './parser.js'

const CONTEXT_RADIUS = 12
const SIG_SEP = '::'

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function compileRules(rules, mappings) {
  return rules
    .filter((r) => r.enabled !== false)
    .map((rule) => {
      const patternText = foldString(rule.pattern || '', mappings).text
      let matcher
      if (rule.matchType === 'regex') {
        const flags = rule.regexFlags || 'g'
        matcher = new RegExp(patternText, flags.includes('g') ? flags : `${flags}g`)
      } else {
        matcher = new RegExp(escapeRegExp(patternText), 'g')
      }
      return {
        id: rule.id,
        version: rule.version,
        severity: rule.severity || 'warn',
        message: rule.message || `命中禁用词：${rule.pattern}`,
        suggestions: rule.suggestions || [],
        scopes: rule.scopes && rule.scopes.length ? rule.scopes : ['title', 'body', 'quote', 'code'],
        crossNode: rule.crossNode !== false,
        matcher,
        patternFold: patternText,
        patternFoldLen: [...patternText].length,
      }
    })
}

export function maxPatternLength(compiled) {
  let max = 0
  for (const c of compiled) max = Math.max(max, c.patternFoldLen)
  return max
}

export function exceptionSignature(foldText, matchStart, matchEnd, ruleId, docId) {
  const snippet = foldText.slice(matchStart, matchEnd)
  const contextBefore = foldText.slice(Math.max(0, matchStart - CONTEXT_RADIUS), matchStart)
  const contextAfter = foldText.slice(matchEnd, matchEnd + CONTEXT_RADIUS)
  return { snippet, contextBefore, contextAfter, key: exceptionKey(ruleId, docId, snippet, contextBefore, contextAfter) }
}

export function exceptionKey(ruleId, docId, snippet, contextBefore, contextAfter) {
  return `${ruleId}|${fnv1a([docId || '', snippet, contextBefore, contextAfter].join(SIG_SEP))}`
}

function offsetToLineCol(source, offset) {
  let line = 1
  let col = 1
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1
      col = 1
    } else {
      col += 1
    }
  }
  return { line, col }
}

// ---------- 节点相对锚点 ----------
// 折叠字符的来源区间是绝对偏移；这里换算为“节点内相对该节点首个 run 起点”的偏移。
// 跨节点命中锚定首尾两个节点；若节点随后被删除，锚点失效（增量合并会清除该命中）。
function makeAnchor(firstChar, lastChar, nodeById) {
  const firstMeta = firstChar.metas[0]
  const lastMetas = lastChar.metas
  const lastMeta = lastMetas[lastMetas.length - 1]
  const firstNode = nodeById(firstMeta.nodeId)
  const lastNode = nodeById(lastMeta.nodeId)
  if (!firstNode || !lastNode || !firstNode.runs.length || !lastNode.runs.length) return null
  const firstBase = firstNode.runs[0].start
  const lastBase = lastNode.runs[0].start
  return {
    startNode: firstMeta.nodeId,
    startOffset: firstChar.from[0] - firstBase,
    endNode: lastMeta.nodeId,
    endOffset: lastChar.from[1] - lastBase,
  }
}

// 用锚点在“当前节点树”上重新计算绝对区间；锚点失效（节点删除、节点文本变短）返回 null。
// resolver 可以是 Map，也可以是 id -> node 的函数。
export function remapAnchor(anchor, resolver) {
  if (!anchor) return null
  const nodeById = typeof resolver === 'function' ? resolver : (id) => resolver.get(id)
  const startNode = nodeById(anchor.startNode)
  const endNode = nodeById(anchor.endNode)
  if (!startNode || !endNode || !startNode.runs.length || !endNode.runs.length) return null
  const startBase = startNode.runs[0].start
  const endBase = endNode.runs[0].start
  const startLen = startNode.runs.map((r) => r.text).join('').length
  const endLen = endNode.runs.map((r) => r.text).join('').length
  if (anchor.startOffset < 0 || anchor.startOffset > startLen) return null
  if (anchor.endOffset < 0 || anchor.endOffset > endLen) return null
  return { start: startBase + anchor.startOffset, end: endBase + anchor.endOffset }
}

// ---------- 折叠流 ----------
function buildStream(nodes, assignId, mappings, nodeFilter) {
  const folder = createFolder(mappings)
  let prevEmittedIndex = -1
  nodes.forEach((node, index) => {
    const id = assignId(node)
    if (node.type === 'hr') {
      if (prevEmittedIndex !== -1) folder.gap(true)
      prevEmittedIndex = -1
      return
    }
    if (nodeFilter && !nodeFilter.has(id)) return
    if (prevEmittedIndex !== -1 && index !== prevEmittedIndex + 1) {
      folder.gap(true)
    }
    for (const run of node.runs) {
      folder.push(run.text, run.start, { nodeId: id, scope: run.scope })
    }
    prevEmittedIndex = index
  })
  return folder.finish()
}

// 核心扫描。
// options: { docId, exceptions, nodeFilter:Set<nodeId>, source }
export function scanDocument(nodes, compiledRules, mappings, options = {}) {
  const { docId = 'default', exceptions = [], nodeFilter = null, source = '' } = options
  let seq = 0
  const byId = new Map()
  const assignId = (node) => {
    if (!node._scanId) {
      node._scanId = node.id || `n${seq++}`
      byId.set(node._scanId, node)
    }
    return node._scanId
  }
  const nodeById = (id) => byId.get(id)

  const { text: foldText, chars } = buildStream(nodes, assignId, mappings, nodeFilter)

  const exSet = new Set()
  for (const ex of exceptions) {
    exSet.add(exceptionKey(ex.ruleId, ex.docId ?? docId, ex.snippet, ex.contextBefore, ex.contextAfter))
  }

  const hits = []
  const seen = new Set()

  for (const rule of compiledRules) {
    rule.matcher.lastIndex = 0
    let m
    while ((m = rule.matcher.exec(foldText)) !== null) {
      if (m[0].length === 0) {
        rule.matcher.lastIndex += 1
        continue
      }
      const fs = m.index
      const fe = m.index + m[0].length

      let crossesBarrier = false
      for (let k = fs; k < fe; k += 1) {
        if (chars[k] && chars[k].barrier) {
          crossesBarrier = true
          break
        }
      }
      if (crossesBarrier) continue

      const first = chars[fs]
      const last = chars[fe - 1]
      if (!first || !last) continue
      const start = first.from[0]
      const end = last.from[1]

      const scopes = new Set()
      const nodeIds = new Set()
      for (let k = fs; k < fe; k += 1) {
        for (const meta of chars[k].metas) {
          scopes.add(meta.scope)
          nodeIds.add(meta.nodeId)
        }
      }

      let inScope = scopes.size > 0
      for (const scope of scopes) {
        if (!rule.scopes.includes(scope)) inScope = false
      }
      if (!inScope) continue
      if (!rule.crossNode && nodeIds.size > 1) continue

      const sig = exceptionSignature(foldText, fs, fe, rule.id, docId)
      const suppressed = exSet.has(
        exceptionKey(rule.id, docId, sig.snippet, sig.contextBefore, sig.contextAfter),
      )

      const hitId = fnv1a(
        [rule.id, docId, sig.snippet, sig.contextBefore, sig.contextAfter].join(SIG_SEP),
      )
      if (seen.has(hitId)) continue
      seen.add(hitId)

      const { line, col } = offsetToLineCol(source, start)
      hits.push({
        hitId,
        ruleId: rule.id,
        ruleVersion: rule.version,
        severity: rule.severity,
        message: rule.message,
        suggestions: rule.suggestions,
        start,
        end,
        anchor: makeAnchor(first, last, nodeById),
        line,
        column: col,
        snippet: source.slice(start, end),
        foldSnippet: sig.snippet,
        contextBefore: sig.contextBefore,
        contextAfter: sig.contextAfter,
        scopes: [...scopes],
        nodeIds: [...nodeIds],
        suppressed,
        exception: suppressed
          ? { snippet: sig.snippet, contextBefore: sig.contextBefore, contextAfter: sig.contextAfter }
          : null,
      })
    }
  }

  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  return { hits, foldText }
}

// 从原始文稿直接扫描（发布检查/服务器使用）。
export function scanSource(source, rules, mappings, exceptions, options = {}) {
  const blocks = parseCatalpa(source)
  const nodes = toNodes(blocks)
  const compiled = compileRules(rules, mappings)
  return scanDocument(nodes, compiled, mappings, { ...options, source })
}
