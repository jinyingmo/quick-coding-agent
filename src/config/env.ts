import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5.2"),
  OPENAI_EMBEDDING_API_KEY: z.string().optional(),
  OPENAI_EMBEDDING_BASE_URL: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-large"),
  MEMORY_DIR: z.string().default(".agent/memory"),
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
  CONTEXT_CHAR_BUDGET: z.coerce.number().int().positive().default(20_000),
  RETRIEVE_TOP_K: z.coerce.number().int().positive().default(12),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof envSchema>;

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Very naive inline comment strip
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) {
        value = value.slice(0, hashIdx).trim();
      }
    }
    out[key] = value;
  }
  return out;
}

function hydrateProcessEnvFromFile(filePath: string): void {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) return;
  const parsed = parseDotenv(fs.readFileSync(absolute, "utf-8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}

export function loadEnv(): Env {
  hydrateProcessEnvFromFile(".env");
  return envSchema.parse(process.env);
}
