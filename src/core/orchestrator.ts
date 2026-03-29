import fs from "node:fs/promises";
import path from "node:path";
import type { LlmClient } from "../ai/llm-client.js";
import type { PatchContextChunk } from "../ai/llm-client.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { EpisodicMemory } from "../memory/episodic.js";
import { ShortTermMemory } from "../memory/short-term.js";
import { PatchEngine } from "../patch/patch-engine.js";
import type { HybridRetriever } from "../retrieve/hybrid-retriever.js";
import type { VectorRetriever } from "../retrieve/vector-retriever.js";
import { GitTools } from "../tools/git-tools.js";
import { clipContextByCharBudget } from "../utils/context-budget.js";
import { logger } from "../utils/logger.js";
import type { AgentPhase } from "../ui/agent-progress.js";
import { AgentProgressUI } from "../ui/agent-progress.js";
import { Verifier } from "../verify/verifier.js";
import type { TaskResult } from "./types.js";

const ANALYSIS_KEYWORDS = [
  "分析",
  "设计",
  "架构",
  "介绍",
  "解释",
  "说明",
  "是什么",
  "怎么用",
  "architecture",
  "design",
  "analyze",
  "analyse",
  "explain",
  "describe",
  "what is",
  "how to",
];

function isAnalysisTask(task: string): boolean {
  const lower = task.toLowerCase();
  return ANALYSIS_KEYWORDS.some(keyword => lower.includes(keyword));
}

