// 校对调度器（与框架解耦的核心类 + Vue 薄封装）。
//
// 关键保证：
//  1. 输入不被扫描阻塞：扫描异步进行（可取消），编辑/输入法 composition 期间完全不发起请求。
//  2. 结果按“来源文本版本”归档：每个结果带 sourceHash，只有与当前文本一致的版本参与高亮；
//     旧结果只展示在它对应的历史版本下，绝不叠加到新文本上造成错位。
//  3. 快速连续修改：debounce + 单调序号 + AbortController，过期响应一律丢弃。
//  4. 优先按节点增量扫描；规则快照 / 词形映射 / 例外集合变更时服务端自动回退全量重扫。
import { reactive } from 'vue'
import { fnv1a } from '../core/hash.js'

export class ProofreadingScheduler {
  constructor(transport) {
    this.transport = transport // { scan, publishCheck, addException, deleteException, listExceptions, getState }
    this.docId = 'doc-main'
    this.source = ''
    this.sourceHash = null
    this.composing = false // 输入法正在组字：未提交文本不扫描
    this.debounceMs = 350
    this._timer = null
    this._seq = 0
    this._abort = null
    this._pendingWhileComposing = false
    this._lastSuccess = null

    this.state = {
      scanning: false,
      activeHash: null,
      versions: [], // [{ hash, at, mode, hits, rulesVersion, ... }]，按来源文本版本归档
      rulesVersion: null, // 当前高亮结果所依据的规则版本
      serverRulesVersion: null, // 服务器最新已发布版本
      exceptions: [],
      snapshotStale: false, // 高亮结果与服务器最新快照不一致
      lastError: '',
    }
  }

  async init() {
    const [snap, ex] = await Promise.all([
      this.transport.getState(),
      this.transport.listExceptions(this.docId),
    ])
    this.state.rulesVersion = snap.activeVersion
    this.state.serverRulesVersion = snap.snapshot.version
    this.state.exceptions = ex.exceptions || []
    this.schedule(0)
  }

  // 已提交文本变化。
  setSource(source) {
    this.source = source
    this.sourceHash = fnv1a(source)
    this.state.activeHash = this.sourceHash
    if (this.composing) {
      this._pendingWhileComposing = true
      return
    }
    this.schedule()
  }

  compositionStart() {
    // 进入输入法组字：取消任何已排定的扫描，保证未提交文本绝不离开编辑器。
    this.composing = true
    clearTimeout(this._timer)
    this._timer = null
  }

  compositionEnd() {
    // compositionend 后浏览器未必已刷新 v-model，延迟一拍再调度。
    this.composing = false
    if (this._pendingWhileComposing) {
      this._pendingWhileComposing = false
      this.schedule(0)
    }
  }

  schedule(delay = this.debounceMs) {
    clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this.runScan().catch(() => {})
    }, delay)
  }

  // 当前文本版本的命中（只有它参与高亮）。
  currentHits() {
    const v = this.state.versions.find((x) => x.hash === this.state.activeHash)
    return v ? v.hits : []
  }

  currentRecord() {
    return this.state.versions.find((x) => x.hash === this.state.activeHash) || null
  }

  async runScan() {
    const seq = ++this._seq
    if (this._abort) this._abort.abort()
    const controller = new AbortController()
    this._abort = controller
    this.state.scanning = true
    this.state.lastError = ''

    const prev = this._lastSuccess
    try {
      const payload = {
        source: this.source,
        docId: this.docId,
        mode: prev ? 'auto' : 'full',
        prevSummary: prev ? prev.summary : [],
        prevHits: prev ? prev.hits : [],
        base: prev
          ? {
              rulesVersion: prev.rulesVersion,
              mappingsVersion: prev.mappingsVersion,
              exceptionsHash: prev.exceptionsHash,
            }
          : {},
      }
      const result = await this.transport.scan(payload, controller.signal)
      if (seq !== this._seq || this._abort !== controller) return // 过期响应丢弃

      const hash = this.sourceHash
      const record = {
        hash,
        at: Date.now(),
        mode: result.mode,
        hits: result.hits,
        rulesVersion: result.rulesVersion,
        mappingsVersion: result.mappingsVersion,
        exceptionsHash: result.exceptionsHash,
      }
      this._lastSuccess = { ...record, summary: result.summary }

      // 结果归到来源版本：覆盖同一文本版本的旧结果，绝不污染其它版本。
      const idx = this.state.versions.findIndex((v) => v.hash === hash)
      if (idx >= 0) this.state.versions.splice(idx, 1, record)
      else this.state.versions.push(record)
      if (this.state.versions.length > 8) this.state.versions.shift()

      this.state.rulesVersion = result.rulesVersion
      this.state.snapshotStale =
        this.state.serverRulesVersion != null && result.rulesVersion !== this.state.serverRulesVersion
    } catch (err) {
      if (err.name === 'AbortError') return
      if (seq !== this._seq) return
      this.state.lastError = err.message || String(err)
    } finally {
      if (seq === this._seq) this.state.scanning = false
    }
  }

  // 管理页发布新版本 / 词形更新后：下一次扫描因 base 版本不一致而自动全量重扫。
  async refreshSnapshot() {
    const snap = await this.transport.getState()
    this.state.serverRulesVersion = snap.snapshot.version
    const ex = await this.transport.listExceptions(this.docId)
    this.state.exceptions = ex.exceptions || []
    this._lastSuccess = null
    this.state.snapshotStale =
      this.state.rulesVersion != null && this.state.rulesVersion !== snap.snapshot.version
    this.schedule(0)
  }

  // 人工例外：绑定规则 + 具体折叠片段 + 上下文；不存在“全局忽略”。
  async addException(hit, note = '') {
    await this.transport.addException({
      ruleId: hit.ruleId,
      ruleVersion: hit.ruleVersion,
      docId: this.docId,
      snippet: hit.foldSnippet,
      contextBefore: hit.contextBefore || '',
      contextAfter: hit.contextAfter || '',
      note,
    })
    this.state.exceptions = (await this.transport.listExceptions(this.docId)).exceptions || []
    this._lastSuccess = null // 例外集合变化 -> 必须全量重算
    await this.runScan()
  }

  async removeException(id) {
    await this.transport.deleteException(id)
    this.state.exceptions = (await this.transport.listExceptions(this.docId)).exceptions || []
    this._lastSuccess = null
    await this.runScan()
  }

  // 发布检查：与浏览器提示使用同一规则快照与同一扫描内核。
  async publishCheck() {
    const result = await this.transport.publishCheck(
      { source: this.source, docId: this.docId },
      this._abort?.signal,
    )
    this.state.snapshotStale =
      this.state.rulesVersion != null && result.rulesVersion !== this.state.rulesVersion
    return result
  }
}

// Vue 薄封装：把调度器状态替换为响应式代理。
// 关键点：Vue 的 reactive 只在“经代理写入”时触发依赖；调度器内部直接改
// this.state.xxx，若保留原始对象则 UI 不会刷新。这里让 scheduler.state 本身
// 指向代理，于是调度器后续的所有写入都走代理（嵌套数组/对象在经代理首次访问时
// 也会被转成响应式），保证扫描归档/指示器实时更新。
export function useProofreading(transport) {
  const scheduler = new ProofreadingScheduler(transport)
  const state = reactive(scheduler.state)
  scheduler.state = state
  return { scheduler, state }
}
