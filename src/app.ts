import { buildContainer } from "./core/agent-loop.js";
import { logger } from "./utils/logger.js";
import { renderTaskResult } from "./ui/result-renderer.js";

async function main(): Promise<void> {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    throw new Error('Usage: pnpm dev -- "fix xxx"');
  }
  
  const startTime = Date.now();
  logger.info({ task }, "task received");
  
  const agent = await buildContainer(process.cwd());
  logger.info("agent container ready");
  
  const result = await agent.runTask(task, Number(process.env.MAX_ATTEMPTS ?? 4));
  logger.info({ result }, "task finished");
  
  // Render the result with formatted output
  renderTaskResult(result, startTime, {
    showFiles: true,
    showTests: true,
    verbose: process.env.DEBUG === "true",
  });
}

main().catch((error) => {
  logger.error({ err: error }, "task failed");
  process.exit(1);
});
