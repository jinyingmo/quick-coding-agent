# Agent Tool-Call 演示

这是一个可运行的、**形态接近 Claude Code 的 agent**，围绕主项目最核心的三个思路构建：

1. **查询循环（Query loop）**：LLM 产出 `tool_use` 块，运行时并行执行工具，结果以 `tool_result` 回传，循环往复直到模型停止。
2. **带独立权限策略的 Fork 子 Agent**：后台任务（本演示中的记忆抽取）在隔离上下文中运行，继承父级提示缓存，但通过 `CanUseToolFn` 进行沙箱限制。
3. **Stop hooks**：主循环结束后，以 fire-and-forget 方式执行副作用任务（抽取记忆、自动保存、遥测等），不阻塞用户拿到回答。

它与同级的 [`memory-system`](../memory-system/README.md) 演示联动，复用 `findRelevantMemories`、`buildMemoryPrompt`、`saveMemory` 等能力，因此持久化记忆链路是**端到端真实可运行**的，而非伪造。

> **一句话概括：**“Claude Code 的 `query` 循环是什么样？这个仓库把它提炼为约 1.2k 行 TypeScript，你可以在一个下午读透。”

---

## 演示内容

| 概念（对应主项目） | 在本项目中的位置 |
|---|---|
| `Tool` 接口（`name` / `description` / `inputSchema` / `isReadOnly` / `call`） | `src/types.ts`, `src/tools/*.ts` |
| 权限闸门（`CanUseToolFn`, allow / deny / updatedInput） | `src/permissions.ts` |
| 查询循环（`tool_use` ↔ `tool_result` 直到 `end_turn`） | `src/query.ts` |
| 继承父上下文的 Fork Agent | `src/forkedAgent.ts` |
| Stop hooks（模型完成后触发后台任务） | `src/agent.ts`, `src/extractMemories.ts` |
| 主写入与后台抽取互斥 | `src/extractMemories.ts` (`hasMemoryWritesSince`) |
| 节流 / 单飞 / 尾随重跑机制 | `src/extractMemories.ts` |
| OpenAI 兼容的工具调用（Moonshot/Kimi） | `src/llm.ts` |
| 感知记忆的系统提示词 | `src/systemPrompt.ts`（调用 `buildMemoryPrompt`） |
| 能力提供器（本地 + MCP） | `src/capabilities/*`, `src/mcp/*` |
| Skills 加载 / 解析 / 提示注入 | `src/skills/*`, `src/agent.ts` |
| 离线、确定性演示（无需 LLM Key） | `src/scripted.ts` |

---

## 快速开始

```bash
cd packages/agent-tool-call
npm install

# 离线脚本演示 —— 不需要 API key，包含 3 个端到端场景
npm run demo

# 交互式 REPL —— 需要在 .env 中配置 KIMI_API_KEY
cp .env.example .env
# 编辑 .env，填入你的 Moonshot key
npm run repl
```

默认会使用同级目录的记忆路径 `../memory-system/memory`，因此 agent 保存的记忆会立即出现在 memory-system 演示中。你可以通过 `MEMORY_DIR=...` 或 `--memory-dir <path>`（REPL 参数）覆盖。

### REPL 命令

| 命令 | 作用 |
|---|---|
| `/quit` 或 `/exit` | 等待后台任务收尾后退出 |
| `/history` | 打印当前会话内消息数 |
| `/reload` | 用最新 `MEMORY.md` 重建系统提示词 |
| `/memory` | 打印当前记忆目录 |
| `/tools` | 打印当前加载的工具名（local + MCP） |
| `/skills` | 打印当前激活的 skill id |

---

## 脚本演示（重点）

`npm run demo` 会使用一个很小的 `CannedModel` 跑 3 个离线场景（无需 API）。它执行的是真实查询循环、真实权限检查、真实记忆抽取入口；只有 LLM 被替换为预置响应。

```text
▶ Scenario 1: main agent searches memory, answers, then extractor fires
  - turn 1: assistant emits search_memory tool_use
  - search_memory hits the memory-system demo's findRelevantMemories
  - turn 2: assistant produces final text
  - stop hook → fire-and-forget runForkedAgent('extract_memories')

▶ Scenario 2: forked extractor tries to write outside memoryDir → DENY
  - write inside memoryDir  → ALLOW
  - write to ../../pwned.txt → DENY (permission policy refuses, returns
    deny block to the model so it can recover)

▶ Scenario 3: runQueryLoop without an API key — graceful error path
  - LLM call surfaces a precise, actionable error message
```

---

## 为什么它看起来像 Claude Code？

`runQueryLoop` 的骨架与主项目 `src/query.ts` 基本一致，只是做了精简：

```ts
while (turn++ < maxTurns) {
  const assistant = await callLLM({ systemPrompt, history, tools })
  history.push(assistant)

  const toolUses = getToolUses(assistant)
  if (toolUses.length === 0) break        // model is done

  const results = await Promise.all(
    toolUses.map(tu => executeOne(tu, tools, canUseTool, ctx))
  )
  history.push(createUserMessage(results))
}

if (!isForkedAgent) for (const hook of stopHooks) await hook(...)
return { messages: history, finalMessage: history.at(-1)! }
```

权限校验发生在 `tool.call` **之前**：

```ts
const decision = await canUseTool(tool, parsedInput, ctx)
if (decision.behavior === 'deny') {
  return { isError: true, content: `Permission denied: ${decision.message}` }
}
return tool.call(decision.updatedInput, ctx)
```

