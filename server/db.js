// SQLite 数据层（sql.js 纯 WASM 实现，免原生编译；变更后落盘到 data/proof.db）。
//
// 保存三类校对核心数据：
//   1) 规则版：rules（草稿）+ rule_revisions（每次发布为每条规则记一个 rev）；
//   2) 词形映射：word_forms（异体字/词 -> 规范写法，参与模式展开）；
//   3) 人工例外：exceptions（绑定规则 + 具体片段 + 文档 + 命中时的规则 rev，
//      永远是“具体例外”，不存在也不提供全局忽略开关）。
// 另有：snapshots（不可变规则快照）、documents/document_versions（文稿版本）。

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import initSqlJs from 'sql.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.PROOF_DATA_DIR || path.join(__dirname, '..', 'data')
const DB_PATH = path.join(DATA_DIR, 'proof.db')

let _db = null
let saveTimer = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  term TEXT NOT NULL,
  note TEXT DEFAULT '',
  suggestions_json TEXT DEFAULT '[]',
  scopes_json TEXT DEFAULT '["title","body","code"]',
  whole_word INTEGER DEFAULT 1,
  case_sensitive INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  is_published INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS rule_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  snapshot_version INTEGER NOT NULL,
  term TEXT NOT NULL,
  patch TEXT NOT NULL,
  UNIQUE(rule_id, rev)
);
CREATE TABLE IF NOT EXISTS word_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT,                       -- 可绑定某条规则；NULL = 全局词形
  name TEXT DEFAULT '',
  from_form TEXT NOT NULL,
  to_form TEXT NOT NULL,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS snapshots (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  published_at INTEGER,
  note TEXT DEFAULT '',
  payload_json TEXT NOT NULL,
  is_current INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  rule_rev INTEGER NOT NULL,
  doc_id TEXT DEFAULT '*',
  fragment TEXT NOT NULL,             -- 原始片段（服务端折叠存 key 供精确比对）
  content_key TEXT NOT NULL,          -- 折叠规范形态
  snapshot_version INTEGER,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT '',
  latest_version INTEGER DEFAULT 0,
  published_rule_version INTEGER,
  published_content_hash TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  rule_version_at_create INTEGER,
  created_at INTEGER,
  UNIQUE(doc_id, version)
);
`

export async function getDb() {
  if (_db) return _db
  await fs.mkdir(DATA_DIR, { recursive: true })
  const SQL = await initSqlJs()
  let db
  try {
    const buf = await fs.readFile(DB_PATH)
    db = new SQL.Database(buf)
  } catch {
    db = new SQL.Database()
  }
  db.run(SCHEMA)
  _db = db
  return db
}

// 合并落盘（防抖 150ms）
export function persist() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    const db = await getDb()
    const data = db.export()
    await fs.mkdir(DATA_DIR, { recursive: true })
    await fs.writeFile(DB_PATH, Buffer.from(data))
  }, 150)
}

async function persistNow() {
  const db = await getDb()
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(DB_PATH, Buffer.from(db.export()))
}

function nowMs() {
  return Date.now()
}

function rowToRule(r) {
  if (!r) return null
  return {
    id: r.id,
    term: r.term,
    note: r.note || '',
    suggestions: JSON.parse(r.suggestions_json || '[]'),
    scopes: JSON.parse(r.scopes_json || '["title","body","code"]'),
    wholeWord: !!r.whole_word,
    caseSensitive: !!r.case_sensitive,
    enabled: !!r.enabled,
    isPublished: !!r.is_published,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listRules(includeDisabled = true) {
  const db = await getDb()
  const res = db.exec('SELECT * FROM rules ORDER BY created_at ASC, id ASC')
  if (!res.length) return []
  const cols = res[0].columns
  const rows = res[0].values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])))
  return rows.map(rowToRule).filter((r) => includeDisabled || r.enabled)
}

export async function getRule(id) {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM rules WHERE id = ?')
  stmt.bind([id])
  let row = null
  if (stmt.step()) row = stmt.getAsObject()
  stmt.free()
  return rowToRule(row)
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`
}

