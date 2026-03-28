import fs from "node:fs/promises";
import path from "node:path";
import { CommandRunner } from "./command-runner.js";

export interface SearchHit {
  file: string;
  line: number;
  content: string;
}

export class SearchTools {
  constructor(
    private cwd: string,
    private runner: CommandRunner
  ) {}

  async rg(query: string, max = 50): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    const result = await this.runner.run("rg", [
      "--line-number",
      "--no-heading",
      "--max-count",
      String(max),
      query,
      ".",
    ]);
    if (!result.ok || !result.stdout.trim()) return [];
    return result.stdout
      .split("\n")
      .map((line) => {
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (!match) return null;
        return {
          file: path.resolve(this.cwd, match[1]),
          line: Number(match[2]),
          content: match[3],
        } satisfies SearchHit;
      })
      .filter((x): x is SearchHit => Boolean(x));
  }

  async readSnippet(file: string, line: number, radius = 20): Promise<string> {
    const text = await fs.readFile(file, "utf-8");
    const lines = text.split("\n");
    const start = Math.max(0, line - radius - 1);
    const end = Math.min(lines.length, line + radius);
    return lines.slice(start, end).join("\n");
  }
}
