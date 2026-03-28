import type { RetrieveChunk } from "./hybrid-retriever.js";

export class Reranker {
  rerank(chunks: RetrieveChunk[], topK: number): RetrieveChunk[] {
    const dedup = new Map<string, RetrieveChunk>();
    for (const chunk of chunks) {
      const existing = dedup.get(chunk.id);
      if (!existing || existing.score < chunk.score) {
        dedup.set(chunk.id, chunk);
      }
    }
    return Array.from(dedup.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
