<script setup>
import { computed } from 'vue'

const props = defineProps({
  state: Object,
  scheduler: Object,
})
const emit = defineEmits(['locate', 'apply'])

// 必须经响应式 state 读取，computed 才能在版本归档更新后刷新。
const activeRecord = computed(() =>
  props.state.versions.find((v) => v.hash === props.state.activeHash),
)
const activeHits = computed(() => activeRecord.value?.hits || [])
const activeActive = computed(() => activeHits.value.filter((h) => !h.suppressed))
const activeSuppressed = computed(() => activeHits.value.filter((h) => h.suppressed))
const history = computed(() =>
  props.state.versions.filter((v) => v.hash !== props.state.activeHash),
)

const severityLabel = { error: '错误', warn: '警告' }
const scopeLabel = { title: '标题', body: '正文', quote: '引用', code: '代码' }

async function ignore(hit) {
  await props.scheduler.addException(hit)
}
</script>

<template>
  <div class="issues">
    <div class="issues-head">
      <h3>校对结果</h3>
      <span v-if="state.scanning" class="badge badge-progress">扫描中…</span>
      <span v-else-if="activeRecord" class="badge" :class="activeRecord.mode === 'full' ? 'badge-full' : 'badge-incr'">
        {{ activeRecord.mode === 'full' ? '全稿重扫' : '节点增量' }}
      </span>
    </div>
    <p v-if="state.lastError" class="error-text">扫描失败：{{ state.lastError }}</p>

    <template v-if="activeRecord">
      <p v-if="!activeActive.length && !activeSuppressed.length" class="muted">当前版本未发现问题。</p>

      <ul v-else class="issue-list">
        <li v-for="hit in activeActive" :key="hit.hitId" class="issue" :class="`issue--${hit.severity}`">
          <div class="issue-line">
            <span class="sev">{{ severityLabel[hit.severity] || hit.severity }}</span>
            <span class="loc">{{ hit.line }}:{{ hit.column }}</span>
            <span class="scopes">{{ hit.scopes.map((s) => scopeLabel[s] || s).join('/') }}</span>
          </div>
          <div class="issue-msg">{{ hit.message }}</div>
          <div class="issue-snippet">“{{ hit.snippet }}”</div>
          <div v-if="hit.suggestions && hit.suggestions.length" class="issue-suggestions">
            <span class="muted">替换建议（需手动选择，不会自动替换）：</span>
            <button
              v-for="sug in hit.suggestions"
              :key="sug"
              type="button"
              class="sug-btn"
              @click="emit('apply', { hit, suggestion: sug })"
            >
              {{ sug }}
            </button>
          </div>
          <div class="issue-actions">
            <button type="button" class="link-btn" @click="emit('locate', hit)">定位</button>
            <button type="button" class="link-btn" @click="ignore(hit)">
              仅忽略此处片段（绑定规则与上下文）
            </button>
          </div>
        </li>
      </ul>

      <details v-if="activeSuppressed.length" class="suppressed-box">
        <summary>已人工放行 {{ activeSuppressed.length }} 处（仍会在发布检查中列出）</summary>
        <ul class="issue-list">
          <li v-for="hit in activeSuppressed" :key="hit.hitId" class="issue issue--ignored">
            <div class="issue-line">
              <span class="sev">放行</span>
              <span class="loc">{{ hit.line }}:{{ hit.column }}</span>
            </div>
            <div class="issue-snippet">“{{ hit.snippet }}”</div>
          </li>
        </ul>
      </details>
    </template>
    <p v-else class="muted">等待首个版本的扫描结果…</p>

    <details v-if="history.length" class="history-box">
      <summary>历史版本结果（{{ history.length }}）— 仅展示，不叠加到当前文稿</summary>
      <div v-for="rec in [...history].reverse()" :key="rec.hash" class="history-record">
        <div class="history-meta">
          版本 {{ rec.hash.slice(0, 6) }} ·
          {{ rec.mode === 'full' ? '全稿' : '增量' }} ·
          规则快照 v{{ rec.rulesVersion }} ·
          {{ new Date(rec.at).toLocaleTimeString() }} ·
          {{ rec.hits.filter((h) => !h.suppressed).length }} 个问题
        </div>
        <ul class="issue-list">
          <li v-for="hit in rec.hits.filter((h) => !h.suppressed)" :key="hit.hitId" class="issue issue--old">
            <span class="sev">{{ severityLabel[hit.severity] || hit.severity }}</span>
            <span class="issue-snippet">“{{ hit.snippet }}”</span>
            <span class="muted">{{ hit.line }}:{{ hit.column }}</span>
          </li>
        </ul>
      </div>
    </details>
  </div>
</template>
