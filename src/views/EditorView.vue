<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useProofreader } from '../useProofreader.js'
import { api } from '../api.js'

const props = defineProps({
  initialText: { type: String, default: '' },
})

const pf = useProofreader(props.initialText)
const {
  source, docId, snapshot, snapshotError, scanMode,
  findings, status, lastModeReport, staleDropped, imeComposing,
  previewHtml, counts,
  onInput, beforeInput, onCompositionStart, onCompositionEnd,
  loadSnapshot, applySuggestion, addException, publishCheck, confirmPublish,
  rescan, currentHash,
} = pf

const selectedFindingId = ref(null)
const selectedFinding = computed(() => findings.value.find((f) => f.id === selectedFindingId.value) || findings.value[0] || null)
function selectFinding(id) {
  selectedFindingId.value = id
}

// ---- 发布检查弹窗（浏览器提示与服务器闸门同一规则快照） ----
const publishState = reactive({ open: false, loading: false, result: null, error: '' })

async function openPublish() {
  publishState.open = true
  publishState.loading = true
  publishState.error = ''
  publishState.result = null
  try {
    publishState.result = await publishCheck()
  } catch (err) {
    publishState.error = err.message
  } finally {
    publishState.loading = false
  }
}

async function doConfirm() {
  publishState.loading = true
  try {
    publishState.result = await confirmPublish(publishState.result)
  } catch (err) {
    publishState.error = err.message
  } finally {
    publishState.loading = false
  }
}

// ---- “仅此片段”例外 ----
const exceptionBusy = ref(false)
async function ignoreThis(f) {
  exceptionBusy.value = true
  try {
    await addException(f)
  } finally {
    exceptionBusy.value = false
  }
}

function chooseSuggestion(f, s) {
  // 替换建议必须用户点选，绝不自动替换
  const r = applySuggestion(f, s)
  if (r && r.ok === false) window.alert(r.reason)
}

const statusText = computed(() => {
  if (imeComposing.value) return '输入法合成中（未提交文本暂不校对）'
  if (status.value === 'scanning') return '校对中…'
  if (status.value === 'error') return '扫描出错'
  if (status.value === 'current') return `已校对 v${snapshot.value?.version ?? '-'} · 快照规则 ${findings.value.length} 处提示`
  return '空闲'
})

const lineCount = computed(() => source.value.split(/\r?\n/).length)

onMounted(() => loadSnapshot(true))
</script>

