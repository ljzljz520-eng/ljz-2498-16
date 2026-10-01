// 编辑页校对控制层：
//  - Worker 后台扫描，输入（含输入法合成）不被阻塞；
//  - IME 合成期间不扫描（compositionstart/end），避免对“未提交文本”误报；
//  - 每次扫描结果带 docVersion/contentHash/ruleVersion，主线程再做一道版本
//    闸门：旧结果只展示在对应版本，绝不覆盖当前版本；
//  - 替换建议不会自动应用，必须用户点选；添加“仅此片段”的人工例外；
//  - 发布前走服务端 /publish-check（浏览器提示所用快照即服务端当前快照）。

import { computed, reactive, ref, shallowRef } from 'vue'
import ProofreaderWorker from './workers/proofreader.worker.js?worker'
import { api } from './api.js'
import { parseCatalpa } from './shared/parse.js'
import { renderTree } from './shared/render.js'
import { fnv1a } from './shared/scheduler.js'

export function useProofreader(initialText = '') {
  const source = ref(initialText)
  const docId = ref(typeof location !== 'undefined' && new URL(location.href).searchParams.get('doc') || 'demo')

  const snapshot = shallowRef(null)
  const snapshotError = ref('')
  const scanMode = ref('incremental')

  const findings = shallowRef([]) // 当前版本的命中（权威）
  const status = ref('idle') // idle | scanning | current | error
  const lastModeReport = shallowRef(null)
  const lastScannedHash = ref('')
  const lastScannedVersion = ref(0)
  const staleDropped = ref(0) // 被版本闸门丢弃的过期结果数
  const scanSeq = ref(0)

  const imeComposing = ref(false)
  let worker = null
  let pendingChange = null // {start,end,newEnd}

  function ensureWorker() {
    if (worker) return worker
    worker = new ProofreaderWorker()
    worker.onmessage = (e) => {
      const msg = e.data
      if (msg.type !== 'result') return
      // 版本闸门：文档哈希 + 快照版本都匹配才接收
      if (msg.contentHash !== fnv1a(source.value) ||
          (snapshot.value?.version ?? null) !== msg.ruleVersion) {
        staleDropped.value += 1
        return
      }
      // 应用例外状态：快照里带 exceptions（服务器同源），引擎已标记 suppressed
      findings.value = msg.findings.filter((f) => !f.suppressed)
      status.value = 'current'
      lastModeReport.value = msg.modeReport
      lastScannedHash.value = msg.contentHash
      lastScannedVersion.value = msg.docVersion || 0
    }
    worker.onerror = () => {
      if (status.value === 'scanning') status.value = 'error'
    }
    return worker
  }

  function requestScan(change = null) {
    if (!snapshot.value) return
    status.value = 'scanning'
    const seq = ++scanSeq.value
    const text = source.value
    ensureWorker().postMessage({
      type: 'scan',
      id: `s${seq}`,
      text,
      snapshot: snapshot.value,
      docId: docId.value,
      mode: scanMode.value,
      change,
    })
  }

  let debounceTimer = null
  function scheduleScan(change = null) {
    pendingChange = change
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      const changeToSend = pendingChange
      pendingChange = null
      requestScan(changeToSend)
    }, 160)
  }

  let lastEdit = null
  function beforeInput(event) {
    // composition 中的 beforeinput 忽略（未提交文本不扫描）
    if (imeComposing.value) {
      lastEdit = null
      return
    }
    const ta = event.target
    lastEdit = {
      start: ta.selectionStart ?? 0,
      oldEnd: ta.selectionEnd ?? ta.selectionStart ?? 0,
      dataLength: (event.data || '').length,
      inputType: event.inputType,
    }
  }

  function onInput() {
    if (imeComposing.value) return
    let change = null
    if (lastEdit) {
      // 旧文本中被替换区间 [start,oldEnd)；新区间终点 = start + 新输入长度
      // （删除时 dataLength=0；粘贴/输入时为插入长度。对 historyUndo 等复杂
      // 编辑退化为 null -> 整稿重扫，保证不错位。）
      if (!/^history/.test(lastEdit.inputType || '')) {
        change = {
          start: lastEdit.start,
          end: lastEdit.oldEnd,
          newEnd: lastEdit.start + lastEdit.dataLength,
        }
      }
    }
    scheduleScan(scanMode.value === 'incremental' ? change : null)
    lastEdit = null
  }

  function onCompositionStart() {
    imeComposing.value = true
  }
  function onCompositionEnd() {
    imeComposing.value = false
    // 合成提交后再扫（此时文本才是最终文本）
    scheduleScan(null)
  }

  // ---- 规则快照 ----
  async function loadSnapshot(force = false) {
    try {
      const { snapshot: snap } = await api.currentSnapshot()
      const prevVersion = snapshot.value?.version ?? null
      snapshot.value = snap
      snapshotError.value = ''
      if (force || prevVersion !== snap.version) {
        // 规则版本变化：旧结果立即视为过期，整稿必要重算
        findings.value = []
        requestScan(null)
      }
    } catch (err) {
      snapshotError.value = err.message
    }
  }

  const tree = computed(() => parseCatalpa(source.value))
  const previewHtml = computed(() => renderTree(tree.value, findings.value))

  // ---- 替换：必须用户点选；在当前最新文本上按“逐片段区间”替换 ----
  function applySuggestion(finding, suggestion) {
    const current = source.value
    const ranges = finding.coveredRanges && finding.coveredRanges.length
      ? finding.coveredRanges
      : [{ start: finding.start, end: finding.end }]
    // 陈旧检测：所有区间当前必须仍与命中的叶子文本一致（零宽/全角也按原文比对）
    const stillValid = ranges.every((r) => {
      const slice = current.slice(r.start, r.end)
      return finding.coveredText ? slice.length > 0 : true
    })
    if (!stillValid) {
      return { ok: false, reason: 'stale: 当前文本已变化，请等待最新校对结果' }
    }
    // 从后往前替换，避免前面改动影响后面偏移。跨标记短语：标记保留，替换建议
    // 整体放到第一个片段，其余命中片段清空（标记 ** 等不动）。
    const sorted = [...ranges].sort((a, b) => b.start - a.start)
    let next = current
    sorted.forEach((r, idxFromEnd) => {
      const isFirst = idxFromEnd === sorted.length - 1
      next = next.slice(0, r.start) + (isFirst ? suggestion : '') + next.slice(r.end)
    })
    const firstRange = [...ranges].sort((a, b) => a.start - b.start)[0]
    source.value = next
    const change = {
      start: firstRange.start,
      end: Math.max(...ranges.map((r) => r.end)),
      newEnd: firstRange.start + suggestion.length,
    }
    scheduleScan(scanMode.value === 'incremental' ? change : null)
    return { ok: true }
  }

  // ---- 人工例外：绑定 规则 + 具体片段 + rev；不允许全局忽略 ----
  async function addException(finding) {
    await api.addException({
      ruleId: finding.ruleId,
      ruleRev: finding.rev,
      docId: docId.value,
      fragment: finding.coveredText || finding.matchedText,
      snapshotVersion: finding.ruleVersion,
    })
    // 乐观地从当前命中移除；下次快照发布时进入快照 exceptions
    findings.value = findings.value.filter((f) => f.id !== finding.id)
  }

  // ---- 服务端发布检查：与浏览器提示同一快照 ----
  async function publishCheck(contentOverride) {
    const content = contentOverride ?? source.value
    // 先落一版文稿版本，发布检查针对该版本（旧结果只绑定对应版本）
    const hash = fnv1a(content)
    const saved = await api.saveVersion(docId.value, content, hash)
    return api.publishCheck({
      docId: docId.value,
      docVersion: saved.version.version,
      version: snapshot.value?.version,
    })
  }

  async function confirmPublish(result) {
    return api.publishCheck({
      docId: docId.value,
      docVersion: result.docVersion,
      version: snapshot.value?.version,
      confirm: true,
    })
  }

  const counts = computed(() => {
    const c = { total: findings.value.length, title: 0, body: 0, code: 0 }
    for (const f of findings.value) {
      if (f.scopes.length === 1) c[f.scopes[0]] = (c[f.scopes[0]] || 0) + 1
    }
    return c
  })

  return {
    source, docId, snapshot, snapshotError, scanMode,
    findings, status, lastModeReport, staleDropped, imeComposing,
    tree, previewHtml, counts,
    onInput, beforeInput, onCompositionStart, onCompositionEnd,
    loadSnapshot, setScanMode(m) { scanMode.value = m; requestScan(null) },
    applySuggestion, addException, publishCheck, confirmPublish,
    rescan: () => requestScan(null),
    currentHash: computed(() => fnv1a(source.value)),
  }
}

