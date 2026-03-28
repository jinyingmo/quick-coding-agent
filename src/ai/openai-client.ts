import OpenAI from "openai";
import type { LlmClient, PatchProposal } from "./llm-client.js";
import { buildPatchPrompt } from "./prompts.js";
import { patchProposalSchema } from "./schemas.js";

function outputText(response: unknown): string {
  const maybe = response as { output_text?: string };
  return maybe.output_text ?? "";
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonFence = trimmed.match(/```json\s*([\s\S]*?)```/i);
    if (jsonFence?.[1]) {
      return JSON.parse(jsonFence[1]);
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    return null;
  }
}

function extractDiffFromText(text: string): string | null {
  const diffFence = text.match(/```diff\s*([\s\S]*?)```/i);
  if (diffFence?.[1]) return diffFence[1].trim();

  const genericFence = text.match(/```\s*([\s\S]*?)```/);
  if (genericFence?.[1] && genericFence[1].includes("--- ") && genericFence[1].includes("+++ ")) {
    return genericFence[1].trim();
  }

  if (text.includes("--- ") && text.includes("+++ ")) return text.trim();
  return null;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i === retries) break;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastError;
}

export class OpenAiClient implements LlmClient {
  private client: OpenAI;

  constructor(
    apiKey: string,
    private model: string,
    private embeddingModel: string
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async proposePatch(input: {
    task: string;
    contextChunks: Array<{ id: string; content: string; file?: string }>;
    constraints: string[];
  }): Promise<PatchProposal> {
    const prompt = buildPatchPrompt({
      task: input.task,
      context: input.contextChunks,
      constraints: input.constraints,
    });

    const response = await withRetry(() =>
      this.client.responses.create({
        model: this.model,
        input: prompt,
        temperature: 0.1,
      })
    );

    const text = outputText(response);
    const maybeObj = extractJsonObject(text);
    if (maybeObj) {
      return patchProposalSchema.parse(maybeObj);
    }

    const diff = extractDiffFromText(text);
    if (!diff) {
      throw new Error("Model output does not contain valid JSON or diff patch");
    }

    return patchProposalSchema.parse({
      reasoning: "Parsed from non-JSON model output",
      patch: diff,
      testsToRun: [],
    });
  }

  async summarizeFailure(input: {
    task: string;
    verifyLog: string;
    recentPatches: string[];
  }): Promise<string> {
    const response = await withRetry(() =>
      this.client.responses.create({
        model: this.model,
        input: [
          `任务: ${input.task}`,
          `验证日志: ${input.verifyLog}`,
          `最近补丁: ${input.recentPatches.join("\n---\n")}`,
          "请用简洁中文总结根因和下一步修复建议（120字内）。",
        ].join("\n"),
        temperature: 0,
      })
    );
    return outputText(response);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const result = await withRetry(() =>
      this.client.embeddings.create({
        model: this.embeddingModel,
        input: texts,
      })
    );

    return result.data.map(item => item.embedding as number[]);
  }
}
