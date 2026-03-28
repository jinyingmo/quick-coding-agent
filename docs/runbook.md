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
- 在 git 仓库中优先使用 `git apply`；非 git 目录会自动切换到文件级补丁应用。
- 检索为 `keyword + vector + graph` 混合策略。
- 每轮验证失败会自动回滚本轮补丁，再进入下一轮反思重试。
- 上下文预算和检索规模可通过 `.env` 的 `CONTEXT_CHAR_BUDGET` 与 `RETRIEVE_TOP_K` 调整。