function extractPathCandidates(task: string): string[] {
  const matches = task.match(/(?:\/|\.\.\/|\.\/)[^\s"'`]+/g) ?? [];
  return Array.from(new Set(matches));
}

export class Orchestrator {
  private shortMemory: ShortTermMemory;
  private episodicMemory: EpisodicMemory;
  private progressUI: AgentProgressUI;

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
    },
    progressEnabled = true,
  ) {
    this.shortMemory = new ShortTermMemory(memory);
    this.episodicMemory = new EpisodicMemory(memory);
    this.progressUI = new AgentProgressUI(progressEnabled);
  }

  private async loadReferencedContext(
    task: string,
  ): Promise<PatchContextChunk[]> {
    const candidates = extractPathCandidates(task);
    const chunks: PatchContextChunk[] = [];

    for (const candidate of candidates) {
      const absolute = path.resolve(candidate);
      try {
        const stat = await fs.stat(absolute);
        if (stat.isDirectory()) {
          // Handle directory: read all files recursively
          const dirFiles = await this.listFilesRecursively(absolute);
          for (const filePath of dirFiles) {
            const content = await fs.readFile(filePath, "utf-8");
            chunks.push({
              id: filePath,
              file: filePath,
              content: content.slice(0, 20_000),
            });
          }
        } else if (stat.isFile()) {
          const content = await fs.readFile(absolute, "utf-8");
          chunks.push({
            id: absolute,
            file: absolute,
            content: content.slice(0, 20_000),
          });
        }
      } catch {
        continue;
      }
    }

    return chunks;
  }

  private async listFilesRecursively(dirPath: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden directories and common non-source directories
        if (
          !entry.name.startsWith(".") &&
          !["node_modules", "dist", "build"].includes(entry.name)
        ) {
          files.push(...(await this.listFilesRecursively(fullPath)));
        }
      } else if (entry.isFile() && !entry.name.startsWith(".")) {
        // Only include source files
        const ext = path.extname(entry.name).toLowerCase();
        const sourceExtensions = [
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".json",
          ".md",
          ".sql",
          ".yaml",
          ".yml",
        ];
        if (sourceExtensions.includes(ext)) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  async runTask(task: string, maxAttempts = 4): Promise<TaskResult> {
    try {
      // Start progress UI
      this.progressUI.start(task, maxAttempts);

      logger.info({ task }, "runTask started");
      this.progressUI.setPhase("init", "Initializing agent...");

      await this.memory.cleanupExpired();
      await this.memory.compact("working");
      await this.memory.compact("episodic");
      let changedFiles = await this.gitTools.changedFiles();
      const commitHash = await this.gitTools.currentCommit();

      if (isAnalysisTask(task)) {
        logger.info("analysis task detected");
        this.progressUI.setPhase("analysis", "Loading analysis context...");

        const referencedContext = await this.loadReferencedContext(task);
        logger.info(
          { referencedFiles: referencedContext.length },
          "analysis context loaded",
        );
        this.progressUI.setPhase("llm-call", "Analyzing task with LLM...");

        const analysis = await this.llm.analyze({
          task,
          contextChunks: referencedContext,
          constraints: [
            "focus on architecture and design reasoning",
            "be explicit about evidence from the provided files",
            "do not suggest code patches unless directly asked",
          ],
        });

        logger.info({ analysis }, "analysis completed");
        this.progressUI.stop();

        return {
          ok: true,
          mode: "analysis",
          summary: analysis,
        };
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        logger.info({ attempt, task }, "agent attempt started");
        this.progressUI.setAttempt(attempt);
        this.progressUI.setPhase("retrieval", "Retrieving relevant context...");

        const [retrieved, relevantMemory] = await Promise.all([
          this.retriever.retrieve({
            task,
            topK: this.options.retrieveTopK,
            changedFiles,
          }),
          this.memory.search({ q: task, topK: 4 }),
        ]);
        logger.info(
          {
            attempt,
            retrievedChunks: retrieved.length,
            memoryHits: relevantMemory.length,
          },
          "retrieval finished",
        );
        this.progressUI.showRetrievalProgress(
          retrieved.length,
          relevantMemory.length,
        );

        const rawContextChunks = [
          ...retrieved.map(x => ({
            id: x.id,
            content: x.content,
            file: x.file,
          })),
          ...relevantMemory.map(m => ({ id: m.id, content: m.text })),
        ];
        const contextChunks = clipContextByCharBudget(
          rawContextChunks,
          this.options.contextCharBudget,
        );
        logger.info(
          { attempt, contextChunks: contextChunks.length },
          "context prepared",
        );

        logger.info({ attempt }, "requesting patch proposal");
        this.progressUI.setPhase("llm-call", "Generating patch proposal...");

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
        logger.info(
          {
            attempt,
            testsToRun: proposal.testsToRun.length,
            patchLength: proposal.patch.length,
          },
          "patch proposal received",
        );

        if (proposal.patch.trim() === "") {
          logger.info(
            { attempt },
            "no patch proposed, terminating task as finished",
          );
          this.progressUI.stop();
          return {
            ok: true,
            attempt,
            changedFiles: [],
            summary: proposal.reasoning,
          };
        }

        this.progressUI.setPhase("patch", "Applying patch...");
        const applied = await this.patchEngine.apply(proposal.patch);
        if (!applied.ok) {
          logger.warn({ attempt, error: applied.error }, "patch apply failed");
          this.progressUI.warn(
            `Patch apply failed: ${applied.error ?? "unknown"}`,
          );
          await this.shortMemory.addNote(
            `attempt=${attempt} patch apply failed: ${applied.error ?? "unknown"}`,
            ["apply_failed"],
          );
          continue;
        }

        logger.info(
          { attempt, changedFiles: applied.changedFiles },
          "patch applied",
        );
        this.progressUI.showPatchProgress(applied.changedFiles.join(", "));

        this.progressUI.setPhase("verification", "Running verification...");
        const verify = await this.verifier.run({
          targetTests: proposal.testsToRun,
        });
        logger.info(
          {
            attempt,
            ok: verify.ok,
            stage: verify.stage,
            durationMs: verify.durationMs,
          },
          "verification finished",
        );
        if (verify.ok) {
          this.progressUI.setPhase("memory", "Saving to memory...");
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
          this.progressUI.stop();
          return {
            ok: true,
            attempt,
            changedFiles: applied.changedFiles,
            summary: proposal.reasoning,
          };
        }

        this.progressUI.warn(
          `Verification failed at ${verify.stage}, rolling back...`,
        );
        await this.patchEngine.rollback(applied.rollbackId);
        logger.info({ attempt }, "rollback completed");

        this.progressUI.setPhase("llm-call", "Analyzing failure...");
        const reflection = await this.llm.summarizeFailure({
          task,
          verifyLog: verify.logs,
          recentPatches: [proposal.patch],
        });
        await this.shortMemory.addNote(
          `attempt=${attempt} verify failed at ${verify.stage}: ${reflection}`,
          ["verify_failed", verify.stage],
          applied.changedFiles,
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

      this.progressUI.error("Max attempts reached");
      return { ok: false, reason: "max_attempts_reached" };
    } finally {
      // Clean up caches
      this.vectorRetriever.clearCache();
    }
  }
}
