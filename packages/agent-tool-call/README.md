# Agent Tool-Call

这是一个可运行的、**形态接近 Claude Code 的 agent**，围绕核心思路构建：

1. **查询循环（Query loop）**：LLM 产出 `tool_use` 块，运行时并行执行工具，结果以 `tool_result` 回传，循环往复直到模型停止。
2. **带独立权限策略的 Fork 子 Agent**：后台任务（如记忆抽取）在隔离上下文中运行，继承父级上下文，通过 `CanUseToolFn` 沙箱限制。
3. **Stop hooks**：主循环结束后，fire-and-forget 执行副作用（抽取记忆、遥测），不阻塞用户拿到回答。
4. **MCP 与 Skills**：支持连接外部 MCP 服务器扩展工具集，通过 Skills 注入领域知识和工具白名单。
5. **流式响应**：支持 SSE 实时推送 LLM 输出，Token 用量透明可追溯。

> "Claude Code 的 Agent 循环是什么样？这个仓库把它提炼为可运行的 TypeScript。"

---

## 快速开始

```bash
cd packages/agent-tool-call
pnpm install

# 离线脚本演示 — 不需要 API key，3 个端到端场景
pnpm demo

# 交互式 REPL — 需要 KIMI_API_KEY
cp .env.example .env
# 编辑 .env，填入 Moonshot key
pnpm repl
```

默认会使用当前包内的记忆路径 `./memory`，可通过 `MEMORY_DIR=...` 覆盖。

### P0 HTTP(S) 服务

支持 HTTP 和 HTTPS（配置 TLS 后自动切换），带 CORS、流式 SSE、Token 追踪。

```bash
# 1. 准备 API Key 身份
export P0_API_KEYS='[
  {
    "token": "local-dev-token",
    "userId": "demo-user",
    "workspaceId": "demo-workspace",
    "cwd": "/abs/path/to/quick-coding-agent",
    "memoryDir": "/abs/path/to/quick-coding-agent/packages/agent-tool-call/memory"
  }
]'

# 2. 启动（默认端口 8787）
pnpm agent:serve

# 3. 可选：HTTPS 模式
export TLS_CERT=/path/to/cert.pem
export TLS_KEY=/path/to/key.pem
pnpm agent:serve

# 4. 可选：开启 CORS
export CORS_ORIGIN=https://example.com
pnpm agent:serve
```

### API 概览

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/healthz` | 健康检查 |
| `POST` | `/sessions` | 创建会话 |
| `GET` | `/sessions/:id` | 查看会话信息 |
| `DELETE` | `/sessions/:id` | 释放会话 |
| `GET` | `/sessions/:id/messages` | 查看消息历史 |
| `POST` | `/sessions/:id/messages` | 发送消息（支持 `stream: true` 启用 SSE） |
| `POST` | `/sessions/:id/extract-memory` | 触发记忆抽取 |
| `GET` | `/approvals/:id` | 查看审批详情 |
| `POST` | `/approvals/:id/approve` | 批准审批 |
| `POST` | `/approvals/:id/reject` | 拒绝审批 |

### curl 示例

```bash
# 创建会话
curl -s http://127.0.0.1:8787/sessions \
  -X POST \
  -H 'Authorization: Bearer local-dev-token'

# 发送消息
curl -s http://127.0.0.1:8787/sessions/<session-id>/messages \
  -X POST \
  -H 'Authorization: Bearer local-dev-token' \
  -H 'Content-Type: application/json' \
  -d '{"text":"Summarize the testing guidance in memory."}'

# 流式发送消息（SSE）
curl -s http://127.0.0.1:8787/sessions/<session-id>/messages \
  -X POST \
  -H 'Authorization: Bearer local-dev-token' \
  -H 'Content-Type: application/json' \
  -d '{"text":"Write a hello world program.","stream":true}'

