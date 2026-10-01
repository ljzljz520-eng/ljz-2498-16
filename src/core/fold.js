// Unicode 折叠：把原始文本转换为用于规则匹配的“规范形”，
// 并为每一个折叠后的字符记录它在原始文本中覆盖的 [start,end)（UTF-16 码元偏移）。
// 关键点：规范化可能改变字符串长度（NFKC 扩展/收缩、零宽字符删除、多字词形映射），
// 因此命中位置必须通过这里的区间映射回原始文本，绝不能直接用下标。

// 折叠时直接删除、不占匹配位置的零宽 / 不可见字符。
export const ZERO_WIDTH_CHARS = [
  '​', // ZWSP
  '‌', // ZWNJ
  '‍', // ZWJ
  '﻿', // BOM / FEFF
  '⁠', // WJ
  '­', // soft hyphen
  ' ', // NO-BREAK SPACE -> NFKC 会处理，这里不删
]

const ZERO_WIDTH_SET = new Set(ZERO_WIDTH_CHARS.slice(0, 6))

// 屏障字符：占据一个折叠位置，但任何规则都不允许跨过它匹配。
// 用于：增量子流中两个不相邻节点窗口的拼接处、水平分割线两侧。
export const BARRIER_CHAR = '�'
export function isBarrierChar(ch) {
  return ch === BARRIER_CHAR
}

// 单个原始字符折叠时：跳过零宽字符，其余做 NFKC。
function foldOneChar(ch) {
  if (ZERO_WIDTH_SET.has(ch)) return null
  return ch.normalize('NFKC')
}

// 构建 trie，用于“最长匹配优先”的自定义词形映射。
function buildTrie(mappings) {
  const root = Object.create(null)
  for (const [from, to] of mappings) {
    if (!from) continue
    let node = root
    for (const ch of from) {
      node[ch] = node[ch] || Object.create(null)
      node = node[ch]
    }
    node.$ = to
  }
  return root
}

// 创建折叠流。逐段 push 原始文本（每段可带任意元数据，如所在节点 id / 适用范围），
// 结束时 finish 得到 fold 串与每个折叠字符的来源信息。
export function createFolder(mappings = []) {
  const trie = buildTrie(mappings)
  // pending：已接收但尚不能确定能否参与多字映射的原始字符。
  const pending = [] // { ch, start, end, meta }
  const out = [] // { ch, from:[start,end], metas:Set/array }

  function emit(text, items) {
    // items 是被这段折叠结果覆盖的原始字符序列。
    const start = items[0].start
    const end = items[items.length - 1].end
    const metas = new Set()
    for (const it of items) {
      if (it.meta) metas.add(it.meta)
    }
    // 先对整段输出做 NFKC，再做一次 NFC 组合（处理基字符+组合记号被映射边界切开的情况）。
    const nfkc = text.normalize('NFKC')
    for (const ch of nfkc) {
      out.push({ ch, from: [start, end], metas: [...metas] })
    }
    compose(out)
  }

  // 流式 NFC：若最后若干个折叠字符可以组合成更少的字符，则合并来源区间。
  function compose(arr) {
    for (;;) {
      let merged = false
      for (let len = Math.min(4, arr.length); len >= 2 && !merged; len -= 1) {
        const slice = arr.slice(arr.length - len)
        const combined = slice.map((c) => c.ch).join('').normalize('NFC')
        if (combined.length > 0 && combined.length < len && [...combined].length === 1) {
          arr.splice(arr.length - len, len, {
            ch: combined,
            from: [slice[0].from[0], slice[len - 1].from[1]],
            metas: [...new Set(slice.flatMap((c) => c.metas))],
          })
          merged = true
        }
      }
      if (!merged) break
    }
  }

  function flushDefault(it) {
    const folded = foldOneChar(it.ch)
    if (folded === null) return // 零宽字符：删除，映射中不留坑
    emit(folded, [it])
  }

  function push(text, startBase = 0, meta = null) {
    // 记录 UTF-16 码元偏移（与解析器、编辑器/预览的 index 保持同一坐标系）。
    for (const ch of text) {
      pending.push({ ch, start: startBase, end: startBase + ch.length, meta })
      startBase += ch.length
    }
    processPending(false)
  }

  function processPending(atEnd) {
    while (pending.length > 0) {
      // 在 pending 中寻找最早出现的 trie 键（最长优先）。
      let bestAt = -1
      let bestLen = 0
      let bestTo = null
      for (let i = 0; i < pending.length; i += 1) {
        let node = trie
        let len = 0
        let hit = null
        for (let j = i; j < pending.length; j += 1) {
          const next = node[pending[j].ch]
          if (!next) break
          len += 1
          if (Object.prototype.hasOwnProperty.call(next, '$')) {
            hit = { len, to: next.$ }
          }
          node = next
        }
        if (hit && (bestAt === -1 || hit.len > bestLen)) {
          bestAt = i
          bestLen = hit.len
          bestTo = hit.to
          break // 从最早起点取最长命中即可
        }
      }
      if (bestAt === -1) {
        if (atEnd) {
          for (const it of pending.splice(0)) flushDefault(it)
          return
        }
        // 未结束：保留“仍可能成为某个键前缀”的尾部，其余安全输出。
        let keepFrom = pending.length
        for (let i = 0; i < pending.length; i += 1) {
          let node = trie
          let possible = true
          for (let j = i; j < pending.length; j += 1) {
            const next = node[pending[j].ch]
            if (!next) {
              possible = false
              break
            }
            node = next
          }
          if (possible) {
            keepFrom = i
            break
          }
        }
        const safe = pending.splice(0, keepFrom)
        for (const it of safe) flushDefault(it)
        return
      }
      // bestAt 之前的字符不可能再参与映射（若可能，更晚的起点会被选中）。
      const before = pending.splice(0, bestAt)
      for (const it of before) flushDefault(it)
      const matched = pending.splice(0, bestLen)
      emit(bestTo, matched)
    }
  }

  // 插入边界。barrier=true 时放置屏障（不允许跨边界匹配）；否则为零宽间隙。
  function gap(barrier = false) {
    if (barrier) {
      // 先把可能参与映射的尾部全部落定，保证屏障真正切断连续性。
      processPending(true)
      out.push({ ch: BARRIER_CHAR, from: [pending.length, pending.length], metas: [], barrier: true })
    }
  }

  function finish() {
    processPending(true)
    return {
      text: out.map((c) => c.ch).join(''),
      chars: out,
    }
  }

  return { push, gap, finish }
}

// 便捷封装：折叠一整段文本。返回 { text, chars }，chars[i].from 为原始区间。
export function foldString(text, mappings = []) {
  const folder = createFolder(mappings)
  folder.push(text, 0)
  return folder.finish()
}
