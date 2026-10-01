<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import EditorView from './views/EditorView.vue'
import AdminView from './views/AdminView.vue'

const initialDoc = `# Catalpa 成份报告

欢迎使用 **Catalpa 实时预览** 与规则校对。这里故意写了“成份”，
它会跨行命中成份短语（跨段命中测试）。

## 基础语法
- 支持标题、列表、引用
- 支持 *斜体* 与 **粗体**
- 支持 [链接](https://vuejs.org/)
- 正文里的“账号”也会被提示

> 引用中的“最佳”一词同样在正文范围内生效。

### 代码块（TODO 仅在代码范围提示）
\`\`\`js
// TODO: 把成份改成成分
const message = "Hello Catalpa"
console.log(message)
\`\`\`
`

const route = ref(location.hash || '#/editor')
function onHash() {
  route.value = location.hash || '#/editor'
}
onMounted(() => window.addEventListener('hashchange', onHash))
onBeforeUnmount(() => window.removeEventListener('hashchange', onHash))

const view = computed(() => (route.value.startsWith('#/admin') ? 'admin' : 'editor'))
const editorKey = computed(() => (route.value.startsWith('#/editor') ? 'editor' : 'other'))
</script>

<template>
  <div class="page">
    <header class="hero">
      <div>
        <p class="eyebrow">Vue 3 + Vite · 规则校对</p>
        <h1>Catalpa 编辑、预览与规则校对</h1>
        <p class="subtitle">
          禁用词/词形/例外由服务端规则快照统一驱动；浏览器 Worker 即时提示与服务器发布检查同快照。
        </p>
      </div>
      <nav class="nav">
        <a :class="{ active: view === 'editor' }" href="#/editor">编辑预览</a>
        <a :class="{ active: view === 'admin' }" href="#/admin">规则管理</a>
      </nav>
    </header>

    <EditorView v-if="view === 'editor'" :key="editorKey" :initial-text="initialDoc" />
    <AdminView v-else :key="'admin'" />
  </div>
</template>
