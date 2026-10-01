// Catalpa 解析器：把文稿解析成带【原始源码偏移】的块/行/片段树。
// 扫描器在树上工作：每个片段（segment）记录 start/end（UTF-16 码元偏移，相对原始文稿），
// 且带有扫描适用范围（title/body/code/quote 等），从而：
//   1) 命中位置可直接映射回原始文本；
//   2) 不同栏目可采用不同规则；
//   3) 节点可被稳定标识，支持按节点增量扫描。

const SCOPE = {
  heading: 'title',
  paragraph: 'body',
  quote: 'quote',
  listItem: 'body', // 列表正文归入 body；列表标记不参与扫描
  code: 'code',
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

import { fnv1a } from './hash.js'

// ---------- 行内解析 ----------
// 用一组按优先级排序的正则，在当前游标之后寻找“最早出现”的行内标记。
// code 必须最先判定（反引号内不再解析其它标记）。
const INLINE_REGEXPS = [
  { name: 'code', re: /`([^`]+)`/g, mark: 'code' },
  { name: 'link', re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, mark: 'link' },
  { name: 'bold', re: /\*\*([^*]+)\*\*/g, mark: 'strong' },
  { name: 'italic', re: /\*([^*]+)\*/g, mark: 'em' },
]

// 把一段行内文本解析为 segments。
// lineBase: 该文本首字符在全文中的绝对偏移；segments 的 start/end 均为绝对偏移。
export function parseInline(text, lineBase, baseScope) {
  const segments = []
  let cursor = 0

  const pushText = (from, to, scope) => {
    if (to <= from) return
    segments.push({
      type: 'text',
      scope,
      text: text.slice(from, to),
      start: lineBase + from,
      end: lineBase + to,
    })
  }

  while (cursor < text.length) {
    let best = null
    for (const rule of INLINE_REGEXPS) {
      rule.re.lastIndex = cursor
      const m = rule.re.exec(text)
      if (m && (!best || m.index < best.index)) {
        best = { rule, m, index: m.index }
      }
    }

    if (!best) {
      pushText(cursor, text.length, baseScope)
      break
    }

    const { rule, m } = best
    pushText(cursor, m.index, baseScope)

    const markStart = lineBase + m.index
    const markEnd = markStart + m[0].length

    if (rule.name === 'code') {
      const inner = m[1]
      const innerStart = m.index + 1
      segments.push({
        type: 'mark',
        mark: 'code',
        scope: 'code',
        start: markStart,
        end: markEnd,
        children: [
          {
            type: 'text',
            scope: 'code',
            text: inner,
            start: lineBase + innerStart,
            end: lineBase + innerStart + inner.length,
          },
        ],
      })
    } else if (rule.name === 'link') {
      const inner = m[1]
      const url = m[2]
      const innerStart = m.index + 1
      segments.push({
        type: 'mark',
        mark: 'link',
        url,
        start: markStart,
        end: markEnd,
        children: parseInline(inner, lineBase + innerStart, baseScope),
      })
    } else {
      const inner = m[1]
      const pad = rule.name === 'bold' ? 2 : 1
      const innerStart = m.index + pad
      segments.push({
        type: 'mark',
        mark: rule.mark,
        start: markStart,
        end: markEnd,
        children: parseInline(inner, lineBase + innerStart, baseScope),
      })
    }

    cursor = m.index + m[0].length
  }

  return segments
}

function listTagFor(line) {
  if (/^\s*[-*+]\s+/.test(line)) return 'ul'
  if (/^\s*\d+\.\s+/.test(line)) return 'ol'
  return ''
}

// ---------- 块级解析 ----------
export function parseCatalpa(source) {
  const lines = []
  {
    let start = 0
    for (const part of source.split('\n')) {
      let text = part
      if (text.endsWith('\r')) text = text.slice(0, -1)
      lines.push({ text, start })
      start += part.length + 1 // 含被 split 吃掉的 \n
    }
  }

  const blocks = []
  let i = 0
  const inlineLine = (text, lineStart, scope) => ({
    segments: parseInline(text, lineStart, scope),
  })

  while (i < lines.length) {
    const { text, start } = lines[i]
    const trimmed = text.trim()
    const indent = text.length - text.trimStart().length

    if (trimmed === '') {
      i += 1
      continue
    }

    if (/^```/.test(trimmed)) {
      const language = trimmed.slice(3).trim()
      const blockStart = start + indent
      i += 1
      const codeLines = []
      let blockEnd = start + text.length
      while (i < lines.length && !/^```/.test(lines[i].text.trim())) {
        codeLines.push({ text: lines[i].text, start: lines[i].start })
        blockEnd = lines[i].start + lines[i].text.length
        i += 1
      }
      if (i < lines.length) {
        blockEnd = lines[i].start + lines[i].text.length
        i += 1
      }
      blocks.push({ type: 'code', language, start: blockStart, end: blockEnd, codeLines })
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const content = heading[2].trim()
      const localIdx = text.indexOf(content, indent + heading[1].length)
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        start,
        end: start + text.length,
        lines: [inlineLine(content, start + localIdx, SCOPE.heading)],
      })
      i += 1
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr', start, end: start + text.length })
      i += 1
      continue
    }

    if (/^>\s?/.test(trimmed)) {
      const block = { type: 'quote', start, end: start, lines: [] }
      while (i < lines.length && /^>\s?/.test(lines[i].text.trim())) {
        const lt = lines[i].text.trim()
        const stripped = lt.replace(/^>\s?/, '')
        const localIdx = lines[i].text.indexOf(stripped)
        block.lines.push(inlineLine(stripped, lines[i].start + localIdx, SCOPE.quote))
        block.end = lines[i].start + lines[i].text.length
        i += 1
      }
      blocks.push(block)
      continue
    }

    const listTag = listTagFor(trimmed)
    if (listTag) {
      const ordered = listTag === 'ol'
      const items = []
      const block = { type: 'list', ordered, start, end: start, items }
      while (i < lines.length && listTagFor(lines[i].text.trim()) === listTag) {
        const lt = lines[i].text.trim()
        const stripped = lt.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
        const localIdx = lines[i].text.indexOf(stripped)
        items.push({
          start: lines[i].start,
          end: lines[i].start + lines[i].text.length,
          line: inlineLine(stripped, lines[i].start + localIdx, SCOPE.listItem),
        })
        block.end = lines[i].start + lines[i].text.length
        i += 1
      }
      blocks.push(block)
      continue
    }

    const block = { type: 'paragraph', start, end: start, lines: [] }
    while (
      i < lines.length &&
      lines[i].text.trim() !== '' &&
      !/^```/.test(lines[i].text.trim()) &&
      !/^(#{1,6})\s+/.test(lines[i].text.trim()) &&
      !/^>\s?/.test(lines[i].text.trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].text.trim()) &&
      !listTagFor(lines[i].text.trim())
    ) {
      const lt = lines[i].text.trim()
      const localIdx = lines[i].text.indexOf(lt)
      block.lines.push(inlineLine(lt, lines[i].start + localIdx, SCOPE.paragraph))
      block.end = lines[i].start + lines[i].text.length
      i += 1
    }
    blocks.push(block)
  }

  return blocks
}