# 触发记忆抽取
curl -s http://127.0.0.1:8787/sessions/<session-id>/extract-memory \
  -X POST \
  -H 'Authorization: Bearer local-dev-token'
```

当操作需要审批时返回：

```json
{
  "request_id": "req_xxx",
  "data": {
    "status": "confirm_required",
    "approvalId": "apr_xxx",
    "reason": "Human approval required for shell command"
  }
}
```

批准后继续：

```bash
curl -s http://127.0.0.1:8787/approvals/<approval-id>/approve \
  -X POST \
  -H 'Authorization: Bearer local-dev-token'
```

---

## REPL 命令

| 命令 | 作用 |
|------|------|
| `/quit` / `/exit` | 退出 |
| `/history` | 打印会话消息数 |
| `/reload` | 重建系统提示词 |
| `/memory` | 打印记忆目录路径 |
| `/tools` | 打印当前加载的工具名 |
| `/skills` | 打印当前激活的 Skill ID |

---

## 项目结构

```
agent-tool-call/
├── src/
│   ├── types.ts              # Message / ContentBlock / Tool / ToolUseContext
│   ├── agent.ts              # Agent 类（会话、技能、流式）
│   ├── query.ts              # runQueryLoop（核心循环）
│   ├── llm.ts                # LLM 客户端（callLLM + callLLMStream）
│   ├── tools/
│   │   ├── readFile.ts       # read_file
│   │   ├── writeFile.ts      # write_file
│   │   ├── editFile.ts       # edit_file
│   │   ├── listDir.ts        # list_dir
│   │   ├── glob.ts           # glob（文件模式匹配）
│   │   ├── grep.ts           # grep（内容搜索）
│   │   ├── bash.ts           # bash（命令执行）
│   │   ├── searchMemory.ts   # search_memory
│   │   └── index.ts          # ALL_TOOLS 注册
│   ├── permissions.ts        # allowAll / restrictToMemoryDir
│   ├── policy/               # P0 策略引擎（allow/deny/confirm）
│   ├── capabilities/         # 能力提供器（本地 + MCP）
│   ├── mcp/                  # MCP 客户端 / 管理器 / 配置
│   ├── skills/               # Skills 加载 / 解析 / 提示注入
│   ├── extractMemories.ts    # 后台记忆抽取（节流、互斥）
│   ├── forkedAgent.ts        # Fork 子 Agent
│   ├── systemPrompt.ts       # 系统提示词构建
│   ├── memory/               # 内置记忆系统（扫描/索引/检索/存储）
│   ├── runtime/              # 运行时（会话、审批、清理器）
│   ├── observability/
│   │   ├── logger.ts         # 统一 Logger 接口 + 控制台/Pino/Winston 适配器
│   │   └── panic.ts          # 全局异常捕获与优雅退出
│   ├── auth/apiKey.ts        # Bearer Token 认证
│   ├── server/app.ts         # HTTP(S) Server（TLS/CORS/SSE）
│   ├── serverCli.ts          # Server 入口
│   ├── cli.ts                # CLI 入口（REPL / Scripted）
│   ├── scripted.ts           # 离线演示（无需 API Key）
│   ├── memoryCli.ts          # 记忆系统 CLI
│   └── index.ts              # 公共 API 导出
├── tests/                    # 测试文件
├── memory/                   # 示例记忆目录
├── package.json
└── tsconfig.json
```

---

## 核心能力的生产就绪度

| 能力 | 状态 | 说明 |
|------|------|------|
| Agent 查询循环 | ✅ 完整 | tool_use ↔ tool_result 循环 + stop hook + 审批中断 |
| 8 个内置工具 | ✅ 完整 | read/write/edit/list/glob/grep/bash/search_memory |
| MCP 集成 | ✅ 完整 | JSON-RPC 2.0 + 子进程 stdio + 多服务器 |
| Skills 系统 | ✅ 完整 | SKILL.md 发现 + @mention + 工具白名单 |
| 权限策略引擎 | ✅ 完整 | allow/deny/confirm 三态 + 命令分类器 |
| 记忆系统 | ✅ 完整 | 扫描→索引→存储→检索（LLM+关键词双模式） |
| 流式响应 | ✅ 完整 | SSE 实时推送 + Token 用量追踪 |
| 统一日志接口 | ✅ 完整 | Logger 抽象 + Pino/Winston 适配器 |
| HTTPS/TLS | ✅ 完整 | 证书配置自动切换 |
| CORS | ✅ 完整 | 配置驱动 |
| 全局异常捕获 | ✅ 完整 | uncaughtException + unhandledRejection |
| 审批机制 | ✅ 完整 | create/approve/reject/expire 状态机 |
| 会话持久化 | ⚠️ 内存态 | 进程重启丢失（Plan: Phase 1 引入 SQLite） |
| Token 统计 | ✅ 流式可见 | 非流式暂无（Plan: Phase 2 解析 usage 字段） |
| 上下文压缩 | ❌ 未实现 | 仅靠消息数量限制（Plan: Phase 2 滑动窗口+摘要） |

---

## 配置

所有配置通过环境变量控制：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KIMI_API_KEY` | — | REPL/P0 服务必填 |
| `KIMI_MODEL` | `moonshot-v1-8k` | 需支持 tool-calling |
| `KIMI_BASE_URL` | `https://api.moonshot.cn/v1` | OpenAI 兼容接口 |
| `KIMI_TIMEOUT_MS` | `30000` | 单次 LLM 调用超时 |
| `MEMORY_DIR` | `./memory` | 持久化记忆目录 |
| `DEBUG` | — | 设为 `1` 打印 LLM payload 与拒绝日志 |
| **P0 Server** | | |
| `PORT` | `8787` | HTTP 服务端口 |
| `P0_API_KEYS` | — | JSON 数组，Bearer Token 身份映射 |
| `P0_SESSION_TTL_MS` | `1800000` | 会话过期时间 |
| `P0_MAX_SESSIONS` | `1000` | 最大并发会话数 |
| `P0_MAX_MESSAGES` | `200` | 每会话最大消息数 |
| `P0_MAX_SESSION_CHARS` | `1000000` | 每会话最大字符数 |
| `REQUEST_TIMEOUT_MS` | `120000` | HTTP 请求超时 |
| `HEADERS_TIMEOUT_MS` | `60000` | HTTP Headers 超时 |
| **TLS/HTTPS** | | |
| `TLS_CERT` / `TLS_CERT_PATH` | — | PEM 证书 |
| `TLS_KEY` / `TLS_KEY_PATH` | — | PEM 私钥 |
| `TLS_CA` / `TLS_CA_PATH` | — | CA 证书链（可选） |
| `TLS_REQUEST_CERT` | `false` | 是否要求客户端证书 |
| `CORS_ORIGIN` | — | 允许跨域的来源 |
| **MCP** | | |
| `MCP_SERVERS` | — | JSON 数组，直接配置 MCP 服务器 |
| `MCP_SERVERS_FILE` | — | 包含 MCP 数组的 JSON 文件路径 |
| `MCP_ENABLED` | auto | 强制开启/关闭（`true/false`） |
| `MCP_ALLOWED_TOOLS` | — | 允许的 MCP 工具，逗号分隔 |
| **Skills** | | |
| `SKILL_ROOTS` | — | Skill 根目录（系统分隔符分隔） |
| `SKILLS` | — | 默认激活的 Skill ID，逗号分隔 |
| `SKILL_STRICT_ALLOWLIST` | `false` | 启用时激活 Skill 收敛工具集 |

