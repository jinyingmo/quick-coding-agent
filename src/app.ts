import { buildContainer } from "./core/agent-loop.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    throw new Error('Usage: pnpm dev -- "fix xxx"');
  }
  const agent = await buildContainer(process.cwd());
  const result = await agent.runTask(task, Number(process.env.MAX_ATTEMPTS ?? 4));
  logger.info({ result }, "task finished");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  logger.error({ err: error }, "task failed");
  process.exit(1);
});
