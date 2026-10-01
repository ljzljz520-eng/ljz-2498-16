// 前端 API 客户端。开发期由 Vite 代理到 Node 服务，生产期同源。
async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return res.json()
}

export const api = {
  getState: (signal) => request('/api/state', { signal }),
  getSnapshot: (signal) => request('/api/snapshot', { signal }),
  saveRule: (rule) => request('/api/rules', { method: 'POST', body: JSON.stringify(rule) }),
  deleteRule: (id) => request(`/api/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  saveMapping: (mapping) => request('/api/mappings', { method: 'POST', body: JSON.stringify(mapping) }),
  deleteMapping: (id) => request(`/api/mappings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  publish: (note) => request('/api/publish', { method: 'POST', body: JSON.stringify({ note }) }),
  listExceptions: (docId, signal) =>
    request(`/api/exceptions?docId=${encodeURIComponent(docId || 'default')}`, { signal }),
  addException: (ex) => request('/api/exceptions', { method: 'POST', body: JSON.stringify(ex) }),
  deleteException: (id) => request(`/api/exceptions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  scan: (payload, signal) => request('/api/scan', { method: 'POST', body: JSON.stringify(payload), signal }),
  publishCheck: (payload, signal) =>
    request('/api/publish-check', { method: 'POST', body: JSON.stringify(payload), signal }),
}