export async function createRule(input) {
  const db = await getDb()
  const id = input.id || randomId('r')
  const ts = nowMs()
  db.run(
    `INSERT INTO rules (id,term,note,suggestions_json,scopes_json,whole_word,case_sensitive,enabled,is_published,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,1,0,?,?)`,
    [
      id,
      input.term,
      input.note || '',
      JSON.stringify(input.suggestions || []),
      JSON.stringify(input.scopes && input.scopes.length ? input.scopes : ['title', 'body', 'code']),
      input.wholeWord === false ? 0 : 1,
      input.caseSensitive ? 1 : 0,
      ts,
      ts,
    ],
  )
  persist()
  return getRule(id)
}

export async function updateRule(id, input) {
  const existing = await getRule(id)
  if (!existing) return null
  const merged = { ...existing, ...input }
  const db = await getDb()
  db.run(
    `UPDATE rules SET term=?, note=?, suggestions_json=?, scopes_json=?, whole_word=?,
      case_sensitive=?, enabled=?, updated_at=? WHERE id=?`,
    [
      merged.term,
      merged.note || '',
      JSON.stringify(merged.suggestions || []),
      JSON.stringify(merged.scopes && merged.scopes.length ? merged.scopes : ['title', 'body', 'code']),
      merged.wholeWord === false ? 0 : 1,
      merged.caseSensitive ? 1 : 0,
      merged.enabled ? 1 : 0,
      nowMs(),
      id,
    ],
  )
  persist()
  return getRule(id)
}

// 撤回（停用）规则：草稿 enabled=0；下一次发布后快照中不再含该规则
export async function retractRule(id) {
  return updateRule(id, { enabled: false })
}

export async function deleteRule(id) {
  const db = await getDb()
  db.run('DELETE FROM rules WHERE id=?', [id])
  persist()
}

export async function listWordForms() {
  const db = await getDb()
  const res = db.exec(
    `SELECT w.*, r.term AS rule_term FROM word_forms w
     LEFT JOIN rules r ON r.id = w.rule_id ORDER BY w.id ASC`)
  if (!res.length) return []
  const cols = res[0].columns
  return res[0].values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])))
}

export async function createWordForm(input) {
  const db = await getDb()
  db.run(
    'INSERT INTO word_forms (rule_id,name,from_form,to_form,created_at) VALUES (?,?,?,?,?)',
    [input.ruleId || null, input.name || '', input.from, input.to, nowMs()],
  )
  persist()
  return (await listWordForms()).at(-1)
}

export async function deleteWordForm(id) {
  const db = await getDb()
  db.run('DELETE FROM word_forms WHERE id=?', [Number(id)])
  persist()
}

/**
 * 发布：冻结当前全部启用规则（含各自新 rev）+ 词形 + 现存例外，生成不可变
 * 快照。规则内容相对上次发布有变化（或新增/撤回导致集合变化）才分配新 rev；
 * 未变化规则沿用原 rev，使绑定其上的人工例外继续有效。
 * @returns {version, revChanges, snapshot}
 */