---

## 编程式 API

```typescript
import { Agent } from '@quick-coding-agent/agent-tool-call'

// 创建 Agent
const agent = new Agent({
  cwd: process.cwd(),
  memoryDir: '/abs/path/to/memory',
  onMemoriesSaved: paths => console.log('extractor wrote:', paths),
})

// 普通对话
const reply = await agent.chat('Who am I?')
console.log(reply)

// 流式对话
for await (const chunk of agent.streamChat('Write a poem')) {
  if (chunk.type === 'text_delta') process.stdout.write(chunk.text)
}
console.log('Tokens:', agent.lastUsage)

// 等待后台记忆抽取完成
await agent.drain(10_000)
```

### 日志系统接入

```typescript
import { createConsoleLogger, loggerFromPino, loggerFromWinston } from '@quick-coding-agent/agent-tool-call'

// 内置控制台 Logger
const logger = createConsoleLogger({ service: 'my-app' })
logger.info('server_started', { port: 3000 })

// 接入 pino
import pino from 'pino'
const pinoLogger = loggerFromPino(pino({ level: 'info' }))

// 接入 winston
import winston from 'winston'
const wLogger = loggerFromWinston(winston.createLogger({ transports: [...] }))

// 创建子 Logger（自动携带上下文）
const reqLog = logger.child({ request_id: 'req-123' })
reqLog.info('request_started') // 自动含 request_id
```

