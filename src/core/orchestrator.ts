import type { LlmClient } from "../ai/llm-client.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { EpisodicMemory } from "../memory/episodic.js";
import { ShortTermMemory } from "../memory/short-term.js";
import { PatchEngine } from "../patch/patch-engine.js";
import type { HybridRetriever } from "../retrieve/hybrid-retriever.js";
import type { VectorRetriever } from "../retrieve/vector-retriever.js";
import { EmbeddingCache } from "../storage/embedding-cache.js";
import { GitTools } from "../tools/git-tools.js";
import { clipContextByCharBudget } from "../utils/context-budget.js";
import { logger } from "../utils/logger.js";
import { Verifier } from "../verify/verifier.js";
import type { TaskResult } from "./types.js";

export class Orchestrator {
  private shortMemory: ShortTermMemory;
  private episodicMemory: EpisodicMemory;

  constructor(
    private llm: LlmClient,
    private retriever: HybridRetriever,
    private memory: MemoryStore,
    private patchEngine: PatchEngine,
    private verifier: Verifier,
    private gitTools: GitTools,
    private vectorRetriever: VectorRetriever,
    private options: {
      retrieveTopK: number;
      contextCharBudget: number;
    }
  ) {
    this.shortMemory = new ShortTermMemory(memory);
    this.episodicMemory = new EpisodicMemory(memory);
  }

  async runTask(task: string, maxAttempts = 4): Promise<TaskResult> {
    try {
      await this.memory.cleanupExpired();
      await this.memory.compact("working");
      await this.memory.compact("episodic");
      let changedFiles = await this.gitTools.changedFiles();
      const commitHash = await this.gitTools.currentCommit();

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        logger.info({ attempt, task }, "agent attempt started");

        const [retrieved, relevantMemory] = await Promise.all([
          this.retriever.retrieve({
            task,
            topK: this.options.retrieveTopK,
            changedFiles,
          }),
          this.memory.search({ q: task, topK: 4 }),
        ]);

        const rawContextChunks = [
          ...retrieved.map((x) => ({ id: x.id, content: x.content, file: x.file })),
          ...relevantMemory.map((m) => ({ id: m.id, content: m.text })),
        ];
        const contextChunks = clipContextByCharBudget(rawContextChunks, this.options.contextCharBudget);

        const proposal = await this.llm.proposePatch({
          task,
          contextChunks,
          constraints: [
            "must output unified diff",
            "minimal change only",
            "no unrelated modifications",
            "prefer root-cause fix",
          ],
        });

        const applied = await this.patchEngine.apply(proposal.patch);
        if (!applied.ok) {
          await this.shortMemory.addNote(
            `attempt=${attempt} patch apply failed: ${applied.error ?? "unknown"}`,
            ["apply_failed"]
          );
          continue;
        }

        const verify = await this.verifier.run({ targetTests: proposal.testsToRun });
        if (verify.ok) {
          await this.episodicMemory.addCase({
            task,
            reasoning: proposal.reasoning,
            verifySummary: verify.summary,
            fileRefs: applied.changedFiles,
            success: true,
          });
          await this.memory.put({
            layer: "working",
            kind: "note",
            text: `success commit=${commitHash ?? "unknown"} attempt=${attempt}`,
            tags: ["success"],
            fileRefs: applied.changedFiles,
            importance: 0.8,
            ttlSec: 3600,
            commitHash: commitHash ?? undefined,
          });
          return { ok: true, attempt, changedFiles: applied.changedFiles };
        }

        await this.patchEngine.rollback(applied.rollbackId);
        const reflection = await this.llm.summarizeFailure({
          task,
          verifyLog: verify.logs,
          recentPatches: [proposal.patch],
        });
        await this.shortMemory.addNote(
          `attempt=${attempt} verify failed at ${verify.stage}: ${reflection}`,
          ["verify_failed", verify.stage],
          applied.changedFiles
        );
        await this.episodicMemory.addCase({
          task,
          reasoning: reflection,
          verifySummary: verify.summary,
          fileRefs: applied.changedFiles,
          success: false,
        });
        changedFiles = applied.changedFiles;
      }

      return { ok: false, reason: "max_attempts_reached" };
    } finally {
      // Clean up caches
      this.vectorRetriever.clearCache();
    }
  }
}
