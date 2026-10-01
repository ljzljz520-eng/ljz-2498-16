// 文件数据库（JSON 持久化，原子写入）。
// 保存三类数据：
//   rules / mappings 的草稿 + 不可变的规则版本快照（versions）
//   exceptions：人工例外，绑定规则与具体片段，绝不做全局忽略
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const DB_VERSION = 1

function seed() {
  const rules = [
    {
      id: 'r_ad_best',
      pattern: '最佳',
      matchType: 'literal',
      severity: 'error',
      message: '广告法极限词，请选择更稳妥的表述',
      suggestions: ['很出色', '表现优秀'],
      scopes: ['title', 'body', 'quote'],
      crossNode: true,
      enabled: true,
    },
    {
      id: 'r_typo_install',
      pattern: '按装',
      matchType: 'literal',
      severity: 'error',
      message: '疑似错别字：应为“安装”',
      suggestions: ['安装'],
      scopes: ['title', 'body', 'quote'],
      crossNode: true,
      enabled: true,
    },
    {
      id: 'r_code_fixme',
      pattern: 'FIXME',
      matchType: 'literal',
      severity: 'warn',
      message: '代码中存在待处理的 FIXME 标记',
      suggestions: ['TODO'],
      scopes: ['code'],
      crossNode: false,
      enabled: true,
    },
    {
      id: 'r_contact_cross',
      pattern: '联系客服',
      matchType: 'literal',
      severity: 'warn',
      message: '跨段短语演示：联系方式建议集中放置',
      suggestions: [],
      scopes: ['body'],
      crossNode: true,
      enabled: true,
    },
  ]
  const mappings = [
    // 繁体/异体词形 -> 规范词形（折叠后命中，原文位置仍精确映射回原始字符）
    { id: 'm_zhang', from: '帳', to: '账', note: '繁简：帳→账', enabled: true },
    { id: 'm_multi', from: '聯係', to: '联系', note: '多字词形映射', enabled: true },
  ]
  const v1 = {
    version: 1,
    publishedAt: new Date().toISOString(),
    note: '初始规则快照',
    snapshot: {
      rules: clone(rules).map((r) => ({ ...r, version: 1 })),
      mappings: clone(mappings).map((m) => ({ ...m, version: 1 })),
    },
  }
  return {
    dbVersion: DB_VERSION,
    rulesVersion: 1,
    mappingsVersion: 1,
    rules,
    mappings,
    versions: [v1],
    exceptions: [],
  }
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

export class JsonStore {
  constructor(file) {
    this.file = file
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true })
      this.data = seed()
      this.#save()
    } else {
      this.data = JSON.parse(readFileSync(file, 'utf8'))
      if (!this.data.versions?.length) {
        const fresh = seed()
        this.data = { ...fresh, exceptions: this.data.exceptions || [] }
        this.#save()
      }
    }
  }

  #save() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    // rename 在同一文件系统上是原子的，扫描请求不会读到半截 JSON
    renameSync(tmp, this.file)
  }

  getState() {
    return clone(this.data)
  }

  // 取“当前生效快照”——浏览器提示与发布检查都只能看到已发布版本。
  getActiveSnapshot() {
    const v = this.data.versions[this.data.versions.length - 1]
    return {
      version: v.version,
      publishedAt: v.publishedAt,
      note: v.note,
      rules: clone(v.snapshot.rules),
      mappings: clone(v.snapshot.mappings),
    }
  }

  listVersions() {
    return this.data.versions.map((v) => ({
      version: v.version,
      publishedAt: v.publishedAt,
      note: v.note,
      ruleCount: v.snapshot.rules.length,
      mappingCount: v.snapshot.mappings.length,
    }))
  }

  // ---- 规则草稿 CRUD ----
  saveRule(rule) {
    const now = new Date().toISOString()
    const idx = this.data.rules.findIndex((r) => r.id === rule.id)
    if (idx >= 0) {
      this.data.rules[idx] = { ...this.data.rules[idx], ...rule, updatedAt: now }
    } else {
      this.data.rules.push({ ...rule, createdAt: now, updatedAt: now })
    }
    this.#save()
    return clone(this.data.rules[idx >= 0 ? idx : this.data.rules.length - 1])
  }

  deleteRule(id) {
    this.data.rules = this.data.rules.filter((r) => r.id !== id)
    this.#save()
  }

  // ---- 词形映射草稿 CRUD ----
  saveMapping(mapping) {
    const now = new Date().toISOString()
    const idx = this.data.mappings.findIndex((m) => m.id === mapping.id)
    if (idx >= 0) {
      this.data.mappings[idx] = { ...this.data.mappings[idx], ...mapping, updatedAt: now }
    } else {
      this.data.mappings.push({ ...mapping, createdAt: now, updatedAt: now })
    }
    this.#save()
    return clone(this.data.mappings[idx >= 0 ? idx : this.data.mappings.length - 1])
  }

  deleteMapping(id) {
    this.data.mappings = this.data.mappings.filter((m) => m.id !== id)
    this.#save()
  }

  // 发布：把当前草稿固化为不可变新版本。规则撤回（禁用/删除）也必须通过发布生效。
  publish(note = '') {
    const nextVersion = this.data.versions[this.data.versions.length - 1].version + 1
    const version = {
      version: nextVersion,
      publishedAt: new Date().toISOString(),
      note: note || `发布第 ${nextVersion} 版规则`,
      snapshot: {
        rules: clone(this.data.rules).map((r) => ({ ...r, version: nextVersion })),
        mappings: clone(this.data.mappings).map((m) => ({ ...m, version: nextVersion })),
      },
    }
    this.data.versions.push(version)
    this.data.rulesVersion = nextVersion
    // 词形与规则共用一个规则快照版本，保证二者原子一致
    this.data.mappingsVersion = nextVersion
    this.#save()
    return this.getActiveSnapshot()
  }

  // ---- 人工例外 ----
  listExceptions(docId) {
    return clone(this.data.exceptions.filter((e) => (e.docId || 'default') === docId))
  }

  addException(ex) {
    // 绑定：规则 id + 规则版本 + 文稿 + 具体折叠片段 + 上下文。
    // 不提供“全局忽略”：片段或上下文改变后签名自然不再匹配。
    const exists = this.data.exceptions.some(
      (e) =>
        e.ruleId === ex.ruleId &&
        (e.docId || 'default') === (ex.docId || 'default') &&
        e.snippet === ex.snippet &&
        e.contextBefore === ex.contextBefore &&
        e.contextAfter === ex.contextAfter,
    )
    if (!exists) {
      const record = {
        id: `ex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        ruleId: ex.ruleId,
        ruleVersion: ex.ruleVersion ?? null,
        docId: ex.docId || 'default',
        snippet: ex.snippet,
        contextBefore: ex.contextBefore || '',
        contextAfter: ex.contextAfter || '',
        note: ex.note || '',
        createdAt: new Date().toISOString(),
      }
      this.data.exceptions.push(record)
      this.#save()
      return clone(record)
    }
    return clone(this.data.exceptions.find((e) =>
      e.ruleId === ex.ruleId &&
      (e.docId || 'default') === (ex.docId || 'default') &&
      e.snippet === ex.snippet &&
      e.contextBefore === ex.contextBefore &&
      e.contextAfter === ex.contextAfter))
  }

  deleteException(id) {
    this.data.exceptions = this.data.exceptions.filter((e) => e.id !== id)
    this.#save()
  }
}
