# Catalpa 编辑、预览与规则校对

Vue 3 + Vite 前端与 Node（sql.js / SQLite）后端的**禁用词规则校对**系统：
管理页维护规则与发布不可变快照，编辑页在 Worker 中后台扫描文稿树，
服务器发布检查与浏览器提示共用同一规则快照与同一套扫描引擎。

## 功能一览

- **规则管理页**（`#/admin`）
  - 禁用词 / 模式、替换建议（多个，逗号分隔）、说明；
  - 栏目范围：**标题 / 正文 / 代码**可任意组合（代码含围栏块与行内代码）；
  - 整词（英文）、区分大小写；启用 / 停用 / **撤回** / 删除；
  - **词形映射**（异体/旧写法 → 规范写法，可全局或绑定规则）；
  - **人工例外**：绑定「规则 + 具体片段 + 规则 rev + 文档」，没有也不提供
    “全局忽略”；删除例外即恢复提示；
  - 发布为**不可变规则快照**；规则内容变化自动令该规则 `rev+1`。
- **编辑预览页**（`#/editor`）
  - 三栏：编辑器 / 预览（源码偏移驱动的高亮）/ 校对提示列表；
  - 扫描在 **Web Worker** 中执行，输入不阻塞；防抖调度 + 版本闸门；
  - **输入法（IME）合成期间不扫描**（未提交文本不提示），合成结束才扫；
  - **全稿重扫 / 按节点增量扫描**一键切换，并回传两者耗时与逐条一致性；
  - **替换建议必须用户点选**，绝不自动改写；支持跨语法标记的短语替换
    （保留 `**` 等标记，仅替换叶子文本片段）；
  - 每处提示可“添加例外：仅此片段”；
  - “发布检查…”弹窗走服务器闸门，与浏览器即时提示**同一快照版本**。
- **数据库（SQLite / sql.js，文件落盘 `data/proof.db`）**
  - `rules` / `rule_revisions`：规则草稿与每次发布的**规则版（rev）**；
  - `word_forms`：**词形映射**；
  - `exceptions`：**人工例外**（规则 + 片段 + rev + 文档 + content_key）；
  - `snapshots`：不可变规则快照（含规则、词形、例外）；
  - `documents` / `document_versions`：文稿版本与发布记录。

## 关键设计

### Unicode 规范化后位置仍映射回原始文本
`src/shared/unicode.js` 对每个原始码点独立做 NFKC（全角→半角、合字 `ﬀ`→`ff`
等）并小写，同时建立“折叠位置 ↔ 原始位置”双向映射；零宽字符
（U+200B / U+200C / U+200D / U+FEFF）在折叠时跳过。因此折叠后命中的区间
能精确定位回用户输入的原始片段——**不会因折叠前后长度变化而标错字**。

### 文稿树与栏目范围
`src/shared/parse.js` 把 Catalpa 解析为带源码偏移的块节点树；叶子片段带
`title / body / code` 之一的 scope，语法标记（`# > - ** ` 等）不属于任何片段，
永不被命中。

### 跨节点短语边界
片段折叠后首尾相接，块/项之间插入“分隔单元（换行）”：

- 含非 ASCII（CJK）的模式允许跨过换行/标记（中文词语跨行不断词）；
- 纯 ASCII 模式不得跨过任何片段边界或分隔，避免 `foo` + `bar` 误报 `foobar`；
- 英文整词边界以折叠流相邻字符判断（换行是边界而非词字符）。

### 人工例外不允许“一个全局忽略掩盖新版本”
例外按 `ruleId + NFKC(片段)` 精确匹配，并记录所绑定的 `ruleRev`。规则撤回后
重新启用、或内容修订导致 rev 提升时，旧例外命中
`suppressedReason = 'rule-revision-changed'`，不再静默新命中；用户须为新
版本重新决定。

