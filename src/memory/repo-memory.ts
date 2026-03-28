import type { MemoryStore } from "./memory-store.js";

export class RepoMemory {
  constructor(private store: MemoryStore) {}

  async addSymbolNote(file: string, symbol: string, references: string[]): Promise<string> {
    return this.store.put({
      layer: "repo",
      kind: "symbol",
      text: `symbol=${symbol}\nrefs=${references.join(",")}`,
      tags: ["symbol"],
      fileRefs: [file, ...references],
      importance: 0.8,
    });
  }
}
