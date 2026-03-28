export interface PatchContextChunk {
  id: string;
  content: string;
  file?: string;
}

export interface PatchProposal {
  reasoning: string;
  patch: string;
  testsToRun: string[];
}

export interface LlmClient {
  proposePatch(input: {
    task: string;
    contextChunks: PatchContextChunk[];
    constraints: string[];
  }): Promise<PatchProposal>;

  summarizeFailure(input: {
    task: string;
    verifyLog: string;
    recentPatches: string[];
  }): Promise<string>;

  embed(texts: string[]): Promise<number[][]>;
}
