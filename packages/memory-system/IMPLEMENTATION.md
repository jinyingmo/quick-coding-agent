# Claude Code 记忆系统核心实现解析

## 一、整体设计哲学

Claude Code 的记忆系统是一套**基于文件的持久化架构**，核心设计原则如下：

1. **文件即数据库**：所有记忆以 Markdown 文件形式存储在磁盘上，不依赖外部数据库，便于版本控制和人工审阅
2. **四种严格类型**：记忆被约束为 `user` / `feedback` / `project` / `reference` 四种离散类型，避免信息过载
3. **MEMORY.md 作为索引**：`MEMORY.md` 是一个**索引文件而非记忆本身**，每个条目仅一行，保证加载效率
4. **新鲜度意识**：超过 1 天的记忆会被标注为"可能过时"，要求模型在引用前验证
5. **不存可推导信息**：代码结构、git 历史、文件路径等可以从项目中推导的信息不应存入记忆

---

## 二、项目结构与模块对应

```
src/
├── types.ts      — 类型系统与记忆分类
├── parser.ts     — Frontmatter 解析器
├── scanner.ts    — 目录扫描与清单生成
├── indexer.ts    — MEMORY.md 索引管理
├── store.ts      — 记忆 CRUD 与索引同步
├── retriever.ts  — 相关性检索引擎
├── prompts.ts    — 系统提示词构建器
├── age.ts        — 记忆新鲜度计算
├── cli.ts        — 交互式演示入口
└── index.ts      — 公共 API 导出
```

---

## 三、核心模块详解

### 3.1 `types.ts` — 记忆类型系统

```typescript
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]
```

**设计要点**：

- 使用 `as const` 创建字面量联合类型，保证类型安全
- `parseMemoryType()` 对未知类型优雅降级（返回 `undefined`），兼容历史文件
- `MemoryHeader` 只存储元数据（文件名、路径、修改时间、描述、类型），不加载全文，保证扫描效率

---

### 3.2 `parser.ts` — Frontmatter 解析器

记忆文件采用 Markdown + YAML frontmatter 格式：

```markdown
---
name: {{memory name}}
description: {{one-line description}}
type: {{user | feedback | project | reference}}
---

{{memory content}}
```

**实现细节**：

- **正则匹配**：`/^---\s*\n([\s\S]*?)---\s*\n?/` 精确提取 `---` 包围的区域
- **极简 YAML 解析器**：不引入外部依赖，只处理 `key: value` 单行对，支持引号包裹
- **YAML 特殊字符转义**：`escapeYamlValue()` 检测值中是否包含 `"`、`:`、`#` 等特殊字符，自动用双引号包裹并转义，避免 frontmatter 解析失败

**为什么不用标准 YAML 库？**

记忆系统的 frontmatter 极为简单（只有 name/description/type 三个字段），引入完整 YAML 库会带来不必要的依赖负担。内置极简解析器足够覆盖所有场景。

---

### 3.3 `scanner.ts` — 目录扫描

```typescript
export async function scanMemoryFiles(memoryDir: string): Promise<MemoryHeader[]>
```

**扫描流程**：

1. `readdir(memoryDir, { recursive: true })` 递归列出所有文件
2. 过滤出 `.md` 结尾的文件，**排除 `MEMORY.md`**（它是索引，不是记忆）
3. 对每个文件：`stat()` 获取修改时间 + `readFile()` 读取前 30 行 + `parseFrontmatter()` 解析元数据
4. 使用 `Promise.allSettled()` 并行处理，单个文件失败不影响整体
5. 按 `mtimeMs` 降序排序（最新的在前），截取前 200 个

**为什么只读前 30 行？**

Frontmatter 通常只有 4-6 行，30 行是安全上限。避免读取大文件全文，大幅提升扫描性能。

**为什么 `Promise.allSettled` 而不是 `Promise.all`？**

某个记忆文件可能损坏或权限不足，不应导致整个扫描失败。`allSettled` 保证"容错继续"。

