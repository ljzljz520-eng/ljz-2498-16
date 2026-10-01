// 前端 API 客户端。所有规则数据、快照、例外以服务端为权威来源；浏览器本地
// Worker 只承载同一份扫描引擎用于“输入不阻塞”的即时提示，判定口径一致。

const BASE = '/api'

async function request(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.message || `HTTP ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export const api = {
  // 规则
  listRules: () => request('GET', '/rules'),
  createRule: (input) => request('POST', '/rules', input),
  updateRule: (id, input) => request('PUT', `/rules/${encodeURIComponent(id)}`, input),
  deleteRule: (id) => request('DELETE', `/rules/${encodeURIComponent(id)}`),
  retractRule: (id) => request('POST', `/rules/${encodeURIComponent(id)}/retract`),

  // 词形映射
  listWordForms: () => request('GET', '/word-forms'),
  createWordForm: (input) => request('POST', '/word-forms', input),
  deleteWordForm: (id) => request('DELETE', `/word-forms/${encodeURIComponent(id)}`),

  // 人工例外
  listExceptions: () => request('GET', '/exceptions'),
  addException: (input) => request('POST', '/exceptions', input),
  deleteException: (id) => request('DELETE', `/exceptions/${encodeURIComponent(id)}`),

  // 快照
  listSnapshots: () => request('GET', '/snapshots'),
  currentSnapshot: () => request('GET', '/snapshots/current'),
  publishSnapshot: (note) => request('POST', '/snapshots/publish', { note }),

  // 文稿版本
  saveVersion: (docId, content, contentHash) =>
    request('POST', `/documents/${encodeURIComponent(docId)}/versions`, { content, contentHash }),

  // 扫描（mode: full/incremental；服务端为权威兜底）
  scan: (payload) => request('POST', '/scan', payload),
  publishCheck: (payload) => request('POST', '/publish-check', payload),
}

