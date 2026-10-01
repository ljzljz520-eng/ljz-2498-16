// Unicode 规范化与“原始文本偏移映射”。
//
// 需求要点：
//  - 规范化后命中位置必须映射回原始文本，不能因长度变化标错字；
//  - 零宽字符（U+200B/U+200C/U+200D/U+FEFF）按可跳过处理，不参与命中；
//  - 使用逐码点 NFKC（不做跨码点合并/分解），保证折叠后的每个字符都能
//    追溯到且仅追溯到原始文本中的一个码点，映射确定性强、可逆向定位。
//
// 所有索引均以 JS 字符串（UTF-16 代码单元）为单位，与 textarea / slice 一致。

export const ZERO_WIDTH_CHARS = [
  '​', // ZERO WIDTH SPACE
  '‌', // ZERO WIDTH NON-JOINER
  '‍', // ZERO WIDTH JOINER
  '﻿', // ZERO WIDTH NO-BREAK SPACE / BOM
]

const ZERO_WIDTH_SET = new Set(ZERO_WIDTH_CHARS)

// ASCII 字母数字，用于整词（wholeWord）边界判断
export function isAsciiAlnum(ch) {
  if (!ch) return false
  const c = ch.charCodeAt(0)
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
}

// 是否为 CJK 字符（跨节点边界策略：CJK 短语允许跨界，ASCII 词不允许）
export function isCjk(ch) {
  if (!ch) return false
  const c = ch.codePointAt(0)
  return (
    (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified Ideographs
    (c >= 0x3400 && c <= 0x4dbf) || // Extension A
    (c >= 0x20000 && c <= 0x2a6df) || // Extension B
    (c >= 0xf900 && c <= 0xfaff) // Compatibility Ideographs
  )
}

// 逐码点 NFKC：对每个原始码点独立 normalize，不把两个原始码点合并成一个。
// 单个原始码点折叠后可能展开为多个 UTF-16 单元（如 ﬀ -> ff），
// 这些单元整体映射回同一个原始码点，因此命中区间仍能精确还原。
export function foldCodePoint(cp, options = {}) {
  const { caseInsensitive = true, stripZeroWidth = true } = options
  const ch = String.fromCodePoint(cp)
  if (stripZeroWidth && ZERO_WIDTH_SET.has(ch)) {
    return ''
  }
  let out = ch.normalize('NFKC')
  if (caseInsensitive) {
    out = out.toLowerCase()
  }
  return out
}

/**
 * 折叠文本，并建立折叠流 <-> 原始文本的双向索引映射。
 *
 * 返回：
 *   folded: 折叠后的字符串
 *   origText: 原始文本（供结束码点长度计算）
 *   origIndex[i]: folded 第 i 个 UTF-16 单元对应的原始 UTF-16 起始索引；
 *                 同一原始码点展开出的多个单元共享同一索引。
 *   anchorOf(origPos): 原始 UTF-16 索引 -> 该原始字符（若保留）在 folded
 *                 中的起始位置；被删除/代理对尾部回退到最近有效锚点。
 */
export function foldText(text, options = {}) {
  const origIndex = []
  const anchor = new Int32Array(text.length).fill(-1)
  let folded = ''
  let outPos = 0

  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)
    const cpLen = cp > 0xffff ? 2 : 1
    const mapped = foldCodePoint(cp, options)
    if (mapped.length > 0) {
      anchor[i] = outPos
      for (let k = 0; k < mapped.length; k += 1) {
        origIndex.push(i)
      }
      folded += mapped
      outPos += mapped.length
    }
    for (let k = 1; k < cpLen; k += 1) {
      anchor[i + k] = anchor[i]
    }
    i += cpLen
  }

  // 回填被删除位置（零宽字符）：指向删除点之后第一个折叠锚点；末尾则指向结尾
  let next = folded.length
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (anchor[i] === -1) {
      anchor[i] = next
    } else {
      next = anchor[i]
    }
  }

  return {
    folded,
    origText: text,
    origIndex,
    anchorOf(origPos) {
      if (origPos >= text.length) return folded.length
      if (origPos < 0) return 0
      return anchor[origPos]
    },
  }
}

/**
 * 折叠命中区间 [fs, fe) -> 原始文本码点区间 {start,end}（UTF-16，半开区间）。
 * 起点：折叠起始单元对应的原始码点起点。
 * 终点：折叠末单元对应原始码点的下一位置（正确处理 ﬀ 展开与代理对）。
 */
export function origRangeForMatch(fold, fs, fe) {
  const { origIndex, origText } = fold
  if (origIndex.length === 0) return { start: 0, end: 0 }
  const start = origIndex[Math.max(0, Math.min(fs, origIndex.length - 1))]
  const lastUnit = Math.max(0, Math.min(fe - 1, origIndex.length - 1))
  const tail = origIndex[lastUnit]
  const cp = origText.codePointAt(tail)
  const end = tail + (cp > 0xffff ? 2 : 1)
  return { start, end }
}
