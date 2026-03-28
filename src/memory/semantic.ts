import type { MemoryStore } from "./memory-store.js";

export class SemanticMemory {
  constructor(private store: MemoryStore) {}

  async addRule(text: string, tags: string[] = []): Promise<string> {
    return this.store.put({
      layer: "semantic",
      kind: "rule",
      text,
      tags,
      fileRefs: [],
      importance: 0.95,
    });
  }
}
