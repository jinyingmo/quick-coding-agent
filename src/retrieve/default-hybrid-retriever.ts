import type { HybridRetriever, RetrieveChunk } from "./hybrid-retriever.js";
import { KeywordRetriever } from "./keyword-retriever.js";
import { VectorRetriever } from "./vector-retriever.js";
import { GraphRetriever } from "./graph-retriever.js";
import { Reranker } from "./reranker.js";

export class DefaultHybridRetriever implements HybridRetriever {
  constructor(
    private keyword: KeywordRetriever,
    private vector: VectorRetriever,
    private graph: GraphRetriever,
    private reranker: Reranker
  ) {}

  async retrieve(input: {
    task: string;
    topK: number;
    changedFiles?: string[];
  }): Promise<RetrieveChunk[]> {
    const [kw, vec] = await Promise.all([
      this.keyword.retrieve(input.task, Math.max(8, input.topK)),
      this.vector.retrieve(input.task, Math.max(8, input.topK)),
    ]);
    const graph = this.graph.retrieve(input.changedFiles, Math.max(3, Math.floor(input.topK / 2)));

    return this.reranker.rerank([...kw, ...vec, ...graph], input.topK);
  }
}
