import { cosine } from "../utils/math.js";
import type { FileChunk, FsIndexer } from "../repo/fs-indexer.js";
import type { RetrieveChunk } from "./hybrid-retriever.js";

export class VectorRetriever {
  private chunkCache: FileChunk[] | null = null;
  private chunkEmbCache: number[][] | null = null;

  constructor(
    private indexer: FsIndexer,
    private embedder: (texts: string[]) => Promise<number[][]>
  ) {}

  async retrieve(task: string, topK: number): Promise<RetrieveChunk[]> {
    // Load chunks (in-memory cache within same runTask)
    if (!this.chunkCache) {
      this.chunkCache = await this.indexer.chunkFiles(1500);
    }
    if (this.chunkCache.length === 0) return [];

    // Get embeddings (no caching since embedding is disabled)
    if (!this.chunkEmbCache) {
      this.chunkEmbCache = await this.embedder(
        this.chunkCache.map((c) => c.content)
      );
    }

    const queryEmbs = await this.embedder([task]);
    const queryEmb = queryEmbs[0];
    
    // If embedding returns empty, return empty results
    if (!queryEmb || !this.chunkEmbCache.length) return [];

    const chunkEmbCache = this.chunkEmbCache;
    const scored = this.chunkCache
      .map((chunk, i) => ({
        ...chunk,
        score: cosine(queryEmb, chunkEmbCache[i]),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  }

  clearCache(): void {
    this.chunkCache = null;
    this.chunkEmbCache = null;
  }
}
