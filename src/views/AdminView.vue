<script setup>
// 规则管理页：维护禁用词、替换建议、栏目范围（标题/正文/代码），词形映射，
// 人工例外；所有改动先作为草稿，“发布新版本快照”后浏览器提示与发布检查同时
// 生效。规则内容变化会令该规则 rev +1，已绑定旧 rev 的例外不再掩盖新命中。
import { onMounted, reactive, ref } from 'vue'
import { api } from '../api.js'

const ALL_SCOPES = ['title', 'body', 'code']
const SCOPE_LABEL = { title: '标题', body: '正文', code: '代码' }

const rules = ref([])
const wordForms = ref([])
const exceptions = ref([])
const snapshots = ref([])
const loading = ref(false)
const error = ref('')
const notice = ref('')

const draft = reactive({
  id: null,
  term: '',
  note: '',
  suggestionsText: '',
  scopes: [...ALL_SCOPES],
  wholeWord: true,
  caseSensitive: false,
  enabled: true,
})
const editing = ref(false)

const wfDraft = reactive({ from: '', to: '', name: '', ruleId: '' })

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    const [r, w, e, s] = await Promise.all([
      api.listRules(),
      api.listWordForms(),
      api.listExceptions(),
      api.listSnapshots(),
    ])
    rules.value = r.rules
    wordForms.value = w.wordForms
    exceptions.value = e.exceptions
    snapshots.value = s.snapshots
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

function resetDraft() {
  draft.id = null
  draft.term = ''
  draft.note = ''
  draft.suggestionsText = ''
  draft.scopes = [...ALL_SCOPES]
  draft.wholeWord = true
  draft.caseSensitive = false
  draft.enabled = true
  editing.value = false
}

function editRule(rule) {
  editing.value = true
  draft.id = rule.id
  draft.term = rule.term
  draft.note = rule.note
  draft.suggestionsText = rule.suggestions.join(', ')
  draft.scopes = [...rule.scopes]
  draft.wholeWord = rule.wholeWord
  draft.caseSensitive = rule.caseSensitive
  draft.enabled = rule.enabled
}

function toggleScope(scope) {
  const i = draft.scopes.indexOf(scope)
  if (i >= 0) draft.scopes.splice(i, 1)
  else draft.scopes.push(scope)
}

async function submitRule() {
  if (!draft.term.trim()) {
    error.value = '禁用词不能为空'
    return
  }
  const payload = {
    term: draft.term.trim(),
    note: draft.note,
    suggestions: draft.suggestionsText.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean),
    scopes: draft.scopes,
    wholeWord: draft.wholeWord,
    caseSensitive: draft.caseSensitive,
    enabled: draft.enabled,
  }
  try {
    if (draft.id) await api.updateRule(draft.id, payload)
    else await api.createRule(payload)
    notice.value = draft.id ? '规则已更新（草稿，发布后生效并分配 rev）' : '规则已创建（草稿）'
    resetDraft()
    await loadAll()
  } catch (err) {
    error.value = err.message
  }
}

async function retract(rule) {
  if (!window.confirm(`撤回规则「${rule.term}」？撤回后新快照不再产生命中；重新启用并修改会提升 rev。`)) return
  await api.retractRule(rule.id)
  await loadAll()
}
async function remove(rule) {
  if (!window.confirm(`彻底删除规则「${rule.term}」？历史快照仍保留该规则记录。`)) return
  await api.deleteRule(rule.id)
  await loadAll()
}

async function addWordForm() {
  if (!wfDraft.from.trim() || !wfDraft.to.trim()) {
    error.value = '词形的“原始形态”和“规范形态”都必填'
    return
  }
  await api.createWordForm({
    from: wfDraft.from.trim(),
    to: wfDraft.to.trim(),
    name: wfDraft.name,
    ruleId: wfDraft.ruleId || null,
  })
  wfDraft.from = wfDraft.to = wfDraft.name = wfDraft.ruleId = ''
  await loadAll()
}

async function removeWordForm(id) {
  await api.deleteWordForm(id)
  await loadAll()
}

async function removeException(id) {
  await api.deleteException(id)
  await loadAll()
}

const publishing = ref(false)
const publishNote = ref('')
async function publish() {
  publishing.value = true
  error.value = ''
  try {
    const result = await api.publishSnapshot(publishNote.value || '管理页发布')
    const changed = result.revChanges.map((c) => `${c.ruleId}→rev${c.rev}`).join('，')
    notice.value = `已发布快照 v${result.version}${changed ? `；规则修订：${changed}` : '；规则内容无变化，rev 不变'}`
    publishNote.value = ''
    await loadAll()
  } catch (err) {
    error.value = err.message
  } finally {
    publishing.value = false
  }
}

onMounted(loadAll)
</script>

