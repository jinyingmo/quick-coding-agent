import type { PatchContextChunk } from "../ai/llm-client.js";

function estimateChars(text: string): number {
  return text.length;
}

export function clipContextByCharBudget(
  chunks: PatchContextChunk[],
  maxChars: number
): PatchContextChunk[] {
  const out: PatchContextChunk[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const size = estimateChars(chunk.content);
    if (size > maxChars) {
      if (out.length === 0) {
        out.push({
          ...chunk,
          content: chunk.content.slice(0, maxChars),
        });
      }
      break;
    }
    if (used + size > maxChars) break;
    out.push(chunk);
    used += size;
  }
  return out;
}
