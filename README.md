# Catalpa 编辑、预览与规则校对

基于 `Vue 3 + Vite` 的 Catalpa 文本编辑/实时预览工具，内置一套**前后端同构的规则校对系统**：
禁用词/错别字扫描、栏目适用范围、Unicode 词形映射、片段级人工例外、增量扫描与发布检查。

## 功能

### 编辑与预览
- Catalpa 文本实时编辑与预览（标题、列表、引用、分割线、粗体、斜体、链接、代码块）
- 校对命中直接在预览中高亮，错误（红）/ 警告（黄）/ 人工放行（虚线）三种样式
- 行数、字符数统计

### 规则校对（核心）
- **管理页**维护禁用词、提示信息、替换建议（逗号分隔）与栏目适用范围（标题/正文/引用/代码可分别勾选）
- **数据库**保存规则草稿、不可变的规则版本快照、词形映射与人工例外（JSON 文件库，原子写入）
- **扫描 API 处理文稿树**：把文稿解析成带原始源码偏移的块/行/片段树后再扫描
- **Unicode 规范化后位置映射回原文**：扫描在 NFKC + 自定义词形折叠后的文本上进行，
  每个折叠字符都记录其在原文中覆盖的 `[start,end)`；零宽字符删除、兼容字符扩展/收缩、
  多字词形替换都不会因长度变化而标错字
- **跨节点短语**：节点边界是折叠流中的零宽间隙，可命中跨行、跨段、跨行内标记的短语；
  水平分割线、以及增量子流中不相邻窗口的拼接处放置屏障，防止假命中
- **人工例外绑定规则与具体片段**：签名 = `规则 + 折叠片段 + 两侧上下文 + 文稿`，
  只压制这一处，不存在“一个全局忽略掩盖新版本”；片段或上下文变化，旧例外即失效
- **全稿重扫 vs 按节点增量扫描**：
  - 节点以 `(类型, 内容哈希)` 为身份，LCS 对齐新旧节点序列复用稳定 id
  - 脏节点按“最长规则模式折叠长度”向两侧扩张重算窗口，保证跨节点短语边界正确
  - 命中带**节点相对锚点**，节点插入/删除后在新树重新定位，绝对偏移不会漂移
  - 规则版本 / 词形版本 / 例外集合变化时自动回退全量重算（规则撤回同样必须发布新版本）
- **输入不被扫描阻塞**：扫描异步、可取消、防抖；输入法（IME）组字期间及组字开始前
  已排定的定时器都不会发起请求，`compositionend` 后才扫描未提交文本
- **旧结果只展示在对应版本**：结果按来源文本哈希归档，只有当前文本版本参与高亮，
  历史版本结果单独列出、绝不叠加到新文本；快速连续修改用单调序号 + AbortController 丢弃过期响应
- **替换建议需用户选择**：只提供按钮，作者点击后才替换，绝不自动改写
- **服务器发布检查与浏览器提示使用同一规则快照与同一扫描内核**：
  `/api/scan` 与 `/api/publish-check` 共用同一份已发布快照；错误级问题阻断发布，
  人工放行项仍会在发布检查中列出留痕。规则草稿仅在“发布新版本”后生效，历史快照不可变。

## 目录结构
```text
src/
  core/
    hash.js          # 稳定哈希（节点/命中/签名标识）
    fold.js          # Unicode NFKC + 词形映射折叠流，逐字符来源区间、屏障
    parser.js        # 带原始偏移与栏目范围的文稿树解析、命中高亮渲染
    scanner.js       # 扫描内核：范围过滤、跨节点短语、例外签名、节点锚点
    incremental.js   # LCS 节点对齐、脏窗口扩张、锚点重定位、合并、全量判定
  composables/
    useProofreading.js  # 扫描调度器（防抖/版本归档/IME/取消/快照刷新）
  components/
    IssuePanel.vue   # 当前版本命中、替换建议、片段例外、历史版本
    RuleAdmin.vue    # 规则/建议/范围、词形映射、发布版本、例外管理
    PublishPanel.vue # 服务器发布检查
  shared/api.js      # API 客户端
server/
  http.js            # 零依赖 HTTP：API + 生产静态托管
  scan-service.js    # 全量/增量扫描、发布检查（与浏览器同内核同快照）
  store.js           # JSON 文件库：规则、versions、mappings、exceptions
scripts/dev.mjs      # 并行启动 API 与 Vite
test/                # node:test 单测（折叠/扫描/增量/调度器/API 端到端）
```

## 运行

### 开发（API + Vite）
```bash
corepack prepare pnpm@latest --activate
pnpm install
pnpm dev
```
- 编辑/预览：http://localhost:3000 （`/api` 代理到 8787）
- 校对 API：http://localhost:8787

### 生产构建并由同一服务托管（发布检查与页面同源）
```bash
pnpm build
pnpm start            # = node server/http.js，默认 8787，PORT 可改
```

### 测试
```bash
pnpm test             # 41 项：零宽字符/NFKC/词形映射、栏目范围、跨段命中、
                      # 规则撤回、片段例外、增量锚点、IME 未提交文本、HTTP 端到端等
```

首次启动会在 `server/data/db.json` 生成种子规则（极限词、错别字、代码 FIXME、跨段联系方式）
与词形映射示例；该目录已在 `.gitignore` 中忽略。

## API 摘要
| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /api/state` | 规则/映射草稿、全部版本、当前生效快照 |
| `POST /api/rules` · `DELETE /api/rules/:id` | 规则草稿增改 / 删除（发布后生效） |
| `POST /api/mappings` · `DELETE /api/mappings/:id` | 词形映射草稿 |
| `POST /api/publish` | 固化草稿为不可变新版本 |
| `GET/POST /api/exceptions` · `DELETE /api/exceptions/:id` | 片段级人工例外 |
| `POST /api/scan` | 全量/增量扫描（带 `prevSummary/prevHits/base` 即增量） |
| `POST /api/publish-check` | 发布检查，始终全量，与浏览器同快照 |

## Docker
```bash
docker compose up --build
```
