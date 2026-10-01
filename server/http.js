// 零依赖 HTTP 服务：校对 API + 生产构建后的静态资源。
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { JsonStore } from './store.js'
import { runScan, runPublishCheck } from './scan-service.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST_DIR = join(__dirname, '..', 'dist')
const DB_FILE = join(__dirname, 'data', 'db.json')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 5 * 1024 * 1024) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

async function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname
  let filePath = normalize(join(DIST_DIR, rel))
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  try {
    const s = await stat(filePath)
    if (s.isDirectory()) filePath = join(filePath, 'index.html')
    const data = await readFile(filePath)
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    // SPA 回退
    try {
      const index = await readFile(join(DIST_DIR, 'index.html'))
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(index)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('未找到前端构建产物，请先执行 pnpm build')
    }
  }
}

export function createApp() {
  const store = new JsonStore(DB_FILE)

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname
    const method = req.method

    try {
      // ---- 状态 / 快照 ----
      if (pathname === '/api/state' && method === 'GET') {
        const state = store.getState()
        return sendJson(res, 200, {
          rules: state.rules,
          mappings: state.mappings,
          versions: state.versions,
          activeVersion: state.rulesVersion,
          snapshot: store.getActiveSnapshot(),
        })
      }

      if (pathname === '/api/snapshot' && method === 'GET') {
        return sendJson(res, 200, store.getActiveSnapshot())
      }

      if (pathname === '/api/versions' && method === 'GET') {
        return sendJson(res, 200, { versions: store.listVersions() })
      }

      // ---- 规则草稿 ----
      if (pathname === '/api/rules' && method === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, { rule: store.saveRule(body) })
      }
      if (pathname.startsWith('/api/rules/') && method === 'DELETE') {
        store.deleteRule(decodeURIComponent(pathname.split('/').pop()))
        return sendJson(res, 200, { ok: true })
      }

      // ---- 词形映射草稿 ----
      if (pathname === '/api/mappings' && method === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, { mapping: store.saveMapping(body) })
      }
      if (pathname.startsWith('/api/mappings/') && method === 'DELETE') {
        store.deleteMapping(decodeURIComponent(pathname.split('/').pop()))
        return sendJson(res, 200, { ok: true })
      }

      // ---- 发布新版本 ----
      if (pathname === '/api/publish' && method === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, { snapshot: store.publish(body.note || '') })
      }

      // ---- 人工例外 ----
      if (pathname === '/api/exceptions' && method === 'GET') {
        const docId = url.searchParams.get('docId') || 'default'
        return sendJson(res, 200, { exceptions: store.listExceptions(docId) })
      }
      if (pathname === '/api/exceptions' && method === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, { exception: store.addException(body) })
      }
      if (pathname.startsWith('/api/exceptions/') && method === 'DELETE') {
        store.deleteException(decodeURIComponent(pathname.split('/').pop()))
        return sendJson(res, 200, { ok: true })
      }

      // ---- 扫描（全量/增量） ----
      if (pathname === '/api/scan' && method === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, runScan(store, body))
      }

      // ---- 发布检查 ----
      if (pathname === '/api/publish-check' && method === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, runPublishCheck(store, body))
      }

      // ---- 静态资源 ----
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not found' })
      }
      return serveStatic(res, pathname)
    } catch (err) {
      return sendJson(res, 500, { error: err.message || 'server error' })
    }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787)
  createApp().listen(port, () => {
    console.log(`[catalpa-proof] API/静态服务已启动: http://localhost:${port}`)
  })
}
