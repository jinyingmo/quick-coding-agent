import type { RetrieveChunk } from "./hybrid-retriever.js";
import { SearchTools } from "../tools/search-tools.js";

export class KeywordRetriever {
  constructor(private searchTools: SearchTools) {}

  async retrieve(task: string, topK: number): Promise<RetrieveChunk[]> {
    const hits = await this.searchTools.rg(task, topK);
    const chunks: RetrieveChunk[] = [];
    for (const hit of hits.slice(0, topK)) {
      const snippet = await this.searchTools.readSnippet(hit.file, hit.line, 20);
      chunks.push({
        id: `${hit.file}:${hit.line}`,
        file: hit.file,
        content: snippet,
        score: 0.75,
      });
    }
    return chunks;
  }
}
