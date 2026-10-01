<script setup>
import { computed, ref, nextTick, onMounted } from 'vue'
import { renderCatalpa } from './core/parser.js'
import { api } from './shared/api'
import { useProofreading } from './composables/useProofreading'
import IssuePanel from './components/IssuePanel.vue'
import RuleAdmin from './components/RuleAdmin.vue'
import PublishPanel from './components/PublishPanel.vue'

const initialDoc = `# 最佳 Catalpa 编辑器

欢迎使用 **Catalpa 实时预览**。请在输入时留意校对高亮。

## 基础语法
- 支持标题、列表、引用
- 如需帮助请联系
  客服处理
- 安装步骤：请按装依赖后启动

> 这是一段引用，里面也可能出现最佳等极限词。

### 代码块（独立栏目范围）
\`\`\`js
// FIXME: 代码中的标记只受“代码”范围规则约束
const message = "Hello Catalpa"
console.log(message)
\`\`\`

更多信息请访问 [Vue 官网](https://vuejs.org/)。
`

const source = ref(initialDoc)
const tab = ref('edit')
const textareaRef = ref(null)
const ruleAdminRef = ref(null)

const { scheduler, state } = useProofreading(api)

// 当前文本版本的命中（经响应式 state 读取，扫描归档后自动刷新）。
const currentHits = computed(
  () => state.versions.find((v) => v.hash === state.activeHash)?.hits || [],
)

const previewHtml = computed(() => {
  // 只使用“当前文本版本”的命中做高亮，避免旧结果叠加到新文本。
  return renderCatalpa(source.value, currentHits.value)
})

const lineCount = computed(() => source.value.split(/\r?\n/).length)
const charCount = computed(() => source.value.length)
const activeIssueCount = computed(
  () => currentHits.value.filter((h) => !h.suppressed).length,
)

function onInput() {
  // v-model 已更新 source；输入法组字期间调度器内部会跳过扫描。
  scheduler.setSource(source.value)
}

function resetToDemo() {
  source.value = initialDoc
  scheduler.setSource(source.value)
}
function clearAll() {
  source.value = ''
  scheduler.setSource(source.value)
}

function locate(hit) {
  const ta = textareaRef.value
  if (!ta) return
  tab.value = 'edit'
  nextTick(() => {
    ta.focus()
    ta.setSelectionRange(hit.start, hit.end)
    // 粗略滚动到命中行
    const before = source.value.slice(0, hit.start)
    const line = before.split('\n').length
    ta.scrollTop = (line - 3) * 22
  })
}

// 替换建议：必须作者点击后才替换，绝不自动改写。
function applySuggestion({ hit, suggestion }) {
  source.value =
    source.value.slice(0, hit.start) + suggestion + source.value.slice(hit.end)
  scheduler.setSource(source.value)
}

async function onPublished() {
  await scheduler.refreshSnapshot()
  state.snapshotStale = false
}

async function refreshSnapshot() {
  await scheduler.refreshSnapshot()
  await ruleAdminRef.value?.load()
}

onMounted(async () => {
  await scheduler.init()
  scheduler.setSource(source.value)
})
</script>

<template>
  <div class="page">
    <header class="hero">
      <div>
        <p class="eyebrow">Vue 3 + Vite · 规则校对</p>
        <h1>Catalpa 编辑、预览与规则校对</h1>
        <p class="subtitle">禁用词 / 错别字扫描、栏目范围、词形映射与片段级人工例外。</p>
      </div>
      <div class="stats">
        <span>{{ lineCount }} 行</span>
        <span>{{ charCount }} 字符</span>
        <span class="badge" :class="activeIssueCount ? 'badge-issue' : 'badge-clean'">
          当前版本 {{ activeIssueCount }} 个问题
        </span>
        <span v-if="state.rulesVersion != null" class="badge" :class="state.snapshotStale ? 'badge-stale' : 'badge-clean'">
          规则快照 v{{ state.rulesVersion }}<template v-if="state.serverRulesVersion != null"> / 服务器 v{{ state.serverRulesVersion }}</template>
          <template v-if="state.snapshotStale">（已发布新版本，待重扫）</template>
        </span>
      </div>
    </header>

    <nav class="tabs">
      <button type="button" :class="{ active: tab === 'edit' }" @click="tab = 'edit'">编辑预览</button>
      <button type="button" :class="{ active: tab === 'admin' }" @click="tab = 'admin'">规则管理</button>
      <button type="button" :class="{ active: tab === 'publish' }" @click="tab = 'publish'">发布检查</button>
    </nav>

    <main v-show="tab === 'edit'" class="workspace">
      <section class="panel editor-panel">
        <div class="panel-header">
          <h2>编辑区</h2>
          <div class="actions">
            <span v-if="state.scanning" class="muted">后台扫描中，输入不被阻塞…</span>
            <button class="ghost-btn" type="button" @click="resetToDemo">恢复示例</button>
            <button class="ghost-btn danger" type="button" @click="clearAll">清空</button>
          </div>
        </div>
        <textarea
          ref="textareaRef"
          v-model="source"
          class="editor"
          placeholder="在这里输入 Catalpa 内容（输入法组词期间不会触发扫描）..."
          spellcheck="false"
          @input="onInput"
          @compositionstart="scheduler.compositionStart()"
          @compositionend="scheduler.compositionEnd()"
        />
      </section>

      <section class="panel preview-panel">
        <div class="panel-header">
          <h2>预览区（命中仅属于当前版本）</h2>
        </div>
        <article class="preview markdown-body" v-html="previewHtml"></article>
      </section>

      <aside class="panel issues-panel">
        <IssuePanel :state="state" :scheduler="scheduler" @locate="locate" @apply="applySuggestion" />
      </aside>
    </main>

    <main v-show="tab === 'admin'">
      <RuleAdmin ref="ruleAdminRef" @published="onPublished" />
    </main>

    <main v-show="tab === 'publish'" class="publish-wrap">
      <PublishPanel
        :scheduler="scheduler"
        :local-rules-version="state.rulesVersion"
        @refresh-snapshot="refreshSnapshot"
      />
    </main>
  </div>
</template>
