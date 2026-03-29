import OpenAI from "openai";
import type { LlmClient, PatchProposal } from "./llm-client.js";
import { buildAnalysisPrompt, buildPatchPrompt } from "./prompts.js";
import { patchProposalSchema } from "./schemas.js";
import { logger } from "../utils/logger.js";

function outputText(response: any): string {
  if (response.choices && response.choices.length > 0) {
    return response.choices[0].message.content ?? "";
  }
  return response.output_text ?? "";
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonFence = trimmed.match(/```json\s*([\s\S]*?)```/i);
    if (jsonFence?.[1]) {
      try {
        return JSON.parse(jsonFence[1]);
      } catch {
        // fall through
      }
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    return null;
  }
}

function extractDiffFromText(text: string): string | null {
  const diffFence = text.match(/```diff\s*([\s\S]*?)```/i);
  if (diffFence?.[1]) return diffFence[1].trim();

  const genericFence = text.match(/```\s*([\s\S]*?)```/);
  if (
    genericFence?.[1] &&
    (genericFence[1].includes("--- ") || genericFence[1].includes("+++ "))
  ) {
    return genericFence[1].trim();
  }

  if (text.includes("--- ") && text.includes("+++ ")) return text.trim();
  return null;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastError: any;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const status = error?.status || error?.response?.status;
      const message = error?.message || String(error);
      logger.warn(
        { attempt: i + 1, status, message },
        "LLM request failed, retrying...",
      );

      if (status === 401 || status === 403 || status === 404) {
        // Don't retry on auth or not found errors
        break;
      }

      if (i === retries) break;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastError;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export class OpenAiClient implements LlmClient {
  private chatClient: OpenAI;
  private embeddingClient: OpenAI;

  constructor(
    apiKey: string,
    private model: string,
    private embeddingModel: string,
    baseURL?: string,
    embeddingApiKey?: string,
    embeddingBaseURL?: string,
  ) {
    this.chatClient = new OpenAI({ apiKey, baseURL });
    this.embeddingClient = new OpenAI({
      apiKey: embeddingApiKey ?? apiKey,
      baseURL: embeddingBaseURL ?? baseURL,
    });
  }

  async analyze(input: {
    task: string;
    contextChunks: Array<{ id: string; content: string; file?: string }>;
    constraints: string[];
  }): Promise<string> {
    const prompt = buildAnalysisPrompt({
      task: input.task,
      context: input.contextChunks,
      constraints: input.constraints,
    });

    const response = await withRetry(() =>
      this.chatClient.chat.completions.create(
        {
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
        },
        { timeout: 120_000 },
      ),
    );

    return outputText(response).trim();
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

    logger.info(
      {
        promptLength: prompt.length,
        model: this.model,
        contextCount: input.contextChunks.length,
      },
      "sending patch proposal request",
    );

    const response = await withRetry(() =>
      this.chatClient.chat.completions.create(
        {
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        },
        { timeout: 180_000 },
      ),
    );

    logger.info(
      {
        response,
      },
      "response",
    );

    const text = outputText(response);
    const maybeObj = extractJsonObject(text);
    if (maybeObj) {
      try {
        return patchProposalSchema.parse(maybeObj);
      } catch (err) {
        logger.error(
          { err, text: text.slice(0, 500) },
          "failed to parse patch proposal JSON",
        );
        throw err;
      }
    }

    const diff = extractDiffFromText(text);
    if (!diff) {
      logger.error(
        { text: text.slice(0, 1000) },
        "invalid LLM output - no JSON or diff found",
      );
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
      this.chatClient.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "user",
            content: [
              `任务: ${input.task}`,
              `验证日志: ${input.verifyLog}`,
              `最近补丁: ${input.recentPatches.join("\n---\n")}`,
              "请用简洁中文总结根因和下一步修复建议（120字内）。",
            ].join("\n"),
          },
        ],
        temperature: 0,
      }),
    );
    return outputText(response);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const maxBatchSize = 10;
    const batches = chunkArray(texts, maxBatchSize);
    const result: number[][] = [];

    for (const batch of batches) {
      const response = await withRetry(() =>
        this.embeddingClient.embeddings.create({
          model: this.embeddingModel,
          input: batch,
        }),
      );
      result.push(...response.data.map(item => item.embedding));
    }

    return result;
  }
}
