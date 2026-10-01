// 服务端扫描编排：规则快照解析 -> 文稿树解析 -> 全量/增量扫描 -> 过滤被人工
// 例外静默的命中（可返回明细）。浏览器 Worker 内执行同一份 scanTree，因此
// “浏览器提示”与“服务器发布检查”判定完全一致——只是浏览器用的快照通过
// GET /api/snapshots/current 拉取，发布检查由服务器使用其当前已发布快照。

import { parseCatalpa } from '../src/shared/parse.js'
import { scanTree } from '../src/shared/proofreader.js'

import {
  getCurrentSnapshot,
  getSnapshot,
  saveDocumentVersion,
  markPublished,
  getDocumentVersion,
} from './db.js'
import { fnv1a } from '../src/shared/scheduler.js'

async function resolveSnapshot(requestedVersion) {
  if (requestedVersion != null && requestedVersion !== '') {
    const snap = await getSnapshot(Number(requestedVersion))
    if (!snap) return { error: { status: 404, message: `snapshot ${requestedVersion} not found` } }
    return { snapshot: snap }
  }
  const snap = await getCurrentSnapshot()
  if (!snap) return { error: { status: 409, message: 'no published rule snapshot; publish rules first' } }
  return { snapshot: snap }
}

// 浏览器 Worker 用的快照（当前已发布版）；与发布检查同源
export async function resolveSnapshotForBrowser(requestedVersion) {
  return resolveSnapshot(requestedVersion)
}

/**
 * 扫描请求：
 * { docId, content|tree, mode: 'full'|'incremental', version(规则快照),
 *   change:{start,end,newEnd}, docVersion, includeSuppressed }
 *
 * 增量模式：在服务器为无状态单次调用（不跨请求缓存），因此仍返回当前内容的
 * 完整 findings，但会执行增量算法的“受影响节点”计算并报告 recomputedNodeCount
 * 与 full 模式的耗时/命中数对比，便于前端/测试比较两种路径。
 */
export async function handleScan(body) {
  const { snapshot, error } = await resolveSnapshot(body.version ?? body.snapshotVersion)
  if (error) return { error }

  const content = typeof body.tree === 'string' ? body.tree : (body.content ?? '')
  const tree = parseCatalpa(content)
  const docId = body.docId || '_doc'

  const extraExceptions = body.scope === 'publish' ? [] : []
  void extraExceptions

  let findings
  let modeReport = null

  if (body.mode === 'incremental') {
    // 无状态增量：构建扫描器，先全量建立基线，再按 change 应用一次增量，
    // 并与全量重扫做正确性对照（两者必须完全一致）。
    const { IncrementalScanner } = await import('../src/shared/incremental.js')
    const scanner = new IncrementalScanner(snapshot, { docId })
    // 基线内容：若未提供 baseline，直接对当前内容全量（此时增量等同全量）
    if (typeof body.baseline === 'string' && body.change) {
      scanner.fullScan(body.baseline, docId)
      const t0 = nowMicro()
      findings = scanner.update(content, normalizeChange(body.change), docId)
      const incMicros = nowMicro() - t0

      const t1 = nowMicro()
      const fullFindings = scanTree(parseCatalpa(content), snapshot, { docId })
      const fullMicros = nowMicro() - t1
      modeReport = {
        baseline: 'incremental',
        equal: findingsEqual(findings, fullFindings),
        incrementalMicros: incMicros,
        fullMicros,
        incrementalFindingCount: findings.length,
        fullFindingCount: fullFindings.length,
      }
      findings = fullFindings // 返回权威全量结果（二者一致时无差别）
    } else {
      const t0 = nowMicro()
      findings = scanTree(tree, snapshot, { docId })
      const fullMicros = nowMicro() - t0
      modeReport = {
        baseline: 'full',
        equal: true,
        incrementalMicros: null,
        fullMicros,
        incrementalFindingCount: findings.length,
        fullFindingCount: findings.length,
      }
    }
  } else {
    const t0 = nowMicro()
    findings = scanTree(tree, snapshot, { docId })
    modeReport = { baseline: 'full', fullMicros: nowMicro() - t0 }
  }

  if (!body.includeSuppressed) {
    findings = findings.filter((f) => !f.suppressed)
  }

  // 保存文稿版本（前端编辑时周期性保存），带内容哈希与创建时规则版本
  let savedVersion = null
  if (body.persist && body.docId) {
    savedVersion = await saveDocumentVersion(
      body.docId, content, fnv1a(content), snapshot.version,
    )
  }

  return {
    docId,
    docVersion: body.docVersion ?? null,
    contentHash: fnv1a(content),
    ruleVersion: snapshot.version,
    mode: body.mode || 'full',
    modeReport,
    findings: findings.map(serializeFinding),
    savedDocVersion: savedVersion?.version ?? null,
  }
}