<template>
  <div class="editor-view">
    <div class="toolbar">
      <div class="toolbar-left">
        <label class="docid">文档 <code>{{ docId }}</code></label>
        <div class="mode-switch" role="group" aria-label="扫描模式">
          <button
            type="button"
            :class="{ active: scanMode === 'incremental' }"
            @click="pf.setScanMode('incremental')"
          >
            按节点增量
          </button>
          <button
            type="button"
            :class="{ active: scanMode === 'full' }"
            @click="pf.setScanMode('full')"
          >
            全稿重扫
          </button>
        </div>
        <button type="button" class="ghost-btn" @click="rescan">立即重扫</button>
      </div>
      <div class="toolbar-right">
        <span class="status-pill" :class="status">
          <span class="dot" />{{ statusText }}
        </span>
        <button type="button" class="primary-btn" @click="openPublish">发布检查…</button>
      </div>
    </div>

    <div v-if="snapshotError" class="banner error">规则快照加载失败：{{ snapshotError }}</div>

    <main class="workspace-3">
      <section class="panel editor-panel">
        <div class="panel-header">
          <h2>编辑区</h2>
          <span class="muted">{{ lineCount }} 行 · {{ source.length }} 字符 · hash {{ currentHash.slice(0, 8) }}</span>
        </div>
        <textarea
          v-model="source"
          class="editor"
          spellcheck="false"
          placeholder="在这里输入 Catalpa 内容；中文输入法合成期间不会校对…"
          @beforeinput="beforeInput"
          @input="onInput"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
        />
      </section>

      <section class="panel preview-panel">
        <div class="panel-header">
          <h2>预览区（高亮只来自当前文本 × 当前规则快照）</h2>
          <span v-if="lastModeReport" class="muted">
            <template v-if="lastModeReport.path === 'incremental'">
              增量 {{ lastModeReport.incMs }}ms / 全量 {{ lastModeReport.fullMs }}ms
              <b :class="lastModeReport.equal ? 'ok' : 'bad'">{{ lastModeReport.equal ? '一致' : '不一致!' }}</b>
            </template>
            <template v-else>{{ lastModeReport.path }}</template>
          </span>
        </div>
        <article class="preview markdown-body" v-html="previewHtml"></article>
      </section>

      <aside class="panel issues-panel">
        <div class="panel-header">
          <h2>校对提示</h2>
          <span class="muted">{{ findings.length }} 处</span>
        </div>
        <div v-if="findings.length === 0" class="empty">
          <template v-if="status === 'scanning'">扫描进行中，旧提示已随版本切换清空。</template>
          <template v-else>当前版本没有需要处理的命中。</template>
        </div>
        <ul class="issue-list">
          <li
            v-for="f in findings"
            :key="f.id"
            class="issue"
            :class="{ active: selectedFinding?.id === f.id }"
            @click="selectFinding(f.id)"
          >
            <div class="issue-top">
              <span class="badge" :class="f.scopes.includes('title') ? 'scope-title' : f.scopes.includes('code') ? 'scope-code' : 'scope-body'">
                {{ f.scopes.length === 3 ? '全部' : f.scopes.join('/') }}
              </span>
              <code class="matched">{{ f.coveredText || f.matchedText }}</code>
              <span class="muted pos">[{{ f.start }},{{ f.end }})</span>
            </div>
            <div class="issue-rule">规则 <code>{{ f.ruleId }}</code> rev{{ f.rev }} · 快照 v{{ f.ruleVersion }}</div>
            <div v-if="selectedFinding?.id === f.id" class="issue-detail">
              <div class="sugg-list">
                <button
                  v-for="s in f.suggestions"
                  :key="s"
                  type="button"
                  class="sugg"
                  @click.stop="chooseSuggestion(f, s)"
                >
                  替换为「{{ s }}」
                </button>
                <span v-if="!f.suggestions.length" class="muted">该规则未提供替换建议，请手动修改。</span>
              </div>
              <button type="button" class="link-btn" :disabled="exceptionBusy" @click.stop="ignoreThis(f)">
                添加例外：仅此片段（规则+片段+rev 绑定，非全局忽略）
              </button>
            </div>
          </li>
        </ul>
        <div class="panel-footer muted">
          过期结果被版本闸门丢弃 {{ staleDropped }} 次
        </div>
      </aside>
    </main>

    <!-- 发布检查弹窗 -->
    <div v-if="publishState.open" class="modal-mask" @click.self="publishState.open = false">
      <div class="modal">
        <h3>服务器发布检查</h3>
        <p class="muted">
          使用规则快照 <b>v{{ snapshot?.version }}</b>
          （浏览器即时提示也是同一快照）。替换建议必须由作者确认，例外只针对具体片段。
        </p>
        <div v-if="publishState.loading">检查中…</div>
        <div v-else-if="publishState.error" class="banner error">{{ publishState.error }}</div>
        <div v-else-if="publishState.result">
          <div :class="['banner', publishState.result.allowed ? 'ok' : 'block']">
            {{ publishState.result.hint }}
          </div>
          <ul v-if="publishState.result.blocking?.length" class="modal-findings">
            <li v-for="f in publishState.result.blocking" :key="f.ruleId + f.start + f.end">
              <code>{{ f.coveredText || f.matchedText }}</code>
              <span class="muted">规则 {{ f.ruleId }} rev{{ f.rev }}（{{ f.scopes.join('/') }}）</span>
            </li>
          </ul>
          <div class="modal-actions">
            <button type="button" class="ghost-btn" @click="publishState.open = false">关闭</button>
            <button
              v-if="publishState.result.allowed && !publishState.result.published"
              type="button"
              class="primary-btn"
              @click="doConfirm"
            >
              确认发布
            </button>
            <span v-else-if="publishState.result.published" class="ok">已发布：{{ publishState.result.published.contentHash }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