抽取器本质上就是一次子 Agent 调用：循环与工具一致，但 prompt 和 `canUseTool` 更严格（写入限制在 `memoryDir`）：

```ts
runForkedAgent({
  parentSystemPrompt,
  parentMessages: messages,    // share the prompt cache
  prompt: extractMemoriesPrompt,
  tools: ALL_TOOLS,
  canUseTool: restrictToMemoryDirPermission(memoryDir),
  forkLabel: 'extract_memories',
})
```

---

## 项目结构

```text
agent-tool-call/
├── src/
│   ├── types.ts           # Message / ContentBlock / Tool / ToolUseContext
│   ├── tools/
│   │   ├── readFile.ts    # read_file       (read-only)
│   │   ├── writeFile.ts   # write_file      (write — gated)
│   │   ├── listDir.ts     # list_dir        (read-only)
│   │   ├── searchMemory.ts# search_memory   (proxies findRelevantMemories)
│   │   └── index.ts       # ALL_TOOLS, findToolByName
│   ├── permissions.ts     # allowAllPermission, restrictToMemoryDirPermission
│   ├── llm.ts             # Moonshot/Kimi tool-calling client + JSON-schema
│   ├── query.ts           # runQueryLoop (the heart of the demo)
│   ├── forkedAgent.ts     # runForkedAgent + hasMemoryWritesSince
│   ├── extractMemories.ts # initExtractMemories: throttle + mutex + drain
│   ├── systemPrompt.ts    # buildSystemPrompt (injects buildMemoryPrompt)
│   ├── agent.ts           # high-level Agent class with stop-hook wiring
│   ├── scripted.ts        # offline 3-scenario demo via CannedModel
│   └── cli.ts             # CLI: --scripted | --repl
├── package.json
├── tsconfig.json
└── .env.example
```

本包通过 workspace linking 依赖 `@quick-coding-agent/memory-system`。

---

## 配置

所有配置都通过环境变量控制（见 `.env.example`）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `KIMI_API_KEY` | （无） | `npm run repl` 必填 |
| `KIMI_MODEL` | `moonshot-v1-8k` | 需支持 tool-calling |
| `KIMI_BASE_URL` | `https://api.moonshot.cn/v1` | OpenAI 兼容接口 |
| `KIMI_TIMEOUT_MS` | `30000` | 单次 LLM 调用超时 |
| `MEMORY_DIR` | `../memory-system/memory` | 持久化记忆目录 |
| `DEBUG` | （未设置） | 设为 `1` 打印 LLM payload 与工具拒绝日志 |
| `MCP_SERVERS` | （未设置） | MCP server 配置 JSON 数组（优先于文件） |
| `MCP_SERVERS_FILE` | （未设置） | 包含 MCP server 数组的 JSON 文件路径 |
| `MCP_ENABLED` | auto | 强制开启/关闭 MCP（`true/false`） |
| `SKILL_ROOTS` | （未设置） | Skill 根目录（按系统路径分隔符分隔） |
| `SKILLS` | （未设置） | 默认激活的 skill id，逗号分隔 |
| `SKILL_STRICT_ALLOWLIST` | `false` | 为 `true` 时，激活 skill 可收敛工具集 |

### MCP server 配置格式

`MCP_SERVERS` / `MCP_SERVERS_FILE` 必须是 JSON 数组：

```json
[
  {
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/abs/project/path"],
    "startupTimeoutMs": 15000,
    "toolTimeoutMs": 30000
  }
]
```

MCP 工具会暴露为：

`mcp__<serverName>__<toolName>`

例如：`mcp__filesystem__read_file`。

---

## 编程式 API（用于嵌入）

```typescript
import { Agent } from './src/agent.js'

const agent = new Agent({
  cwd: process.cwd(),
  memoryDir: '/abs/path/to/memory',
  onMemoriesSaved: paths => console.log('extractor wrote:', paths),
})

const reply = await agent.chat('Who am I and what role do I prefer?')
console.log(reply)

await agent.drain(10_000)   // wait for background extraction before exit
```

如果你想手动执行一次 forked agent：

```typescript
import { runForkedAgent } from './src/forkedAgent.js'
import { ALL_TOOLS } from './src/tools/index.js'
import { restrictToMemoryDirPermission } from './src/permissions.js'

await runForkedAgent({
  parentSystemPrompt: '…',
  parentMessages: parentHistory,
  tools: ALL_TOOLS,
  canUseTool: restrictToMemoryDirPermission(memoryDir),
  parentContext: ctx,
  prompt: 'Summarise the last conversation into a single project_*.md memory.',
  maxTurns: 5,
  forkLabel: 'manual_extract',
})
```

---

## 限制（刻意保留）

这是一个教学演示，不是生产运行时的完整替代。以下能力被有意省略：

- **流式响应**：当前按 turn 等待完整 LLM 返回。
- **成本/Token 追踪**：只有基础日志。
- **MCP servers、sub-skills、plug-ins、hooks file 的完整体系**：完整接入会让 demo 体量失控。
- **上下文压缩 / 长窗口管理**：只面向短会话。
- **AutoDream 汇总**：见主项目 `src/services/autoDream/`，模式相同但 prompt 不同。
- **落盘消息日志**：会话历史当前仅驻留进程内存。

---

## 相关文档

- [`packages/memory-system`](../memory-system/README.md)：本项目使用的持久化记忆子系统。
- 主项目 `src/query.ts`：本演示所对齐的生产查询循环。
- 主项目 `src/services/extractMemories/`：本演示 `extractMemories.ts` 的原型来源。
- `IMPLEMENTATION.md`：逐模块深度讲解。