// ---------- 树 -> 可扫描节点 ----------
export function segRuns(segments) {
  const runs = []
  const walk = (segs) => {
    for (const seg of segs) {
      if (seg.type === 'text') {
        runs.push({ text: seg.text, start: seg.start, end: seg.end, scope: seg.scope })
      } else if (seg.children) {
        walk(seg.children)
      }
    }
  }
  walk(segments)
  return runs
}

export function toNodes(blocks) {
  const nodes = []

  for (const block of blocks) {
    if (block.type === 'heading') {
      nodes.push(makeNode('heading', segRuns(block.lines[0].segments)))
    } else if (block.type === 'paragraph') {
      for (const line of block.lines) {
        nodes.push(makeNode('paragraph', segRuns(line.segments)))
      }
    } else if (block.type === 'quote') {
      for (const line of block.lines) {
        nodes.push(makeNode('quote', segRuns(line.segments)))
      }
    } else if (block.type === 'list') {
      for (const item of block.items) {
        nodes.push(makeNode('listItem', segRuns(item.line.segments)))
      }
    } else if (block.type === 'code') {
      const runs = []
      const raw = block.codeLines.map((l) => l.text).join('\n')
      let cursor = block.codeLines.length ? block.codeLines[0].start : block.start
      block.codeLines.forEach((l, idx) => {
        const isLast = idx === block.codeLines.length - 1
        runs.push({
          text: l.text + (isLast ? '' : '\n'),
          start: cursor,
          end: cursor + l.text.length + (isLast ? 0 : 1),
          scope: 'code',
        })
        cursor += l.text.length + 1
      })
      const node = makeNode('code', runs)
      node.rawText = raw
      node.language = block.language
      nodes.push(node)
    } else if (block.type === 'hr') {
      nodes.push({ type: 'hr', runs: [], rawText: '', contentHash: fnv1a('hr'), key: 'hr' })
    }
  }

  return nodes
}