function nowMicro() {
  // 性能计时；sql.js 环境下 performance 可用（Node 16+ 全局）
  return (globalThis.performance?.now ? globalThis.performance.now() * 1000 : Date.now() * 1000)
}

function findingsEqual(a, b) {
  if (a.length !== b.length) return false
  const key = (f) => `${f.ruleId}:${f.start}:${f.end}:${f.matchedText}`
  const ka = a.map(key).sort()
  const kb = b.map(key).sort()
  return ka.every((x, i) => x === kb[i])
}

function serializeFinding(f) {
  return {
    id: f.id,
    ruleId: f.ruleId,
    rev: f.rev,
    ruleVersion: f.ruleVersion,
    term: f.term,
    variant: f.variant,
    start: f.start,
    end: f.end,
    matchedText: f.matchedText,
    coveredText: f.coveredText,
    coveredRanges: f.coveredRanges || [{ start: f.start, end: f.end }],
    scopes: f.scopes,
    nodeIds: f.nodeIds,
    suggestions: f.suggestions,
    suppressed: f.suppressed,
    suppressedReason: f.suppressedReason,
    contentKey: f.contentKey,
  }
}

function normalizeChange(c) {
  return {
    start: Number(c.start),
    end: c.end == null ? Number(c.start) : Number(c.end),
    newEnd: c.newEnd == null ? undefined : Number(c.newEnd),
  }
}

/**
 * 发布检查：使用“服务器当前已发布规则快照”对指定文稿版本/内容做扫描，
 * 返回是否可发布。这是发布闸门；浏览器提示用同一快照（版本号回传校验）。
 */
export async function handlePublishCheck(body) {
  const { snapshot, error } = await resolveSnapshot(body.version)
  if (error) return { error }

  let content
  let docRow = null
  if (body.docId && body.docVersion) {
    const row = await getDocumentVersion(body.docId, Number(body.docVersion))
    if (!row) {
      return { error: { status: 404, message: 'document version not found' } }
    }
    content = row.content
    docRow = row
  } else {
    content = body.content ?? ''
  }

  const tree = parseCatalpa(content)
  const findings = scanTree(tree, snapshot, { docId: body.docId || '_doc' })
  const blocking = findings.filter((f) => !f.suppressed)
  const suppressed = findings.filter((f) => f.suppressed)

  // 发布闸门：存在任一未静默命中即拒绝（替换建议必须用户选择后才会消失）
  const allowed = blocking.length === 0
  const contentHash = fnv1a(content)
  let publishedRecord = null
  if (allowed && body.confirm) {
    await markPublished(body.docId || '_doc', snapshot.version, contentHash)
    publishedRecord = { docId: body.docId || '_doc', ruleVersion: snapshot.version, contentHash }
  }

  return {
    allowed,
    docId: body.docId || '_doc',
    docVersion: docRow?.version ?? body.docVersion ?? null,
    contentHash,
    ruleVersion: snapshot.version,
    rulePublishedAt: snapshot.publishedAt,
    blocking: blocking.map(serializeFinding),
    suppressedCount: suppressed.length,
    published: publishedRecord,
    hint: allowed
      ? '通过：未发现禁用词命中（浏览器提示与本次检查使用同一规则快照）'
      : `未通过：存在 ${blocking.length} 处需处理的命中（替换或添加具体例外后重新检查）`,
  }
}

