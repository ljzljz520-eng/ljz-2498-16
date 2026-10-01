// Catalpa 解析器：产出带源码区间（UTF-16 偏移，半开区间，相对整篇原文）的
// 文稿树（document tree），供：
//   1) 渲染（render.js，旧 renderCatalpa 行为保持兼容）；
//   2) 规则校对扫描（proofreader.js：把“叶子文本片段”线性化为扫描流）。
//
// scope（栏目）：
//   title  —— 标题文本（# 之后的内容）
//   body   —— 正文：段落、列表项、引用行
//   code   —— 代码：围栏代码块、行内 `code`
// 一个叶子片段（segment）恰属于一个 scope；标记字符（# > - ` ** 等）不属于
// 任何片段，因此禁用词永远不会“命中语法标记”。

export const SCOPES = ['title', 'body', 'code']

function getLineStarts(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1)
    if (source[i] === '\r' && source[i + 1] === '\n') i += 1
  }
  return starts
}

// 行内分词：把一行内的文本切成 {text,start,end,scope} 片段。
// 支持：`code`、[label](url)（仅 label 入流）、**bold**、*italic*。
// baseScope 为该行缺省 scope（body/title）。
function tokenizeInline(lineText, lineStart, baseScope) {
  const segments = []
  let i = 0
  let buf = ''
  let bufStart = 0

  const pushPlain = (end) => {
    if (end > bufStart) {
      segments.push({
        text: lineText.slice(bufStart, end),
        start: lineStart + bufStart,
        end: lineStart + end,
        scope: baseScope,
      })
    }
  }

  while (i < lineText.length) {
    const rest = lineText.slice(i)

    // 行内代码 `...`
    const code = /^`([^`]+)`/.exec(rest)
    if (code) {
      pushPlain(i)
      const innerStart = i + 1
      const innerEnd = i + 1 + code[1].length
      segments.push({
        text: code[1],
        start: lineStart + innerStart,
        end: lineStart + innerEnd,
        scope: 'code',
      })
      i += code[0].length
      bufStart = i
      continue
    }

    // 链接 [label](url) —— url 不进入校对流
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(rest)
    if (link) {
      pushPlain(i)
      const labelStart = i + 1
      const labelEnd = i + 1 + link[1].length
      // label 内仍允许 ** * 等，简化处理为普通文本片段
      segments.push({
        text: link[1],
        start: lineStart + labelStart,
        end: lineStart + labelEnd,
        scope: baseScope,
      })
      i += link[0].length
      bufStart = i
      continue
    }

    // 粗体 **...**（非贪婪，不跨行）
    const bold = /^\*\*([^*]+)\*\*/.exec(rest)
    if (bold) {
      pushPlain(i)
      const innerStart = i + 2
      const innerEnd = i + 2 + bold[1].length
      segments.push({
        text: bold[1],
        start: lineStart + innerStart,
        end: lineStart + innerEnd,
        scope: baseScope,
      })
      i += bold[0].length
      bufStart = i
      continue
    }

    // 斜体 *...*
    const em = /^\*([^*]+)\*/.exec(rest)
    if (em) {
      pushPlain(i)
      const innerStart = i + 1
      const innerEnd = i + 1 + em[1].length
      segments.push({
        text: em[1],
        start: lineStart + innerStart,
        end: lineStart + innerEnd,
        scope: baseScope,
      })
      i += em[0].length
      bufStart = i
      continue
    }

    i += 1
  }
  pushPlain(lineText.length)
  return segments.filter((s) => s.text.length > 0)
}

function listInfo(trimmed) {
  if (/^[-*+]\s+/.test(trimmed)) return { tag: 'ul', text: trimmed.replace(/^[-*+]\s+/, '') }
  if (/^\d+\.\s+/.test(trimmed)) return { tag: 'ol', text: trimmed.replace(/^\d+\.\s+/, '') }
  return null
}

const isHr = (t) => /^(?:-{3,}|\*{3,}|_{3,})$/.test(t)

/**
 * 解析 Catalpa 源文，得到文稿树。
 * 节点（block）形如：
 *   { id, type, start, end, units: [ { start,end, hardBefore, segments:[…] } ], … }
 * unit = 一个“可跨叶子匹配”的最小块内单元（段落中的每一物理行、每个列表项、
 *        每条引用行；代码块整块为一个单元；标题为一个单元）。
 * hardBefore: 该单元与前一单元之间是否为“硬边界”（块边界/列表项之间）。
 */
export function parseCatalpa(source) {
  const lineStarts = getLineStarts(source)
  const splitLine = (idx) => {
    const start = lineStarts[idx]
    const end = idx + 1 < lineStarts.length ? lineStarts[idx + 1] - 1 : source.length
    let realEnd = end
    if (source[realEnd - 1] === '\r') realEnd -= 1
    return {
      raw: source.slice(start, realEnd),
      start,
      end: realEnd,
    }
  }
  const lines = lineStarts.map((_, idx) => splitLine(idx))
  // 去掉最后一个由结尾 \n 产生的空行
  if (lines.length > 0 && lines[lines.length - 1].raw === '' && source.endsWith('\n')) {
    lines.pop()
  }

  const nodes = []
  let n = 0
  let i = 0

  const mkNode = (partial) => ({ id: `n${n++}`, ...partial })

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.raw.trim()

    if (trimmed === '') {
      i += 1
      continue
    }

    // 围栏代码块：整块是一个 code unit（含内部换行，跨行匹配在代码内允许）
    if (/^```/.test(trimmed)) {
      const lang = trimmed.slice(3).trim()
      const start = line.start
      let j = i + 1
      while (j < lines.length && !/^```/.test(lines[j].raw.trim())) j += 1
      const contentStart = line.end // 不含换行
      const firstContent = j > i + 1 ? lines[i + 1].start : contentStart
      const lastContent = j > i + 1 ? lines[j - 1].end : firstContent
      const end = j < lines.length ? lines[j].end : lastContent
      const innerStart = firstContent
      const innerEnd = lastContent
      const node = mkNode({
        type: 'code',
        lang,
        start,
        end,
        units: [],
      })
      if (innerEnd > innerStart) {
        node.units.push({
          start: innerStart,
          end: innerEnd,
          hardBefore: true,
          segments: [{ text: source.slice(innerStart, innerEnd), start: innerStart, end: innerEnd, scope: 'code' }],
        })
      }
      nodes.push(node)
      i = j < lines.length ? j + 1 : j
      continue
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (h) {
      const level = h[1].length
      const text = h[2].trim()
      const textStart = line.start + line.raw.indexOf(text)
      const textEnd = textStart + text.length
      nodes.push(
        mkNode({
          type: 'heading',
          level,
          start: line.start,
          end: line.end,
          units: [
            {
              start: textStart,
              end: textEnd,
              hardBefore: true,
              segments: tokenizeInline(text, textStart, 'title'),
            },
          ],
        }),
      )
      i += 1
      continue
    }

    // 引用：连续 > 行，每行一个 body unit（行间为硬边界）
    if (/^>\s?/.test(trimmed)) {
      const start = line.start
      const units = []
      while (i < lines.length && /^>\s?/.test(lines[i].raw.trim())) {
        const cur = lines[i]
        const stripped = cur.raw.trim().replace(/^>\s?/, '')
        // 计算 stripped 在原文中的起点
        const gtIdx = cur.raw.indexOf('>')
        const afterGt = gtIdx + 1
        let contentCol = afterGt
        if (cur.raw[contentCol] === ' ') contentCol += 1
        const contentStart = cur.start + contentCol
        const contentText = cur.raw.slice(contentCol)
        const trimEndShift = contentText.length - contentText.replace(/\s+$/, '').length
        const contentEnd = cur.end - trimEndShift
        if (contentEnd > contentStart || stripped.length > 0) {
          units.push({
            start: contentStart,
            end: contentEnd,
            hardBefore: true,
            segments: tokenizeInline(cur.raw.slice(contentCol, contentEnd), contentStart, 'body'),
          })
        }
        i += 1
      }
      const end = lines[i - 1].end
      nodes.push(mkNode({ type: 'quote', start, end, units }))
      continue
    }

    // 分割线
    if (isHr(trimmed)) {
      nodes.push(mkNode({ type: 'hr', start: line.start, end: line.end, units: [] }))
      i += 1
      continue
    }

    // 列表：每项一个 unit（项间硬边界）
    const li = listInfo(trimmed)
    if (li) {
      const tag = li.tag
      const start = line.start
      const items = []
      while (i < lines.length) {
        const info = listInfo(lines[i].raw.trim())
        if (!info || info.tag !== tag) break
        const cur = lines[i]
        const rawTrimmed = cur.raw.trim()
        const markerEnd = /^\s*/.test(cur.raw) ? cur.raw.indexOf(rawTrimmed) : 0
        const prefixLen = info.tag === 'ul' ? rawTrimmed.search(/[-*+]/) + (markerEnd - markerEnd) : 0
        void prefixLen
        // 内容起点：缩进 + marker + 空白
        const indent = cur.raw.match(/^\s*/)[0].length
        const markerText = info.tag === 'ul' ? rawTrimmed.match(/^[-*+]/)[0] : rawTrimmed.match(/^\d+\./)[0]
        let col = indent + markerText.length
        while (col < cur.raw.length && /[ \t]/.test(cur.raw[col])) col += 1
        const contentStart = cur.start + col
        const contentEnd = cur.end - (cur.raw.length - cur.raw.trimEnd().length)
        items.push({
          tag: info.tag,
          start: cur.start,
          end: cur.end,
          unit: {
            start: contentStart,
            end: contentEnd,
            hardBefore: true,
            segments: tokenizeInline(cur.raw.slice(col, contentEnd), contentStart, 'body'),
          },
        })
        i += 1
      }
      const end = items[items.length - 1].end
      nodes.push(
        mkNode({
          type: 'list',
          tag,
          start,
          end,
          units: items.map((it) => it.unit),
        }),
      )
      continue
    }

    // 段落：连续普通物理行。每行一个 unit，行间为软边界（CommonMark soft break），
    // 行内各自保留原文偏移；段落内空行/其他块结束段落。
    {
      const start = line.start
      const units = []
      while (i < lines.length) {
        const t = lines[i].raw.trim()
        if (
          t === '' ||
          /^```/.test(t) ||
          /^#{1,6}\s+/.test(t) ||
          /^>\s?/.test(t) ||
          isHr(t) ||
          listInfo(t)
        ) {
          break
        }
        const cur = lines[i]
        const indent = cur.raw.match(/^\s*/)[0].length
        const contentStart = cur.start + indent
        const trailing = cur.raw.length - cur.raw.trimEnd().length
        const contentEnd = cur.end - trailing
        units.push({
          start: contentStart,
          end: contentEnd,
          hardBefore: units.length === 0, // 段落首行相对前一块是硬边界
          segments: tokenizeInline(cur.raw.slice(indent, contentEnd), contentStart, 'body'),
        })
        i += 1
      }
      const end = units[units.length - 1].end
      nodes.push(mkNode({ type: 'paragraph', start, end, units }))
    }
  }

  return { source, nodes }
}

// 扁平化所有叶子片段
export function allSegments(tree) {
  const out = []
  for (const node of tree.nodes) {
    for (const unit of node.units) {
      for (const seg of unit.segments) out.push(seg)
    }
  }
  return out
}