---

### 3.4 `indexer.ts` — MEMORY.md 索引管理

#### 索引格式

```markdown
- [Title](file.md) — one-line hook
```

- 无 frontmatter
- 每行一个条目，不超过 ~150 字符
- 语义化组织，不按时间顺序

#### 截断策略

```typescript
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000
```

`truncateEntrypointContent()` 实现了**双重截断**：

1. **行数截断**：超过 200 行时，只保留前 200 行
2. **字节截断**：超过 25KB 时，在最后一个完整换行符处截断（避免截断到行中间）

截断后会追加警告提示：

```markdown
> WARNING: MEMORY.md truncated. Keep index entries concise...
```

**为什么需要字节截断？**

某些索引可能使用超长行（如包含长 URL），行数截断不足以控制 prompt 长度。字节截断作为兜底机制。

#### 索引同步

`indexMemory()` 和 `unindexMemory()` 负责在保存/删除记忆时自动维护索引：

- 如果文件名已存在于索引中，更新其 hook 行
- 如果不存在，追加新行
- 删除时，按 `\(filename\)` 正则匹配移除对应行

---

### 3.5 `store.ts` — 记忆持久化

```typescript
export async function saveMemory(params: MemorySaveParams): Promise<void>
```

**保存流程**：

1. 使用 `buildMemoryFile()` 将参数组装为标准 Markdown + frontmatter
2. `mkdir(dirname(filePath), { recursive: true })` 确保父目录存在
3. `writeFile()` 写入文件
4. 调用 `indexMemory()` 自动更新 `MEMORY.md`

**两阶段设计**：

记忆保存被设计为**两个步骤**（原系统的硬性要求）：

- **Step 1**：写独立的 `.md` 主题文件
- **Step 2**：在 `MEMORY.md` 中添加索引指针

这种分离使得索引保持简洁，而详细内容放在主题文件中。

---

### 3.6 `retriever.ts` — 相关性检索

```typescript
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  alreadySurfaced: Set<string> = new Set()
): Promise<RelevantMemory[]>
```

**检索算法**（关键词相关性评分）：

1. 将查询拆分为小写单词（过滤掉长度 ≤2 的词）
2. 对每个记忆文件计算分数：
   - 文件名匹配：`+3` 分
   - 描述匹配：`+2` 分
   - 全文内容匹配：`+1` 分
3. 只读取**已有基础分**的文件全文（避免读取所有文件）
4. 按分数降序，取前 5 个
5. 排除 `alreadySurfaced` 中已展示过的文件

**与原系统的差异**：

原 Claude Code 使用 **Sonnet side-query**（调用一次 API 让模型选择最相关的记忆），精度更高但依赖外部 API。Demo 使用关键词评分，零依赖且足够展示核心逻辑。

---

### 3.7 `age.ts` — 新鲜度检测

```typescript
export function memoryAgeDays(mtimeMs: number): number
export function memoryAge(mtimeMs: number): string       // "today" / "yesterday" / "N days ago"
export function memoryFreshnessText(mtimeMs: number): string
export function memoryFreshnessNote(mtimeMs: number): string
```

**设计 rationale**：

- 人类对"47 天前"比"2026-03-05"更敏感，所以将时间戳转换为人可读的年龄
- 只有超过 **1 天**的记忆才提示陈旧（`today` 和 `yesterday` 被视为"新鲜"）
- `memoryFreshnessNote()` 包装在 `<system-reminder>` 标签中，作为模型内部的元提示

**陈旧度提示文本**：

```
This memory is N days old. Memories are point-in-time observations, not live state —
claims about code behavior or file:line citations may be outdated.
Verify against current code before asserting as fact.
```

---

### 3.8 `prompts.ts` — 系统提示词构建

```typescript
export async function buildMemoryPrompt(memoryDir: string): Promise<string>
```

这是整个系统**最关键**的模块——它生成的文本会被注入到 Claude Code 的系统提示词中，直接决定模型**如何**保存和**何时**访问记忆。

