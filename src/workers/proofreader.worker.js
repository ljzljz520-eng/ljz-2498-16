// 扫描 Worker：在后台线程跑同一份 scanTree，主线程输入永不被扫描阻塞。
//
// 消息：{ type:'scan', id, text, snapshot, docId, mode, change, baseline }
// 回包：{ type:'result', id, docVersion, ruleVersion, contentHash, findings,
//         modeReport }
// 快照由主线程从服务端拉取后传入（服务器发布检查与浏览器提示同快照同源）。

import { parseCatalpa } from '../shared/parse.js'
import { scanTree } from '../shared/proofreader.js'
import { IncrementalScanner } from '../shared/incremental.js'
import { fnv1a } from '../shared/scheduler.js'

// 按 docId 保留增量扫描器（内含上次全文、树与节点缓存）
const scanners = new Map()

self.onmessage = (e) => {
  const msg = e.data
  if (msg.type !== 'scan') return
  const { id, text, snapshot, docId = '_doc', mode, change } = msg

  let findings
  let modeReport = null

  if (mode === 'incremental') {
    let entry = scanners.get(docId)
    if (!entry || entry.snapshotVersion !== snapshot.version) {
      // 规则快照变更：新扫描器内部丢弃旧缓存，下一次扫描整稿必要重算
      entry = {
        scanner: new IncrementalScanner(snapshot, { docId }),
        snapshotVersion: snapshot.version,
        initialized: false,
      }
      scanners.set(docId, entry)
    }
    const canIncrement = entry.initialized && change
    if (canIncrement) {
      const t0 = performance.now()
      findings = entry.scanner.update(text, change, docId)
      const incMs = performance.now() - t0
      const t1 = performance.now()
      const full = scanTree(parseCatalpa(text), snapshot, { docId })
      const fullMs = performance.now() - t1
      modeReport = {
        path: 'incremental',
        equal: findingsEqual(findings, full),
        incMs: Number(incMs.toFixed(3)),
        fullMs: Number(fullMs.toFixed(3)),
      }
      // 两者逐条一致（引擎测试保证）；以全量结果为权威展示
      findings = full
    } else {
      findings = entry.scanner.fullScan(text, docId)
      modeReport = { path: 'full(baseline)' }
    }
    entry.initialized = true
  } else {
    findings = scanTree(parseCatalpa(text), snapshot, { docId })
    modeReport = { path: 'full' }
  }

  self.postMessage({
    type: 'result',
    id,
    docVersion: msg.docVersion,
    ruleVersion: snapshot.version,
    contentHash: fnv1a(text),
    findings,
    modeReport,
  })
}

function findingsEqual(a, b) {
  if (a.length !== b.length) return false
  const k = (f) => `${f.ruleId}:${f.start}:${f.end}:${f.matchedText}`
  const x = a.map(k).sort()
  const y = b.map(k).sort()
  return x.every((v, i) => v === y[i])
}