export async function publishSnapshot(note = '') {
  const db = await getDb()
  const rules = await listRules(false)
  const wfRows = await listWordForms()
  const wordForms = wfRows.map((w) => ({ from: w.from_form, to: w.to_form }))

  // 取每条规则最近一次发布时的内容指纹与 rev
  const lastRev = new Map()
  const lastFingerprint = new Map()
  const revRes = db.exec(
    `SELECT rr.rule_id, rr.rev, rr.term
     FROM rule_revisions rr
     JOIN (SELECT rule_id, MAX(snapshot_version) mv FROM rule_revisions GROUP BY rule_id) m
       ON m.rule_id = rr.rule_id AND m.mv = rr.snapshot_version`)
  if (revRes.length) {
    const cols = revRes[0].columns
    for (const v of revRes[0].values) {
      const o = Object.fromEntries(cols.map((c, i) => [c, v[i]]))
      lastRev.set(o.rule_id, o.rev)
    }
  }
  // 指纹用于判断内容是否变化（建议、scope、大小写、整词、term 任一改变）
  const fingerprintOf = (r) => JSON.stringify([
    r.term, r.suggestions, r.scopes, r.wholeWord, r.caseSensitive,
  ])
  const fpRes = db.exec(
    `SELECT rule_id, patch FROM rule_revisions WHERE id IN
       (SELECT MAX(id) FROM rule_revisions GROUP BY rule_id)`)
  if (fpRes.length) {
    for (const v of fpRes[0].values) lastFingerprint.set(v[0], v[1])
  }

  const versionRes = db.exec('SELECT COALESCE(MAX(version),0)+1 AS v FROM snapshots')
  const version = versionRes[0].values[0][0]

  const revChanges = []
  const snapshotRules = []
  for (const r of rules) {
    const fp = fingerprintOf(r)
    let rev = lastRev.get(r.id)
    if (rev === undefined) {
      rev = 1
    } else if (lastFingerprint.get(r.id) !== fp) {
      rev += 1
    }
    if (!lastRev.has(r.id) || lastFingerprint.get(r.id) !== fp) {
      revChanges.push({ ruleId: r.id, rev })
      db.run(
        `INSERT INTO rule_revisions (rule_id,rev,snapshot_version,term,patch)
         VALUES (?,?,?,?,?)`,
        [r.id, rev, version, r.term, fp],
      )
    }
    snapshotRules.push({
      id: r.id, term: r.term, suggestions: r.suggestions, scopes: r.scopes,
      wholeWord: r.wholeWord, caseSensitive: r.caseSensitive, enabled: true, rev,
    })
  }

  // 快照内嵌当前例外（服务端权威存储），浏览器提示与发布检查读同一快照
  const exceptions = (await listExceptions()).map((e) => ({
    ruleId: e.rule_id, ruleRev: e.rule_rev, docId: e.doc_id,
    fragment: e.fragment,
  }))

  const payload = {
    version,
    publishedAt: nowMs(),
    note,
    rules: snapshotRules,
    wordForms,
    exceptions,
  }
  db.run(
    'INSERT INTO snapshots (version,published_at,note,payload_json,is_current) VALUES (?,?,?,?,1)',
    [version, payload.publishedAt, note, JSON.stringify(payload)],
  )
  db.run('UPDATE snapshots SET is_current=0 WHERE version <> ?', [version])
  db.run('UPDATE rules SET is_published=1')
  await persistNow()
  return { version, revChanges, snapshot: payload }
}

export async function getCurrentSnapshot() {
  const db = await getDb()
  const res = db.exec('SELECT payload_json FROM snapshots WHERE is_current=1 ORDER BY version DESC LIMIT 1')
  if (!res.length) return null
  return JSON.parse(res[0].values[0][0])
}

export async function getSnapshot(version) {
  const db = await getDb()
  const stmt = db.prepare('SELECT payload_json FROM snapshots WHERE version=?')
  stmt.bind([Number(version)])
  let payload = null
  if (stmt.step()) payload = JSON.parse(stmt.getAsObject().payload_json)
  stmt.free()
  return payload
}

export async function listSnapshots() {
  const db = await getDb()
  const res = db.exec('SELECT version,published_at,note,is_current FROM snapshots ORDER BY version DESC')
  if (!res.length) return []
  const cols = res[0].columns
  return res[0].values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])))
}

// ---------- 人工例外 ----------

export async function listExceptions() {
  const db = await getDb()
  const res = db.exec('SELECT * FROM exceptions ORDER BY id DESC')
  if (!res.length) return []
  const cols = res[0].columns
  return res[0].values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])))
}

