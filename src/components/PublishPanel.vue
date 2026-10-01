<script setup>
import { ref } from 'vue'

const props = defineProps({
  scheduler: Object,
  localRulesVersion: Number,
})
const emit = defineEmits(['refresh-snapshot'])

const checking = ref(false)
const result = ref(null)
const error = ref('')

const scopeLabel = { title: '标题', body: '正文', quote: '引用', code: '代码' }

async function check() {
  checking.value = true
  error.value = ''
  try {
    result.value = await props.scheduler.publishCheck()
  } catch (err) {
    error.value = err.message
  } finally {
    checking.value = false
  }
}

async function publishAnyway() {
  if (!confirm('仍有错误级问题，确认强行发布？')) return
  alert('已记录强行发布操作（演示环境）。生产环境应阻断并留痕。')
}
</script>

<template>
  <div class="publish-card">
    <h3>发布前检查</h3>
    <p class="muted">
      检查在服务器执行，与编辑页浏览器提示共用同一份规则快照与同一扫描内核，
      不会出现“浏览器没提示、发布却被拦”或反之。
    </p>
    <div class="publish-actions">
      <button type="button" class="primary-btn" :disabled="checking" @click="check">
        {{ checking ? '检查中…' : '执行发布检查' }}
      </button>
      <button type="button" class="ghost-btn" @click="emit('refresh-snapshot')">刷新规则快照并全量重扫</button>
    </div>
    <p v-if="error" class="error-text">{{ error }}</p>

    <div v-if="result" class="check-result">
      <div :class="['check-banner', result.passed ? 'ok' : 'block']">
        <template v-if="result.passed">
          ✅ 检查通过（规则快照 v{{ result.rulesVersion }}）：
          {{ result.warningCount }} 个警告{{ result.suppressedCount ? `，${result.suppressedCount} 处人工放行` : '' }}
        </template>
        <template v-else>
          ⛔ 未通过：{{ result.errorCount }} 个错误必须处理（规则快照 v{{ result.rulesVersion }}）
        </template>
      </div>

      <ul class="issue-list">
        <li v-for="h in result.errors" :key="h.hitId" class="issue issue--error">
          <div class="issue-line">
            <span class="sev">错误</span>
            <span class="loc">{{ h.line }}:{{ h.column }}</span>
            <span class="scopes">{{ h.scopes.map((s) => scopeLabel[s] || s).join('/') }}</span>
          </div>
          <div class="issue-msg">{{ h.message }}</div>
          <div class="issue-snippet">“{{ h.snippet }}”</div>
        </li>
        <li v-for="h in result.warnings" :key="h.hitId" class="issue issue--warn">
          <div class="issue-line">
            <span class="sev">警告</span>
            <span class="loc">{{ h.line }}:{{ h.column }}</span>
          </div>
          <div class="issue-msg">{{ h.message }}</div>
          <div class="issue-snippet">“{{ h.snippet }}”</div>
        </li>
        <li v-for="h in result.suppressed" :key="h.hitId" class="issue issue--ignored">
          <div class="issue-line"><span class="sev">人工放行</span><span class="loc">{{ h.line }}:{{ h.column }}</span></div>
          <div class="issue-snippet">“{{ h.snippet }}”</div>
        </li>
      </ul>

      <button v-if="!result.passed" type="button" class="ghost-btn danger" @click="publishAnyway">
        我已知晓，强行发布（留痕）
      </button>
    </div>
  </div>
</template>
