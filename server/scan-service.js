import { parseCatalpa, toNodes } from '../src/core/parser.js'
import { compileRules, maxPatternLength, scanDocument } from '../src/core/scanner.js'
import { foldString } from '../src/core/fold.js'
import { planIncremental, mergeIncremental, hashExceptions } from '../src/core/incremental.js'

// 计算节点折叠长度（增量窗口按折叠距离扩张）。
function withFoldLens(nodes, mappings) {
  for (const node of nodes) {
    if (node.type === 'hr') {
      node._foldLen = 0
      continue
    }
    const raw = node.runs.map((r) => r.text).join('')
    node._foldLen = [...foldString(raw, mappings).text].length
  }
}

// 节点摘要：客户端随请求带上，服务端据此对齐节点并决定增量范围。
function summarize(nodes) {
  return nodes.map((n) => ({
    id: n._scanId,
    key: n.key,
    type: n.type,
    foldLen: n._foldLen,
  }))
}

function rulesToMappingsArray(mappings) {
  return mappings.filter((m) => m.enabled !== false).map((m) => [m.from, m.to])
}

// 主入口。body: { source, docId, mode, prevSummary, prevHits, base:{rulesVersion,mappingsVersion,exceptionsHash} }
export function runScan(store, body) {
  const snapshot = store.getActiveSnapshot()
  const docId = body.docId || 'default'
  const source = body.source || ''
  const exceptions = store.listExceptions(docId)
  const exceptionsHash = hashExceptions(exceptions)
  const mappingPairs = rulesToMappingsArray(snapshot.mappings)

  const blocks = parseCatalpa(source)
  const nodes = toNodes(blocks)
  withFoldLens(nodes, mappingPairs)

  const compiled = compileRules(snapshot.rules, mappingPairs)
  const maxLen = maxPatternLength(compiled)

  const prevSummary = Array.isArray(body.prevSummary) ? body.prevSummary : []
  const prevHits = Array.isArray(body.prevHits) ? body.prevHits : []
  const base = body.base || {}

  // 规则 / 词形 / 例外集合变更：必须全量重算（规则撤回同样通过发布新版本走到这里）。
  const versionChanged =
    !body.mode ||
    body.mode === 'full' ||
    base.rulesVersion !== snapshot.version ||
    base.mappingsVersion !== snapshot.version ||
    base.exceptionsHash !== exceptionsHash

  let mode = 'full'
  let resultHits
  let affectedIds = null
  let deletedIds = null

  if (!versionChanged && prevSummary.length > 0) {
    const plan = planIncremental(
      prevSummary,
      nodes.map((n) => n.key),
      nodes.map((n) => n._foldLen),
      maxLen,
    )
    // 应用稳定 id
    nodes.forEach((n, i) => {
      n.id = plan.assignment[i]
    })
    const filter = plan.affected
    const { hits } = scanDocument(nodes, compiled, mappingPairs, {
      docId,
      exceptions,
      source,
      nodeFilter: filter,
    })
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    resultHits = mergeIncremental(
      prevHits, hits, plan.affected, plan.deletedIds, nodeById, source,
    )
    mode = 'incremental'
    affectedIds = [...plan.affected]
    deletedIds = [...plan.deletedIds]
  } else {
    nodes.forEach((n, i) => {
      n.id = `n${i}`
    })
    const { hits } = scanDocument(nodes, compiled, mappingPairs, { docId, exceptions, source })
    resultHits = hits
  }

  return {
    mode,
    rulesVersion: snapshot.version,
    mappingsVersion: snapshot.version,
    exceptionsHash,
    summary: summarize(nodes),
    hits: resultHits,
    affectedIds,
    deletedIds,
    publishedAt: snapshot.publishedAt,
  }
}

// 发布检查：始终全量，使用与浏览器完全相同的快照与内核。
export function runPublishCheck(store, body) {
  const snapshot = store.getActiveSnapshot()
  const docId = body.docId || 'default'
  const source = body.source || ''
  const exceptions = store.listExceptions(docId)
  const exceptionsHash = hashExceptions(exceptions)
  const mappingPairs = rulesToMappingsArray(snapshot.mappings)

  const blocks = parseCatalpa(source)
  const nodes = toNodes(blocks)
  nodes.forEach((n, i) => {
    n.id = `n${i}`
  })
  const compiled = compileRules(snapshot.rules, mappingPairs)
  const { hits } = scanDocument(nodes, compiled, mappingPairs, { docId, exceptions, source })

  // 例外只能压制提示，仍然要让发布者知道存在“人工放行”的条目。
  const active = hits.filter((h) => !h.suppressed)
  const errors = active.filter((h) => h.severity === 'error')
  const warnings = active.filter((h) => h.severity !== 'error')
  const suppressed = hits.filter((h) => h.suppressed)

  return {
    passed: errors.length === 0,
    rulesVersion: snapshot.version,
    exceptionsHash,
    publishedAt: snapshot.publishedAt,
    errorCount: errors.length,
    warningCount: warnings.length,
    suppressedCount: suppressed.length,
    errors,
    warnings,
    suppressed,
  }
}