<template>
  <div class="admin-view">
    <div class="admin-head">
      <div>
        <h2>规则管理</h2>
        <p class="muted">
          维护禁用词、替换建议与栏目范围；草稿发布为不可变快照后，浏览器提示与服务器发布检查同时生效。
        </p>
      </div>
      <div class="publish-box">
        <input v-model="publishNote" placeholder="版本说明（可选）" />
        <button type="button" class="primary-btn" :disabled="publishing" @click="publish">
          {{ publishing ? '发布中…' : '发布新版本快照' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="banner error">{{ error }}</div>
    <div v-if="notice" class="banner ok">{{ notice }}</div>

    <section class="card">
      <h3>{{ editing ? '编辑规则' : '新建规则' }}</h3>
      <div class="form-grid">
        <label>禁用词 / 模式
          <input v-model="draft.term" placeholder="如：成份 / TODO" />
        </label>
        <label>说明
          <input v-model="draft.note" placeholder="命中原因（可选）" />
        </label>
        <label class="wide">替换建议（逗号或换行分隔，需用户点选才会应用）
          <textarea v-model="draft.suggestionsText" rows="2" placeholder="成分, 化学成分"></textarea>
        </label>
        <fieldset class="wide">
          <legend>栏目适用范围</legend>
          <label v-for="s in ALL_SCOPES" :key="s" class="check">
            <input type="checkbox" :checked="draft.scopes.includes(s)" @change="toggleScope(s)" />
            {{ SCOPE_LABEL[s] }}
          </label>
        </fieldset>
        <label class="check">
          <input type="checkbox" v-model="draft.wholeWord" /> 英文整词匹配（CJK 自动支持子词）
        </label>
        <label class="check">
          <input type="checkbox" v-model="draft.caseSensitive" /> 区分大小写
        </label>
        <label class="check">
          <input type="checkbox" v-model="draft.enabled" /> 启用（取消勾选可作为停用草稿保留）
        </label>
      </div>
      <div class="form-actions">
        <button type="button" class="primary-btn" @click="submitRule">{{ editing ? '保存修改' : '添加规则' }}</button>
        <button v-if="editing" type="button" class="ghost-btn" @click="resetDraft">取消编辑</button>
      </div>
    </section>

    <section class="card">
      <h3>规则列表（{{ rules.length }}）</h3>
      <table class="grid">
        <thead>
          <tr>
            <th>禁用词</th><th>范围</th><th>替换建议</th><th>选项</th><th>状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rules" :key="r.id" :class="{ disabled: !r.enabled }">
            <td><b>{{ r.term }}</b><div class="muted">{{ r.note }}<br /><code>{{ r.id }}</code></div></td>
            <td>{{ r.scopes.map((s) => SCOPE_LABEL[s]).join('、') }}</td>
            <td>{{ r.suggestions.join(' / ') || '—' }}</td>
            <td class="muted">{{ r.wholeWord ? '整词' : '子词' }} · {{ r.caseSensitive ? '区分大小写' : '不区分' }}</td>
            <td>
              <span :class="['tag', r.enabled ? 'tag-on' : 'tag-off']">{{ r.enabled ? '启用' : '停用/撤回' }}</span>
            </td>
            <td class="ops">
              <button type="button" class="link-btn" @click="editRule(r)">编辑</button>
              <button type="button" class="link-btn warn" @click="retract(r)">撤回</button>
              <button type="button" class="link-btn danger" @click="remove(r)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="card">
      <h3>词形映射（异体/旧写法 → 规范写法，参与命中展开）</h3>
      <div class="wf-form">
        <input v-model="wfDraft.from" placeholder="原始形态，如 成份" />
        <span>→</span>
        <input v-model="wfDraft.to" placeholder="规范形态，如 成分" />
        <input v-model="wfDraft.name" placeholder="备注（可选）" />
        <select v-model="wfDraft.ruleId">
          <option value="">全局词形（所有规则可用）</option>
          <option v-for="r in rules" :key="r.id" :value="r.id">绑定：{{ r.term }}（{{ r.id }}）</option>
        </select>
        <button type="button" class="primary-btn" @click="addWordForm">添加映射</button>
      </div>
      <table class="grid">
        <thead><tr><th>原始形态</th><th>规范形态</th><th>备注</th><th>绑定规则</th><th></th></tr></thead>
        <tbody>
          <tr v-for="w in wordForms" :key="w.id">
            <td>{{ w.from_form }}</td><td>{{ w.to_form }}</td><td>{{ w.name || '—' }}</td>
            <td>{{ w.rule_id ? (w.rule_term || w.rule_id) : '全局' }}</td>
            <td><button type="button" class="link-btn danger" @click="removeWordForm(w.id)">删除</button></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="card">
      <h3>人工例外（{{ exceptions.length }}）—— 只绑定规则与具体片段，无全局忽略</h3>
      <p class="muted">
        例外记录规则 rev。若规则撤回后重新启用或内容修订导致 rev 变化，该例外自动失效，
        不能用一个旧的“忽略”掩盖新版本命中。
      </p>
      <table class="grid">
        <thead><tr><th>片段</th><th>规则</th><th>rev</th><th>文档</th><th>快照</th><th></th></tr></thead>
        <tbody>
          <tr v-for="e in exceptions" :key="e.id">
            <td><code>{{ e.fragment }}</code><div class="muted">{{ e.content_key }}</div></td>
            <td>{{ e.rule_id }}</td>
            <td>{{ e.rule_rev }}</td>
            <td>{{ e.doc_id }}</td>
            <td>v{{ e.snapshot_version ?? '—' }}</td>
            <td><button type="button" class="link-btn danger" @click="removeException(e.id)">删除例外</button></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="card">
      <h3>已发布快照</h3>
      <ul class="snap-list">
        <li v-for="s in snapshots" :key="s.version" :class="{ current: s.is_current }">
          <b>v{{ s.version }}</b>
          <span class="muted">{{ new Date(s.published_at).toLocaleString() }} · {{ s.note }}</span>
          <span v-if="s.is_current" class="tag tag-on">当前（浏览器与发布检查使用）</span>
        </li>
      </ul>
    </section>
  </div>
</template>

