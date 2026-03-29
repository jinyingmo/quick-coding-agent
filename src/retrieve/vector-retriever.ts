import { cosine } from "../utils/math.js";
import { EmbeddingCache } from "../storage/embedding-cache.js";
import type { FileChunk, FsIndexer } from "../repo/fs-indexer.js";
import type { RetrieveChunk } from "./hybrid-retriever.js";

export class VectorRetriever {
  private chunkCache: FileChunk[] | null = null;
  private chunkEmbCache: number[][] | null = null;

  constructor(
    private indexer: FsIndexer,
    private embedder: (texts: string[]) => Promise<number[][]>,
    private embeddingCache: EmbeddingCache
  ) {}

  async retrieve(task: string, topK: number): Promise<RetrieveChunk[]> {
    // Load chunks (in-memory cache within same runTask)
    if (!this.chunkCache) {
      this.chunkCache = await this.indexer.chunkFiles(1500);
    }
    if (this.chunkCache.length === 0) return [];

    // Get embeddings with batching and db caching
    if (!this.chunkEmbCache) {
      const chunkContents = this.chunkCache.map((c) => c.content);
      this.chunkEmbCache = await this.embeddingCache.getOrCompute(
        chunkContents,
        this.embedder
      );
    }

    const queryEmbs = await this.embeddingCache.getOrCompute([task], this.embedder);
    const queryEmb = queryEmbs[0];

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