function makeNode(type, runs) {
  const rawText = runs.map((r) => r.text).join('')
  return {
    type,
    runs,
    rawText,
    contentHash: fnv1a(rawText),
    key: `${type}|${fnv1a(rawText)}`,
  }
}

// ---------- HTML 渲染 ----------
function renderTextWithHits(text, absStart, hits) {
  const marks = []
  for (const h of hits) {
    const s = Math.max(0, h.start - absStart)
    const e = Math.min(text.length, h.end - absStart)
    if (e > s) marks.push({ s, e, h })
  }
  if (marks.length === 0) return escapeHtml(text)
  marks.sort((a, b) => a.s - b.s || b.e - a.e)
  let out = ''
  let cursor = 0
  for (const m of marks) {
    if (m.s < cursor) continue // 不处理包含嵌套，跳过重叠区间
    out += escapeHtml(text.slice(cursor, m.s))
    const cls = m.h.suppressed
      ? 'proof-hit proof-hit--suppressed'
      : `proof-hit proof-hit--${m.h.severity || 'warn'}`
    const title = m.h.message ? ` data-message="${escapeHtml(m.h.message)}"` : ''
    out += `<span class="${cls}"${title}>${escapeHtml(text.slice(m.s, m.e))}</span>`
    cursor = m.e
  }
  out += escapeHtml(text.slice(cursor))
  return out
}

function renderSegments(segments, hits) {
  let out = ''
  for (const seg of segments) {
    if (seg.type === 'text') {
      out += renderTextWithHits(seg.text, seg.start, hits)
    } else if (seg.mark === 'code') {
      out += `<code>${seg.children
        .map((c) => renderTextWithHits(c.text, c.start, hits))
        .join('')}</code>`
    } else if (seg.mark === 'link') {
      const inner = seg.children.map((c) => renderSegments([c], hits)).join('')
      out += `<a href="${escapeHtml(seg.url)}" target="_blank" rel="noopener">${inner}</a>`
    } else if (seg.mark === 'strong' || seg.mark === 'em') {
      const inner = seg.children.map((c) => renderSegments([c], hits)).join('')
      out += `<${seg.mark}>${inner}</${seg.mark}>`
    }
  }
  return out
}

export function renderTree(blocks, hits = []) {
  const html = []
  for (const block of blocks) {
    if (block.type === 'heading') {
      const inner = renderSegments(block.lines[0].segments, hits)
      html.push(`<h${block.level}>${inner}</h${block.level}>`)
    } else if (block.type === 'paragraph') {
      const inner = block.lines.map((line) => renderSegments(line.segments, hits)).join(' ')
      html.push(`<p>${inner}</p>`)
    } else if (block.type === 'quote') {
      const inner = block.lines.map((line) => renderSegments(line.segments, hits)).join('<br />')
      html.push(`<blockquote>${inner}</blockquote>`)
    } else if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul'
      const items = block.items
        .map((item) => `<li>${renderSegments(item.line.segments, hits)}</li>`)
        .join('')
      html.push(`<${tag}>${items}</${tag}>`)
    } else if (block.type === 'code') {
      const langClass = block.language ? ` class="language-${block.language}"` : ''
      const raw = block.codeLines.map((l) => l.text).join('\n')
      const baseStart = block.codeLines.length ? block.codeLines[0].start : 0
      html.push(`<pre><code${langClass}>${renderTextWithHits(raw, baseStart, hits)}</code></pre>`)
    } else if (block.type === 'hr') {
      html.push('<hr />')
    }
  }
  return html.join('\n')
}

// 向后兼容旧接口。
export function renderCatalpa(source, hits = []) {
  return renderTree(parseCatalpa(source), hits)
}