### 全稿重扫 vs 按节点增量
- 全量：`scanTree(parseCatalpa(text), snapshot)`，简单可靠；
- 增量（`src/shared/incremental.js`）：节点按「顺序 + 内容签名」LCS 对齐，
  复用距离编辑区折叠长度大于“最长模式长度 K”的节点缓存，重算窗口向两侧扩 K，
  从而正确处理**跨节点短语边界**；快照版本变化时丢弃全部缓存、整稿重算。
- 不变式（测试保证）：增量结果与全量逐条一致（300 次随机编辑属性测试）。

### 不阻塞输入与“旧结果只展示在对应版本”
`ScanScheduler`（`src/shared/scheduler.js`）为每次输入分配单调 `docVersion`
与 `contentHash`；Worker 回包必须同时匹配文档版本、内容哈希、规则快照版本，
否则被丢弃（计数展示在面板底部）。IME 合成期间完全不调度。

### 同一规则快照
浏览器通过 `GET /api/snapshots/current` 拉取当前已发布快照并传给 Worker；
`POST /api/publish-check` 在服务器端用其当前快照扫描指定文稿版本。两端使用
同一份 `src/shared/proofreader.js` 与同一个快照号。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/rules` | 规则列表 / 新建 |
| PUT/DELETE | `/api/rules/:id` | 更新 / 删除 |
| POST | `/api/rules/:id/retract` | 撤回（停用） |
| GET/POST | `/api/word-forms` | 词形映射 |
| DELETE | `/api/word-forms/:id` | 删除词形 |
| GET/POST | `/api/exceptions` | 人工例外 |
| DELETE | `/api/exceptions/:id` | 删除例外 |
| GET | `/api/snapshots/current` | 当前快照（浏览器提示使用） |
| POST | `/api/snapshots/publish` | 发布新版本（rev 变更） |
| POST | `/api/scan` | 扫描（`mode: full/incremental`，可带 `change`/`baseline`） |
| POST | `/api/publish-check` | 发布闸门（与浏览器同快照） |
| POST/GET | `/api/documents/:id/versions[/...]` | 文稿版本 |

## 目录结构

```text
src/
  shared/            # 浏览器与服务器共用
    unicode.js       # NFKC 逐码点折叠 + 双向偏移映射 + 零宽处理
    parse.js         # Catalpa -> 文稿树（源码偏移 + scope）
    proofreader.js   # Aho-Corasick + 对齐匹配、例外、快照扫描引擎
    incremental.js   # 按节点增量扫描（LCS 对齐 + 折叠距离窗口）
    scheduler.js     # 防抖/版本闸门/IME（时钟可注入）
    render.js        # 文稿树渲染 + 源码偏移高亮
  workers/proofreader.worker.js
  useProofreader.js  # 编辑页控制层
  views/EditorView.vue, AdminView.vue
server/
  db.js              # sql.js SQLite：规则版/词形/例外/快照/文稿版本
  scan-service.js    # 扫描与发布检查编排
  index.js           # HTTP API + 静态托管
test/                # node:test（61 个用例）
```

## 运行

```bash
corepack prepare pnpm@latest --activate
pnpm install

pnpm dev     # Vite(3000) + API(3001) 并发，前端经代理访问 /api
pnpm build   # 产物到 dist/
pnpm start   # API 服务同时托管 dist/（生产单进程）
pnpm test    # node --test 全量测试
```

首次启动自动播种演示规则并发布快照 v1（成份/账号/最佳/TODO + 成份→成分词形）。
运行期数据库位于 `data/proof.db`（已被 git 忽略）。

## 测试覆盖（对应需求场景）

- 输入法未提交文本（合成中不扫描）、快速连续修改、旧结果版本隔离；
- 零宽字符、全角字符、合字展开的位置映射；
- 跨段（`禁用**短语**`）、跨物理行、跨块节点（列表→引用）命中；
- 规则撤回、规则修订 rev+1 后旧例外失效；同 rev 未修订时例外仍有效；
- 例外跨文档不串、不同规则互不掩盖、无全局忽略；
- 全量 vs 增量 300 次随机编辑逐条一致、规则变更后必要重算；
- 替换必须用户选择；发布检查与浏览器提示同一快照。
