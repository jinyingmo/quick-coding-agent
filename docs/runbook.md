# Runbook

## 1. Install

```bash
pnpm install
cp .env.example .env
```

## 2. Run

```bash
pnpm dev -- "修复某个报错"
```

示例：

```bash
pnpm dev -- "修复 src/service/user.ts 中 getUserById 在 id 为 undefined 时抛错的问题"
```

## 3. Build

```bash
pnpm run build
node dist/app.js "修复某个报错"
```

## 4. Notes

- 数据库存储在 `DB_PATH`（默认 `.agent/agent.db`）。
- **兼容性**：项目使用标准 `chat.completions.create`，支持通过向 `.env` 中配置 `OPENAI_BASE_URL` 轻松切至任意兼容 OpenAI 格式的第三方模型接口（如 DeepSeek、Kimi、Ollama）。
- **Embedding 接口**：检索所需的文本 Embedding（向量化）使用 OpenAI 兼容接口。默认复用 `OPENAI_API_KEY` 与 `OPENAI_BASE_URL`，也可通过 `.env` 的 `OPENAI_EMBEDDING_API_KEY` 与 `OPENAI_EMBEDDING_BASE_URL` 单独指定第三方兼容凭证与地址，并通过 `OPENAI_EMBEDDING_MODEL` 指定 embedding 模型。
- 在 git 仓库中优先使用 `git apply`；非 git 目录会自动切换到文件级补丁应用。
- 检索为 `keyword + vector + graph` 混合策略。
- 每轮验证失败会自动回滚本轮补丁，再进入下一轮反思重试。
- 上下文预算和检索规模可通过 `.env` 的 `CONTEXT_CHAR_BUDGET` 与 `RETRIEVE_TOP_K` 调整。
