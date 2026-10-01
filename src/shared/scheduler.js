// 扫描调度：保证“前端输入不被扫描阻塞”“快速连续修改只应用最新版本结果”。
//
// - 文本变化立即进入 scanning 态并启动防抖扫描（默认 180ms）；扫描函数由
//   外层提供（生产环境是 Worker 往返），永不阻塞按键；
// - 每次输入分配单调递增 docVersion + contentHash；结果回填时必须同时匹配
//   docVersion / contentHash / 规则快照版本，否则丢弃——旧结果只展示在对应
//   版本，绝不能覆盖新版本视图；
// - 快照刷新使所有在途/已完成结果失效；
// - IME 合成期间不调度，合成结束才扫描（composition 事件由视图层通知）。
//
// 不绑定 DOM，时钟可注入，便于 node:test 快速连续修改测试。

export function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
}

export class ScanScheduler {
  /**
   * @param scanFn async ({text, snapshot}) => findings
   * @param onResult (state) => void
   * @param opts {delay, clock, getSnapshot, snapshot, onStaleVersion}
   */
  constructor(scanFn, onResult, opts = {}) {
    this.scanFn = scanFn
    this.onResult = onResult || (() => {})
    this.delay = opts.delay ?? 180
    this.clock = opts.clock || defaultClock
    this._snapshot = opts.snapshot || null
    this.getSnapshot = opts.getSnapshot || null
    this.onStaleVersion = opts.onStaleVersion || null

    this.text = ''
    this.composing = false
    this.docVersion = 0
    this.contentHash = fnv1a('')
    this._timer = null
    this._inFlight = 0
    this.state = {
      status: 'idle', // idle | scanning | current | error
      text: '',
      docVersion: 0,
      contentHash: this.contentHash,
      ruleVersion: this.currentSnapshot()?.version ?? null,
      findings: [],
      scannedAt: null,
      error: null,
    }
  }

  currentSnapshot() {
    return this.getSnapshot ? this.getSnapshot() : this._snapshot
  }

  /** 通知文本变化。change 为 {start,end,newEnd}（增量用），可缺省。 */
  notify(text, change = null) {
    this.text = text
    this.docVersion += 1
    this.contentHash = fnv1a(text)
    this.lastChange = change
    const snap = this.currentSnapshot()
    this.state.status = 'scanning'
    this.state.error = null
    this.state.text = text
    this.state.docVersion = this.docVersion
    this.state.contentHash = this.contentHash
    this.state.ruleVersion = snap?.version ?? null
    if (!this.composing) this.#schedule()
  }

  setComposing(composing) {
    this.composing = composing
    if (!composing && this.state.status === 'scanning') {
      // 合成结束：用最新文本扫一次
      this.#schedule()
    }
  }

  setSnapshot(snapshot) {
    this._snapshot = snapshot
    // 快照版本变化：在途结果完成后会因版本不符被丢弃；立即标记 scanning
    this.state.ruleVersion = snapshot?.version ?? null
    this.state.status = 'scanning'
    this.#schedule()
  }

  async flushNow() {
    if (this._timer) {
      this.clock.clearTimeout(this._timer)
      this._timer = null
    }
    return this.#runScan()
  }

  #schedule() {
    if (this._timer) this.clock.clearTimeout(this._timer)
    this._timer = this.clock.setTimeout(() => {
      this._timer = null
      this.#runScan()
    }, this.delay)
  }

  async #runScan() {
    const version = this.docVersion
    const hash = this.contentHash
    const text = this.text
    const snap = this.currentSnapshot()
    const ruleVersion = snap?.version ?? null
    this._inFlight += 1

    let findings
    try {
      findings = await this.scanFn({ text, snapshot: snap })
    } catch (err) {
      if (version === this.docVersion && hash === this.contentHash) {
        this.state.status = 'error'
        this.state.error = String((err && err.message) || err)
      }
      return
    }

    // 版本闸门：文档版本 + 内容哈希 + 规则快照版本三者同时匹配才应用
    const latestSnap = this.currentSnapshot()
    const latestRuleVersion = latestSnap?.version ?? null
    if (version !== this.docVersion || hash !== this.contentHash ||
        ruleVersion !== latestRuleVersion) {
      if (this.onStaleVersion) this.onStaleVersion({ version, ruleVersion, latestRuleVersion })
      return
    }

    this.state.status = 'current'
    this.state.text = text
    this.state.docVersion = version
    this.state.contentHash = hash
    this.state.ruleVersion = ruleVersion
    this.state.findings = findings
    this.state.scannedAt = this.clock.now()
    this.onResult(this.state)
  }
}
