import type { RetrieveChunk } from "./hybrid-retriever.js";
import { DependencyGraphBuilder, type DependencyGraph } from "../repo/dependency-graph.js";
import { FsIndexer } from "../repo/fs-indexer.js";

export class GraphRetriever {
  private graph: DependencyGraph = new Map();

  constructor(
    private graphBuilder: DependencyGraphBuilder,
    private fsIndexer: FsIndexer
  ) {}

  async warmup(): Promise<void> {
    const files = await this.fsIndexer.listFiles();
    this.graph = await this.graphBuilder.build(files);
  }

  retrieve(changedFiles: string[] | undefined, topK: number): RetrieveChunk[] {
    if (!changedFiles || changedFiles.length === 0 || this.graph.size === 0) return [];
    const output: RetrieveChunk[] = [];
    for (const file of changedFiles) {
      const neighbors = this.graphBuilder.neighbors(this.graph, file).slice(0, 5);
      for (const dep of neighbors) {
        output.push({
          id: `${file}->${dep}`,
          file,
          content: `Dependency hint from ${file}: ${dep}`,
          score: 0.35,
        });
      }
    }
    return output.slice(0, topK);
  }
}