export async function addException(input) {
  const db = await getDb()
  // content_key 由引擎折叠函数生成（NFKC/小写/去零宽），保证“看起来一样但
  // 夹了零宽/全角”的片段按同一规范比对
  const { normalizeKey } = await import('../src/shared/proofreader.js')
  const key = normalizeKey(input.fragment)
  const ts = nowMs()
  db.run(
    `INSERT INTO exceptions (rule_id,rule_rev,doc_id,fragment,content_key,snapshot_version,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [
      input.ruleId,
      input.ruleRev ?? 1,
      input.docId || '*',
      String(input.fragment),
      key,
      input.snapshotVersion ?? null,
      ts,
    ],
  )
  const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0]
  persist()
  return { id, ruleId: input.ruleId, ruleRev: input.ruleRev ?? 1, docId: input.docId || '*', fragment: String(input.fragment) }
}

export async function deleteException(id) {
  const db = await getDb()
  db.run('DELETE FROM exceptions WHERE id=?', [Number(id)])
  persist()
}

// ---------- 文稿与版本 ----------

export async function getOrCreateDocument(id) {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM documents WHERE id=?')
  stmt.bind([id])
  let row = null
  if (stmt.step()) row = stmt.getAsObject()
  stmt.free()
  if (!row) {
    const ts = nowMs()
    db.run(
      `INSERT INTO documents (id,title,latest_version,created_at,updated_at)
       VALUES (?,?,0,?,?)`,
      [id, id, ts, ts],
    )
    persist()
    return getOrCreateDocument(id)
  }
  return row
}

export async function saveDocumentVersion(docId, content, contentHash, ruleVersionAtCreate) {
  const db = await getDb()
  await getOrCreateDocument(docId)
  const res = db.exec('SELECT COALESCE(MAX(version),0)+1 v FROM document_versions WHERE doc_id=?')
  // sql.js 不绑定参数给 exec，用 prepare
  const stmt = db.prepare('SELECT COALESCE(MAX(version),0)+1 AS v FROM document_versions WHERE doc_id=?')
  stmt.bind([docId])
  stmt.step()
  const version = stmt.getAsObject().v
  stmt.free()
  void res
  db.run(
    `INSERT INTO document_versions (doc_id,version,content,content_hash,rule_version_at_create,created_at)
     VALUES (?,?,?,?,?,?)`,
    [docId, version, content, contentHash, ruleVersionAtCreate ?? null, nowMs()],
  )
  db.run('UPDATE documents SET latest_version=?, updated_at=? WHERE id=?', [version, nowMs(), docId])
  persist()
  return { docId, version, contentHash, ruleVersionAtCreate: ruleVersionAtCreate ?? null }
}

export async function getDocumentVersion(docId, version) {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM document_versions WHERE doc_id=? AND version=?')
  stmt.bind([docId, Number(version)])
  let row = null
  if (stmt.step()) row = stmt.getAsObject()
  stmt.free()
  return row
}

export async function markPublished(docId, ruleVersion, contentHash) {
  const db = await getDb()
  await getOrCreateDocument(docId)
  db.run(
    'UPDATE documents SET published_rule_version=?, published_content_hash=?, updated_at=? WHERE id=?',
    [ruleVersion, contentHash, nowMs(), docId],
  )
  persist()
}

export async function getDocument(docId) {
  const db = await getDb()
  const stmt = db.prepare('SELECT * FROM documents WHERE id=?')
  stmt.bind([docId])
  let row = null
  if (stmt.step()) row = stmt.getAsObject()
  stmt.free()
  return row
}

// 首次启动播种：若没有任何快照，写入演示规则并发布 v1，保证浏览器提示与
// 发布检查开箱即用以同一快照工作。
export async function seedIfEmpty() {
  const db = await getDb()
  const countRes = db.exec('SELECT COUNT(*) c FROM snapshots')
  if (countRes[0].values[0][0] > 0) return null
  const seeds = [
    { term: '成份', note: '推荐写法为“成分”', suggestions: ['成分'], scopes: ['title', 'body', 'code'], wholeWord: true, caseSensitive: false },
    { term: '账号', note: '平台规范用“帐号”', suggestions: ['帐号'], scopes: ['title', 'body'], wholeWord: true, caseSensitive: false },
    { term: 'TODO', note: '代码中遗留待办需处理', suggestions: ['FIXME 已登记', '已完成'], scopes: ['code'], wholeWord: true, caseSensitive: true },
    { term: '最佳', note: '绝对化用语慎用', suggestions: ['较好', '表现突出'], scopes: ['title', 'body'], wholeWord: true, caseSensitive: false },
  ]
  for (const s of seeds) await createRule(s)
  await createWordForm({ from: '成份', to: '成分', name: '异体词' })
  const published = await publishSnapshot('初始规则集')
  return published
}

