import type { MemoryStore } from "./memory-store.js";

export class EpisodicMemory {
  constructor(private store: MemoryStore) {}

  async addCase(input: {
    task: string;
    reasoning: string;
    verifySummary: string;
    fileRefs: string[];
    success: boolean;
  }): Promise<string> {
    const text = [
      `task: ${input.task}`,
      `reasoning: ${input.reasoning}`,
      `verify: ${input.verifySummary}`,
      `success: ${input.success}`,
    ].join("\n");

    return this.store.put({
      layer: "episodic",
      kind: "case",
      text,
      tags: [input.success ? "success" : "failed"],
      fileRefs: input.fileRefs,
      importance: input.success ? 0.9 : 0.65,
      ttlSec: 30 * 24 * 3600,
    });
  }
}