**提示词包含以下章节**：

1. **Types of memory** — 四种记忆类型的定义、何时保存、如何使用
2. **What NOT to save** — 明确排除可推导信息
3. **How to save memories** — 两阶段保存流程 + frontmatter 格式示例
4. **When to access memories** — 何时必须访问、何时忽略记忆
5. **Before recommending from memory** — 引用记忆前必须验证（检查文件是否存在、grep 函数名等）
6. **Memory and other forms of persistence** — 区分 memory vs plan vs task
7. **MEMORY.md** — 将实际索引内容附在最后

**为什么需要这么详细的指令？**

原系统通过大量 eval 验证发现：模型如果不被明确告知，会犯以下错误：

- 把代码模式存进记忆（违反"不存可推导信息"原则）
- 用户说"ignore memory"时，模型会"承认但继续引用"（而不是完全忽略）
- 引用记忆中的文件路径时，不验证文件是否仍然存在
- 把 MEMORY.md 当成记忆内容写进去（混淆索引和内容）

---

## 四、关键流程时序

### 4.1 记忆保存流程

```
用户请求保存信息
    │
    ▼
模型生成 frontmatter + content
    │
    ▼
saveMemory()
    ├── writeFile(主题文件)  ← 存储完整内容
    └── indexMemory()
            ├── readFile(MEMORY.md)
            ├── 更新/追加索引行
            └── writeFile(MEMORY.md)  ← 更新索引指针
```

### 4.2 记忆检索流程

```
用户发送查询
    │
    ▼
findRelevantMemories(query, memoryDir)
    ├── scanMemoryFiles()  ← 获取所有记忆元数据
    ├── 关键词评分
    ├── 读取高分文件全文
    └── 返回前 5 个结果
    │
    ▼
附加 freshness note（如果 >1 天旧）
    │
    ▼
注入模型上下文
```

### 4.3 系统启动流程

```
会话启动
    │
    ▼
loadMemoryPrompt()  ← 在原系统中
    ├── buildMemoryLines()  ← 行为指令文本
    ├── readEntrypoint()  ← 读取 MEMORY.md
    └── 合并为完整 prompt
    │
    ▼
注入 system prompt
```

---

## 五、与原系统的差异

| 特性 | 原系统 (claude-code-source) | 本 Demo |
|------|---------------------------|---------|
| **检索引擎** | Sonnet side-query API 调用 | 本地关键词评分 |
| **团队记忆** | 支持 server API 同步 | 不支持 |
| **会话记忆** | 支持 per-session summary.md | 不支持 |
| **Agent 记忆** | 支持 user/project/local 三级 | 不支持 |
| **后台提取** | fork 子 Agent 自动提取 | 不支持 |
| **夜间整合** | `/dream` 技能整合日志 | 不支持 |
| **文件系统** | 抽象为 FsOperations 接口 | 直接使用 fs/promises |
| **遥测** | 大量 analytics 事件 | 无 |

Demo 保留了**最核心的 20%**功能，展示了文件扫描、frontmatter 解析、索引管理、相关性检索、新鲜度检测和提示词构建这 6 个最本质的模块。

---

## 六、扩展思路

如果要在这个 Demo 基础上扩展为接近原系统的实现：

1. **接入 LLM 检索**：将 `findRelevantMemories()` 中的关键词评分替换为对 Claude API 的 side-query 调用
2. **后台提取 Agent**：在每次对话结束后，fork 一个子进程分析对话并自动写入记忆
3. **团队记忆同步**：添加 HTTP 客户端 + `fs.watch` 文件监听器实现双向同步
4. **会话记忆**：添加 per-session 的 `summary.md` 维护逻辑
5. **Agent 记忆**：添加 `~/.claude/agent-memory/<agentType>/` 路径支持
6. **每日日志模式**（KAIROS）：改为 append-only 日志 + 夜间 `/dream` 整合流程
