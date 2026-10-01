// Catalpa 规则校对 API + 静态托管。
// 开发：Vite (3000) 代理 /api -> 本服务 (3001)。
// 生产：本服务同时托管 dist/ 静态资源（pnpm build && pnpm start）。

import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as db from './db.js'
import { handleScan, handlePublishCheck } from './scan-service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3001)
const DIST_DIR = path.join(__dirname, '..', 'dist')

function send(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}

const json = (fn) => async (req, res, params = {}) => {
  try {
    const body = req.method === 'GET' ? {} : await readJson(req)
    const result = await fn(body, req, res, params)
    if (res.writableEnded) return
    if (result && result.error) {
      send(res, result.error.status || 400, result.error)
    } else {
      send(res, 200, result)
    }
  } catch (err) {
    send(res, 400, { status: 400, message: String(err && err.message || err) })
  }
}

const routes = []
const route = (method, pattern, handler) => {
  // pattern: /api/xxx/:id
  const keys = []
  const rx = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => {
      keys.push(m.slice(1))
      return '([^/]+)'
    }) + '/?$',
  )
  routes.push({ method, rx, keys, handler })
}

// ---- 规则管理 ----
route('GET', '/api/rules', json(async () => ({ rules: await db.listRules(true) })))
route('POST', '/api/rules', json(async (body) => ({ rule: await db.createRule(body) })))
route('PUT', '/api/rules/:id', json(async (body, req, _res, params) => {
  const rule = await db.updateRule(params.id, body)
  if (!rule) return { error: { status: 404, message: 'rule not found' } }
  return { rule }
}))
route('DELETE', '/api/rules/:id', json(async (_b, _r, _s, params) => {
  await db.deleteRule(params.id)
  return { ok: true }
}))
route('POST', '/api/rules/:id/retract', json(async (_b, _r, _s, params) => {
  const rule = await db.retractRule(params.id)
  if (!rule) return { error: { status: 404, message: 'rule not found' } }
  return { rule }
}))

// ---- 词形映射 ----
route('GET', '/api/word-forms', json(async () => ({ wordForms: await db.listWordForms() })))
route('POST', '/api/word-forms', json(async (body) => ({ wordForm: await db.createWordForm(body) })))
route('DELETE', '/api/word-forms/:id', json(async (_b, _r, _s, params) => {
  await db.deleteWordForm(params.id)
  return { ok: true }
}))

// ---- 人工例外 ----
route('GET', '/api/exceptions', json(async () => ({ exceptions: await db.listExceptions() })))
route('POST', '/api/exceptions', json(async (body) => ({ exception: await db.addException(body) })))
route('DELETE', '/api/exceptions/:id', json(async (_b, _r, _s, params) => {
  await db.deleteException(params.id)
  return { ok: true }
}))

// ---- 快照 / 发布 ----
route('GET', '/api/snapshots', json(async () => ({ snapshots: await db.listSnapshots() })))
route('GET', '/api/snapshots/current', json(async () => {
  const snap = await db.getCurrentSnapshot()
  if (!snap) return { error: { status: 409, message: 'no snapshot published' } }
  return { snapshot: snap }
}))
route('GET', '/api/snapshots/:version', json(async (_b, _r, _s, params) => {
  const snap = await db.getSnapshot(Number(params.version))
  if (!snap) return { error: { status: 404, message: 'not found' } }
  return { snapshot: snap }
}))
route('POST', '/api/snapshots/publish', json(async (body) => {
  const result = await db.publishSnapshot(body.note || '')
  return result
}))

// ---- 文稿版本 ----
route('POST', '/api/documents/:id/versions', json(async (body, _r, _s, params) => {
  const { fnv1a } = await import('../src/shared/scheduler.js')
  const content = body.content ?? ''
  const snap = await db.getCurrentSnapshot()
  const saved = await db.saveDocumentVersion(
    params.id, content, body.contentHash || fnv1a(content), snap?.version ?? null,
  )
  return { version: saved }
}))
route('GET', '/api/documents/:id/versions/:version', json(async (_b, _r, _s, params) => {
  const row = await db.getDocumentVersion(params.id, Number(params.version))
  if (!row) return { error: { status: 404, message: 'not found' } }
  return { version: row }
}))

// ---- 扫描 / 发布检查 ----
route('POST', '/api/scan', json(async (body) => handleScan(body)))
route('POST', '/api/publish-check', json(async (body) => handlePublishCheck(body)))

route('GET', '/api/health', json(async () => ({
  ok: true,
  snapshot: (await db.getCurrentSnapshot())?.version ?? null,
})))

// ---------- 静态资源（生产） ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost')
  let p = decodeURIComponent(url.pathname)
  if (p === '/') p = '/index.html'
  // sql.js wasm
  if (p.startsWith('/node_modules/')) {
    const filePath = path.join(__dirname, '..', p)
    try {
      const data = await fs.readFile(filePath)
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' })
      return res.end(data)
    } catch {
      // fallthrough 404
    }
  }
  const filePath = path.join(DIST_DIR, p)
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403)
    return res.end('forbidden')
  }
  try {
    const data = await fs.readFile(filePath)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' })
    return res.end(data)
  } catch {
    // SPA fallback
    try {
      const index = await fs.readFile(path.join(DIST_DIR, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(index)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('dist 未构建：先运行 pnpm build，或使用 pnpm dev 启动 Vite 开发服')
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    return res.end()
  }
  for (const r of routes) {
    if (r.method !== req.method) continue
    const m = r.rx.exec(url.pathname)
    if (!m) continue
    const params = {}
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]) })
    res.setHeader('Access-Control-Allow-Origin', '*')
    return r.handler(req, res, params)
  }
  if (url.pathname.startsWith('/api/')) {
    return send(res, 404, { status: 404, message: 'api not found' })
  }
  return serveStatic(req, res)
})

server.listen(PORT, async () => {
  await db.seedIfEmpty()
  const snap = await db.getCurrentSnapshot()
  console.log(`[proof-api] listening on http://localhost:${PORT} (current snapshot v${snap?.version ?? '-'})`)
})

export { server }

