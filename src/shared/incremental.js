// 增量扫描器：对比“全稿重扫”与“按节点增量扫描”两种路径。
//
// 全量重扫 scanTree()：每次重算整棵树，简单可靠，但 O(文本)。
// 增量扫描 IncrementalScanner：
//   - 按“块节点”（标题/段落/列表/引用/代码块）缓存 findings；
//   - 文本变化时先定位受影响节点（编辑可能改变块的拆分/合并，因此用“脏区间”
//     覆盖：取旧树中与变化区间重叠的节点，加上它前后各一个节点作为跨界邻接）；
//   - 对“可能受规则模式长度影响的上下文窗口”重算：由于最长禁用词可能跨过
//     相邻节点（CJK 短语跨界），重算时把脏节点及邻接节点合并为临时子树，
//     再调用全量引擎，保证跨节点短语边界正确处理；
//   - 规则快照变更（snapshotVersion 变化）时丢弃所有缓存，整稿重算；
//   - 输出与全量重扫逐条一致（测试保证），差别只在性能。
//
// 重要：增量只是性能优化。其输出的 findings 仍带完整的 start/end（相对当前
// 原文），因为每次都基于“最新文稿树”重算受影响部分，不存在陈旧偏移问题。

import { parseCatalpa } from './parse.js'
import { scanTree, expandWordForms } from './proofreader.js'
import { foldText } from './unicode.js'

function nodeRange(n) {
  const start = Math.min(...n.units.map((u) => u.start))
  const end = Math.max(...n.units.map((u) => u.end))
  return { start, end }
}

// 计算每节点在全局折叠流中的区间（叶子片段折叠后首尾相接，故前缀和即全局
// 折叠偏移），以及 orig 偏移 -> 全局折叠偏移的映射。用于把编辑区间精确换算
// 到折叠空间，从而按“最长模式长度 K”界定必须重算的节点窗口：任何长度 ≤ K
// 的命中都不可能影响到距编辑区折叠距离 > K 的节点。
function foldLayout(tree, caseInsensitive) {
  const segs = []
  let cursor = 0
  const nodeRangeF = new Map()
  for (const n of tree.nodes) {
    const fs = cursor
    for (const u of n.units) {
      for (const s of u.segments) {
        const fold = foldText(s.text, { caseInsensitive, stripZeroWidth: true })
        segs.push({ start: s.start, end: s.end, fStart: cursor, fold })
        cursor += fold.folded.length
      }
    }
    nodeRangeF.set(n.id, { fStart: fs, fEnd: cursor })
  }
  segs.sort((a, b) => a.start - b.start)
  const origToFolded = (origPos) => {
    if (segs.length === 0) return 0
    let lo = 0
    let hi = segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (segs[mid].start <= origPos) lo = mid
      else hi = mid - 1
    }
    const s = segs[lo]
    if (origPos <= s.start) return s.fStart
    const local = Math.min(Math.max(origPos - s.start, 0), s.fold.origText.length)
    return s.fStart + s.fold.anchorOf(local)
  }
  return { total: cursor, nodeRangeF, origToFolded }
}

// 子树裁剪：保留给定 id 集合内的节点（保持原顺序）
function subtree(tree, ids) {
  const keep = new Set(ids)
  return { source: tree.source, nodes: tree.nodes.filter((n) => keep.has(n.id)) }
}

export class IncrementalScanner {
  constructor(snapshot, opts = {}) {
    this.opts = opts
    this.snapshotVersion = undefined
    this.setSnapshot(snapshot)
    this.source = null
    this.tree = null
    this.cachedByNode = new Map() // nodeId -> findings（偏移为当前原文偏移）
  }

  setSnapshot(snapshot) {
    this.snapshot = snapshot
    const v = snapshot?.version ?? null
    if (this.snapshotVersion !== undefined && v !== this.snapshotVersion) {
      // 规则变更：丢弃全部节点缓存，并使下一次 update 强制全量重算
      this.cachedByNode = new Map()
      this.forceFullOnNextUpdate = true
    }
    this.snapshotVersion = v
    // 最长模式折叠长度（含词形展开）：增量重算窗口半径
    let k = 0
    const ci = snapshot?.caseInsensitive !== false
    const wf = (snapshot?.wordForms || []).map((w) => ({
      from: foldText(w.from, { caseInsensitive: true }).folded,
      to: foldText(w.to || '', { caseInsensitive: true }).folded,
    }))
    for (const r of snapshot?.rules || []) {
      if (r.enabled === false) continue
      const t = foldText(r.term, {
        caseInsensitive: r.caseSensitive ? false : ci,
        stripZeroWidth: true,
      }).folded
      for (const vv of expandWordForms(t, wf)) k = Math.max(k, vv.length)
    }
    this.maxPatternLen = k
  }

  // 首次 / 强制全量
  fullScan(source, docId = this.opts.docId || '_doc') {
    this.source = source
    this.tree = parseCatalpa(source)
    const all = scanTree(this.tree, this.snapshot, { ...this.opts, docId })
    this.cachedByNode = this.#groupByNode(all)
    return this.#flatten()
  }

