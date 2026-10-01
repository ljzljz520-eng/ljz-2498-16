<script setup>
import { onMounted, ref } from 'vue'
import { api } from '../shared/api'

const emit = defineEmits(['published'])

const rules = ref([])
const mappings = ref([])
const versions = ref([])
const activeVersion = ref(0)
const exceptions = ref([])
const saving = ref('')
const note = ref('')

const allScopes = [
  { value: 'title', label: '标题' },
  { value: 'body', label: '正文' },
  { value: 'quote', label: '引用' },
  { value: 'code', label: '代码' },
]

function emptyRule() {
  return {
    id: `r_${Date.now().toString(36)}`,
    pattern: '',
    matchType: 'literal',
    regexFlags: 'g',
    severity: 'warn',
    message: '',
    suggestionsText: '',
    scopes: ['title', 'body', 'quote'],
    crossNode: true,
    enabled: true,
    isNew: true,
  }
}
const editing = ref(emptyRule())

function editRule(rule) {
  editing.value = {
    ...rule,
    suggestionsText: (rule.suggestions || []).join(', '),
    isNew: false,
  }
}

function toggleScope(scope) {
  const list = editing.value.scopes
  const idx = list.indexOf(scope)
  if (idx >= 0) list.splice(idx, 1)
  else list.push(scope)
}

async function saveRule() {
  const r = editing.value
  if (!r.pattern.trim()) {
    alert('请填写禁用词/模式')
    return
  }
  saving.value = 'rule'
  await api.saveRule({
    id: r.id,
    pattern: r.pattern,
    matchType: r.matchType,
    regexFlags: r.regexFlags || 'g',
    severity: r.severity,
    message: r.message,
    suggestions: r.suggestionsText
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
    scopes: r.scopes,
    crossNode: r.crossNode,
    enabled: r.enabled,
  })
  editing.value = emptyRule()
  await load()
  saving.value = ''
}

async function toggleEnabled(rule) {
  await api.saveRule({ ...rule, enabled: !rule.enabled })
  await load()
}

async function removeRule(rule) {
  if (!confirm(`删除规则“${rule.pattern}”？删除需发布新版本后生效。`)) return
  await api.deleteRule(rule.id)
  await load()
}

// ---- 词形映射 ----
const mapForm = ref({ id: '', from: '', to: '', note: '', enabled: true })

async function saveMapping() {
  if (!mapForm.value.from || !mapForm.value.to) {
    alert('词形（from/to）均必填')
    return
  }
  saving.value = 'map'
  await api.saveMapping({
    id: mapForm.value.id || `m_${Date.now().toString(36)}`,
    from: mapForm.value.from,
    to: mapForm.value.to,
    note: mapForm.value.note,
    enabled: mapForm.value.enabled,
  })
  mapForm.value = { id: '', from: '', to: '', note: '', enabled: true }
  await load()
  saving.value = ''
}

async function toggleMapping(m) {
  await api.saveMapping({ ...m, enabled: !m.enabled })
  await load()
}
async function removeMapping(m) {
  await api.deleteMapping(m.id)
  await load()
}

// ---- 发布不可变版本（撤回规则也必须发布） ----
const publishing = ref(false)
async function publish() {
  publishing.value = true
  const { snapshot } = await api.publish(note.value)
  note.value = ''
  await load()
  publishing.value = false
  emit('published', snapshot)
}

// ---- 例外 ----
async function removeException(id) {
  await api.deleteException(id)
  await load()
  emit('published')
}

async function load() {
  const state = await api.getState()
  rules.value = state.rules
  mappings.value = state.mappings
  versions.value = [...state.versions].reverse()
  activeVersion.value = state.activeVersion
  const ex = await api.listExceptions('doc-main')
  exceptions.value = ex.exceptions
}

onMounted(load)
defineExpose({ load })
</script>

