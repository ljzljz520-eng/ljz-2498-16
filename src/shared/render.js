// 由文稿树渲染预览 HTML。
//
// 与旧版 renderCatalpa(source)（字符串正则）等价，但基于带偏移的文稿树，
// 因而支持按“原文源码区间”精确注入校对高亮：
//   renderTree(tree, findings, options) -> html
//
// 高亮实现：收集与每个叶子片段相交的 [start,end) 区间，在片段文本内做切割
// 转义，交点包 <mark>。跨片段/跨标记（如 **粗**体 内的短语）会在每段文本中
// 分别开/闭标签，HTML 仍然合法且位置精确——不会因替换长度改变而错位，因为
// 标记完全由“原始源码偏移”驱动，与 NFKC/词形展开无关。

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 行内渲染：基于片段（已拆出 code/link/em/strong），再在普通片段内处理
// **bold** / *em* / `code` / link（片段本身已表达 code/link，故普通文本只需
// 转义；bold/em 标记在 tokenizer 阶段被消耗，文本直接输出）。
function renderSegment(seg, marks) {
  // marks: 排序后与 [seg.start,seg.end) 相交的高亮数组（相对片段的子区间）
  const text = seg.text
  const local = marks
    .map((m) => ({
      start: Math.max(0, m.start - seg.start),
      end: Math.min(text.length, m.end - seg.start),
      cls: m.cls,
      title: m.title,
      id: m.id,
    }))
    .filter((m) => m.end > 0 && m.start < text.length && m.end > m.start)
    .sort((a, b) => a.start - b.start || b.end - a.end)

  if (!local.length) return escapeHtml(text)

  // 合并重叠区间（同一位置可能被多条规则命中）
  const merged = []
  for (const m of local) {
    const last = merged[merged.length - 1]
    if (last && m.start < last.end) {
      last.end = Math.max(last.end, m.end)
      last.ids = [...new Set([...(last.ids || [last.id]), m.id])]
      last.cls = 'pf-mark pf-multi'
    } else {
      merged.push({ ...m, ids: [m.id] })
    }
  }

  let out = ''
  let cursor = 0
  for (const m of merged) {
    out += escapeHtml(text.slice(cursor, m.start))
    const ids = (m.ids || []).filter(Boolean).join(' ')
    out += `<mark class="${m.cls}" data-finding="${ids}" title="${escapeHtml(m.title || '')}">`
    out += escapeHtml(text.slice(m.start, m.end))
    out += '</mark>'
    cursor = m.end
  }
  out += escapeHtml(text.slice(cursor))
  return out
}

function renderUnitSegments(unit, markIndex) {
  return unit.segments
    .map((seg) => {
      const html = renderSegment(seg, markIndex.get(seg.start + ':' + seg.end) || [])
      if (seg.scope === 'code') return `<code>${html}</code>`
      return html
    })
    .join('')
}

// 为片段建立“相交命中”索引。命中带 coveredRanges（逐叶子片段的精确源码
// 子区间）；跨语法标记（如 ** 粗**）的短语只在真实文本片段内标注，标记本身
// 不高亮。
function buildMarkIndex(tree, findings) {
  const index = new Map()
  const key = (s, e) => `${s}:${e}`
  const addHit = (seg, hit, start, end) => {
    const k = key(seg.start, seg.end)
    if (!index.has(k)) index.set(k, [])
    index.get(k).push({
      start,
      end,
      id: hit.id,
      cls: hit.severity === 'warn' ? 'pf-mark pf-warn' : 'pf-mark pf-error',
      title: `${hit.term} -> ${(hit.suggestions || []).join('/') || '禁用词'}`,
    })
  }
  for (const node of tree.nodes) {
    for (const unit of node.units) {
      for (const seg of unit.segments) {
        for (const f of findings) {
          if (f.suppressed) continue
          // 优先用逐片段 coveredRanges；回退到整体 start/end（兼容旧数据）
          const ranges = f.coveredRanges && f.coveredRanges.length
            ? f.coveredRanges
            : [{ start: f.start, end: f.end }]
          for (const r of ranges) {
            if (r.end > seg.start && r.start < seg.end) {
              addHit(seg, f, Math.max(r.start, seg.start), Math.min(r.end, seg.end))
            }
          }
        }
      }
    }
  }
  return index
}

export function renderTree(tree, findings = [], options = {}) {
  const markIndex = findings && findings.length ? buildMarkIndex(tree, findings) : new Map()
  const html = []

  for (const node of tree.nodes) {
    if (node.type === 'code') {
      const inner = node.units
        .map((u) => renderUnitSegments(u, markIndex))
        .join('\n')
      const langClass = node.lang ? ` class="language-${escapeHtml(node.lang)}"` : ''
      html.push(`<pre><code${langClass}>${inner}</code></pre>`)
      continue
    }
    if (node.type === 'heading') {
      const inner = node.units.map((u) => renderUnitSegments(u, markIndex)).join('')
      html.push(`<h${node.level}>${inner}</h${node.level}>`)
      continue
    }
    if (node.type === 'hr') {
      html.push('<hr />')
      continue
    }
    if (node.type === 'quote') {
      const inner = node.units.map((u) => renderUnitSegments(u, markIndex)).join('<br />')
      html.push(`<blockquote>${inner}</blockquote>`)
      continue
    }
    if (node.type === 'list') {
      const items = node.units.map((u) => `<li>${renderUnitSegments(u, markIndex)}</li>`).join('')
      html.push(`<${node.tag}>${items}</${node.tag}>`)
      continue
    }
    if (node.type === 'paragraph') {
      // CommonMark soft break：旧渲染器用空格连接物理行
      const inner = node.units.map((u) => renderUnitSegments(u, markIndex)).join(' ')
      html.push(`<p>${inner}</p>`)
      continue
    }
  }
  void options
  return html.join('\n')
}

// 兼容旧 API
export function renderCatalpa(source) {
  // 延迟 import 避免循环（parse 不依赖 render）
  const { parseCatalpa } = requireParse()
  return renderTree(parseCatalpa(source), [])
}

let _parse
function requireParse() {
  if (!_parse) {
    // 同步场景下直接使用顶层可用的解析器（在文件底部静态绑定）
    _parse = _parseCatalpaHolder
  }
  return { parseCatalpa: _parse }
}

import { parseCatalpa as _parseCatalpaHolder } from './parse.js'
