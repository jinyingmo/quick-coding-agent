import { buildContainer } from "./core/agent-loop.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    throw new Error('Usage: pnpm dev -- "fix xxx"');
  }
  logger.info({ task }, "task received");
  const agent = await buildContainer(process.cwd());
  logger.info("agent container ready");
  const result = await agent.runTask(task, Number(process.env.MAX_ATTEMPTS ?? 4));
  logger.info({ result }, "task finished");
  if (result.ok && result.summary) {
    process.stdout.write(`\n${result.summary}\n`);
  }
  if (!result.ok) {
    process.stdout.write(`\n任务失败: ${result.reason}\n`);
  }
}

main().catch((error) => {
  logger.error({ err: error }, "task failed");
  process.exit(1);
});