<template>
  <div class="admin">
    <section class="card">
      <h3>禁用词规则（草稿）</h3>
      <p class="muted">
        维护禁用词、替换建议与栏目适用范围。改动仅为草稿，<b>发布新版本</b>后才会用于扫描；
        发布后旧版本快照不可变，撤回规则同样需要发布。
      </p>

      <table class="grid">
        <thead>
          <tr>
            <th>模式</th><th>级别</th><th>范围</th><th>建议</th><th>状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rules" :key="r.id">
            <td><code>{{ r.pattern }}</code><span v-if="r.matchType === 'regex'" class="tag">正则</span></td>
            <td>{{ r.severity === 'error' ? '错误（阻断发布）' : '警告' }}</td>
            <td>{{ r.scopes.map((s) => ({ title: '标题', body: '正文', quote: '引用', code: '代码' }[s])).join('/') }}</td>
            <td>{{ (r.suggestions || []).join('、') || '—' }}</td>
            <td>{{ r.enabled ? '启用' : '已撤回（待发布）' }}</td>
            <td class="row-actions">
              <button type="button" class="link-btn" @click="editRule(r)">编辑</button>
              <button type="button" class="link-btn" @click="toggleEnabled(r)">{{ r.enabled ? '撤回' : '重新启用' }}</button>
              <button type="button" class="link-btn danger-text" @click="removeRule(r)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="rule-form">
        <h4>{{ editing.isNew ? '新增规则' : `编辑：${editing.pattern}` }}</h4>
        <div class="form-row">
          <label>匹配方式
            <select v-model="editing.matchType">
              <option value="literal">字面（禁用词）</option>
              <option value="regex">正则（折叠后匹配）</option>
            </select>
          </label>
          <label>级别
            <select v-model="editing.severity">
              <option value="warn">警告</option>
              <option value="error">错误（阻断发布）</option>
            </select>
          </label>
          <label v-if="editing.matchType === 'regex'">正则标志
            <input v-model="editing.regexFlags" />
          </label>
          <label class="grow">模式
            <input v-model="editing.pattern" placeholder="如：最佳 / 联[系係]客服" />
          </label>
        </div>
        <div class="form-row">
          <label class="grow">提示信息
            <input v-model="editing.message" placeholder="命中后展示给作者的说明" />
          </label>
        </div>
        <div class="form-row">
          <label class="grow">替换建议（逗号分隔，仅作建议，由作者选择）
            <input v-model="editing.suggestionsText" placeholder="如：很出色, 表现优秀" />
          </label>
        </div>
        <div class="form-row">
          <fieldset class="scope-box">
            <legend>栏目适用范围</legend>
            <label v-for="s in allScopes" :key="s.value">
              <input type="checkbox" :checked="editing.scopes.includes(s.value)" @change="toggleScope(s.value)" />
              {{ s.label }}
            </label>
          </fieldset>
          <label>
            <input type="checkbox" v-model="editing.crossNode" />
            允许跨节点短语
          </label>
          <label>
            <input type="checkbox" v-model="editing.enabled" />
            启用
          </label>
        </div>
        <div class="form-row end">
          <button type="button" class="primary-btn" :disabled="saving === 'rule'" @click="saveRule">保存草稿</button>
        </div>
      </div>
    </section>

    <section class="card">
      <h3>词形映射（Unicode 折叠）</h3>
      <p class="muted">
        命中前会先做 Unicode NFKC 规范化并套用这里的映射；命中位置始终映射回原始文本，
        长度变化（零宽字符、组合字符、多字映射）不会造成错位。
      </p>
      <table class="grid">
        <thead><tr><th>原词形</th><th>规范词形</th><th>备注</th><th>状态</th><th></th></tr></thead>
        <tbody>
          <tr v-for="m in mappings" :key="m.id">
            <td><code>{{ m.from }}</code></td>
            <td><code>{{ m.to }}</code></td>
            <td>{{ m.note }}</td>
            <td>{{ m.enabled ? '启用' : '停用' }}</td>
            <td class="row-actions">
              <button type="button" class="link-btn" @click="toggleMapping(m)">{{ m.enabled ? '停用' : '启用' }}</button>
              <button type="button" class="link-btn danger-text" @click="removeMapping(m)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="form-row">
        <input v-model="mapForm.from" placeholder="原词形，如 帳 / 聯係" />
        <input v-model="mapForm.to" placeholder="规范词形，如 账 / 联系" />
        <input class="grow" v-model="mapForm.note" placeholder="备注" />
        <button type="button" class="primary-btn" :disabled="saving === 'map'" @click="saveMapping">保存映射</button>
      </div>
    </section>

    <section class="card">
      <h3>规则版本</h3>
      <p class="muted">
        当前生效：<b>v{{ activeVersion }}</b>。浏览器提示与服务器发布检查使用同一版本快照。
      </p>
      <ul class="version-list">
        <li v-for="v in versions" :key="v.version" :class="{ current: v.version === activeVersion }">
          <b>v{{ v.version }}</b> · {{ new Date(v.publishedAt).toLocaleString() }} ·
          {{ v.ruleCount }} 规则 / {{ v.mappingCount }} 映射
          <span class="muted">{{ v.note }}</span>
        </li>
      </ul>
      <div class="form-row">
        <input class="grow" v-model="note" placeholder="版本说明（可选），如：撤回首页极限词规则" />
        <button type="button" class="primary-btn" :disabled="publishing" @click="publish">
          {{ publishing ? '发布中…' : '发布新版本并应用' }}
        </button>
      </div>
    </section>

    <section class="card">
      <h3>人工例外（{{ exceptions.length }}）</h3>
      <p class="muted">
        例外绑定<b>具体规则 + 折叠片段 + 上下文</b>，只压制这一处；
        片段在新版本中变化（含规则撤回后重写）会生成新签名，旧例外无法掩盖。
      </p>
      <table class="grid" v-if="exceptions.length">
        <thead><tr><th>规则</th><th>片段</th><th>规则版本</th><th>备注</th><th></th></tr></thead>
        <tbody>
          <tr v-for="ex in exceptions" :key="ex.id">
            <td><code>{{ ex.ruleId }}</code></td>
            <td>
              <code>{{ ex.contextBefore }}<b>{{ ex.snippet }}</b>{{ ex.contextAfter }}</code>
            </td>
            <td>v{{ ex.ruleVersion ?? '?' }}</td>
            <td>{{ ex.note }}</td>
            <td><button type="button" class="link-btn danger-text" @click="removeException(ex.id)">撤销例外</button></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">暂无例外。</p>
    </section>
  </div>
</template>
