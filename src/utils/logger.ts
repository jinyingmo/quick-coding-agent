import pino from "pino";
import fs from "node:fs";
import path from "node:path";

function hydrateEnvFromDotenv(): void {
  const dotenvPath = path.resolve(".env");
  if (!fs.existsSync(dotenvPath)) return;
  const text = fs.readFileSync(dotenvPath, "utf-8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
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
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

hydrateEnvFromDotenv();

const level = process.env.LOG_LEVEL ?? "info";

export const logger = pino({
  level,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});
