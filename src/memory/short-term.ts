import type { MemoryStore } from "./memory-store.js";

export class ShortTermMemory {
  constructor(private store: MemoryStore) {}

  async addNote(text: string, tags: string[] = [], fileRefs: string[] = []): Promise<string> {
    return this.store.put({
      layer: "working",
      kind: "note",
      text,
      tags,
      fileRefs,
      importance: 0.6,
      ttlSec: 2 * 3600,
    });
  }
}