### Forked Agent

```typescript
import { runForkedAgent, ALL_TOOLS, restrictToMemoryDirPermission } from '@quick-coding-agent/agent-tool-call'

await runForkedAgent({
  parentSystemPrompt: '…',
  parentMessages: parentHistory,
  tools: ALL_TOOLS,
  canUseTool: restrictToMemoryDirPermission(memoryDir),
  parentContext: ctx,
  prompt: 'Summarise the last conversation into a project memory.',
  maxTurns: 5,
  forkLabel: 'extract',
})
```

---

## 脚本演示

`pnpm demo` 使用 `CannedModel` 跑 3 个离线场景（无需 API Key）：

```text
Scenario 1: agent 搜索记忆→回答→后台抽取器触发
Scenario 2: forked extractor 写入 memoryDir 外 → DENY
Scenario 3: 无 API Key 的优雅错误路径
```

---

## 为什么它像 Claude Code？

`runQueryLoop` 骨架与主项目 `src/query.ts` 一致：

```ts
while (turn++ < maxTurns) {
  const assistant = await callLLM({ systemPrompt, history, tools })
  history.push(assistant)

  const toolUses = getToolUses(assistant)
  if (toolUses.length === 0) break

  const results = await Promise.all(
    toolUses.map(tu => executeOne(tu, tools, canUseTool, ctx))
  )
  history.push(createUserMessage(results))
}

if (!isForkedAgent) for (const hook of stopHooks) await hook(...)
return { messages: history, finalMessage: history.at(-1)! }
```

权限在工具执行前校验：

```ts
const decision = await canUseTool(tool, parsedInput, ctx)
if (decision.behavior === 'deny') {
  return { isError: true, content: `Permission denied: ${decision.message}` }
}
return tool.call(decision.updatedInput, ctx)
```

---

## 限制

以下能力暂未实现（按 Plan 排序）：

| 能力 | 状态 | 计划 |
|------|------|------|
| 会话/审批持久化 | 内存态 | Phase 1：引入 SQLite |
| Token 统计（非流式） | — | Phase 2：解析 usage 字段 |
| 上下文压缩 | — | Phase 2：滑动窗口 + 摘要 |
| LLM 调用重试 | — | Phase 2：指数退避 |
| 监控/metrics | — | Phase 2：Prometheus |
| JWT 认证 | 静态 Bearer | Phase 3 |
| MCP 自动重连 | — | Phase 3 |
| 插件系统 | — | Phase 3 |

详见项目根目录的 `MCP_SKILLS_PLAN.md`。

---

## 相关文档

- `IMPLEMENTATION.md`：逐模块深度讲解
- `src/memory/`：内置持久化记忆子系统
- `MCP_SKILLS_PLAN.md`：MCP & Skills 接入方案
- 根目录 `packages/memory-system/`：独立记忆系统包
