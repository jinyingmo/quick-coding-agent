export interface RetrieveChunk {
  id: string;
  file: string;
  content: string;
  score: number;
}

export interface HybridRetriever {
  retrieve(input: {
    task: string;
    topK: number;
    changedFiles?: string[];
  }): Promise<RetrieveChunk[]>;
}