  /**
   * 增量重扫。
   * @param source 最新全文
   * @param change {start, end, newEnd?} 上一版 -> 这一版被替换的原文区间
   * @param docId
   * 不变式：结果与对最新全文直接 fullScan 逐条一致（测试保证）。
   */
  update(source, change = null, docId = this.opts.docId || '_doc') {
    if (this.forceFullOnNextUpdate || this.tree === null || this.source === null || !change ||
        typeof change.start !== 'number') {
      this.forceFullOnNextUpdate = false
      return this.fullScan(source, docId)
    }

    const oldTree = this.tree
    const newTree = parseCatalpa(source)
    const ci = this.snapshot?.caseInsensitive !== false
    const oldLayout = foldLayout(oldTree, ci)
    const newLayout = foldLayout(newTree, ci)
    const K = this.maxPatternLen

    // 编辑区间在两套布局中的折叠区间
    const oldF1 = oldLayout.origToFolded(change.start)
    const oldF2 = oldLayout.origToFolded(typeof change.end === 'number' ? change.end : change.start)
    const newEnd = typeof change.newEnd === 'number'
      ? change.newEnd
      : change.start + ((typeof change.end === 'number' ? change.end : change.start) - change.start) +
        (source.length - this.source.length)
    const newF1 = newLayout.origToFolded(change.start)
    const newF2 = newLayout.origToFolded(newEnd)

    // 节点对齐：以“内容签名相等”为匹配代价做 LCS 动态规划，得到有序的
    // 最大对齐集合，避免删除/重排节点后错配。未对齐节点一律重算。
    const A = oldTree.nodes
    const B = newTree.nodes
    const dp = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1))
    for (let a = A.length - 1; a >= 0; a -= 1) {
      for (let b = B.length - 1; b >= 0; b -= 1) {
        dp[a][b] = this.#sig(A[a]) === this.#sig(B[b])
          ? dp[a + 1][b + 1] + 1
          : Math.max(dp[a + 1][b], dp[a][b + 1])
      }
    }
    const aligned = new Map() // newNode -> oldNode
    {
      let a = 0
      let b = 0
      while (a < A.length && b < B.length) {
        if (this.#sig(A[a]) === this.#sig(B[b]) && dp[a][b] === dp[a + 1][b + 1] + 1) {
          aligned.set(B[b], A[a])
          a += 1
          b += 1
        } else if (dp[a + 1][b] >= dp[a][b + 1]) {
          a += 1
        } else {
          b += 1
        }
      }
    }

    const nonReusable = new Set()
    const reusable = new Map()
    for (const n of B) {
      const oldNode = aligned.get(n)
      const nf = newLayout.nodeRangeF.get(n.id)
      if (oldNode) {
        const ofr = oldLayout.nodeRangeF.get(oldNode.id)
        // 仅当新旧布局中都距编辑折叠区间 > K 才复用（跨节点短语长度 ≤ K）
        const farOld = ofr.fEnd + K <= Math.min(oldF1, oldF2) ||
          ofr.fStart - K >= Math.max(oldF1, oldF2)
        const farNew = nf.fEnd + K <= Math.min(newF1, newF2) ||
          nf.fStart - K >= Math.max(newF1, newF2)
        if (farOld && farNew) {
          const oldFindings = this.cachedByNode.get(oldNode.id) || []
          const shift = n.start - oldNode.start
          reusable.set(n.id, oldFindings.map((f) => ({
            ...f,
            start: f.start + shift,
            end: f.end + shift,
          })))
          continue
        }
      }
      nonReusable.add(n.id)
    }

    // 重算窗口 = 所有不可复用节点的折叠包围盒再向两侧扩 K（折叠距离），
    // 覆盖任何可能跨界的短语；其余节点直接复用缓存。
    const newCached = new Map()
    let boxS = Infinity
    let boxE = -Infinity
    for (const id of nonReusable) {
      const r = newLayout.nodeRangeF.get(id)
      boxS = Math.min(boxS, r.fStart)
      boxE = Math.max(boxE, r.fEnd)
    }
    const recomputeIds = new Set()
    if (nonReusable.size > 0) {
      const winS = boxS - K
      const winE = boxE + K
      for (const n of newTree.nodes) {
        const r = newLayout.nodeRangeF.get(n.id)
        if (r.fEnd >= winS && r.fStart <= winE) recomputeIds.add(n.id)
      }
    }

    // 复用窗口外节点
    for (const [id, findingsList] of reusable) {
      if (!recomputeIds.has(id)) newCached.set(id, findingsList)
    }

    if (recomputeIds.size > 0) {
      const ids = [...recomputeIds]
      const fresh = scanTree(subtree(newTree, ids), this.snapshot, { ...this.opts, docId })
      const grouped = this.#groupByNode(fresh)
      // 窗口内节点以本次扫描为唯一真相，跨节点 finding 两侧同时刷新
      for (const id of ids) newCached.set(id, grouped.get(id) || [])
    }

    this.source = source
    this.tree = newTree
    this.cachedByNode = newCached
    return this.#flatten()
  }

  #sig(node) {
    // 节点签名：类型 + 层级/语言/列表类型 + 全部叶子文本及其相对节点起点的偏移
    const parts = [node.type, node.level || '', node.tag || '', node.lang || '']
    for (const u of node.units) {
      for (const s of u.segments) {
        parts.push(`${s.scope}:${s.start - node.start}:${s.text}`)
      }
    }
    return parts.join('|')
  }

  #groupByNode(findings) {
    const map = new Map()
    for (const f of findings) {
      for (const nid of f.nodeIds) {
        if (!map.has(nid)) map.set(nid, [])
        map.get(nid).push(f)
      }
    }
    return map
  }

  #flatten() {
    const all = []
    const seen = new Set()
    for (const list of this.cachedByNode.values()) {
      for (const f of list) {
        // 按语义键去重：跨节点 finding 可能被相邻重算窗口各产出一份
        const key = `${f.ruleId}:${f.start}:${f.end}`
        if (!seen.has(key)) {
          seen.add(key)
          all.push(f)
        }
      }
    }
    all.sort((a, b) => a.start - b.start || a.end - b.end || (a.ruleId < b.ruleId ? -1 : 1))
    all.forEach((f, idx) => {
      f.id = `f${idx}`
    })
    return all
  }
}

