import { CommandRunner } from "./command-runner.js";

export class GitTools {
  constructor(private runner: CommandRunner) {}

  async currentCommit(): Promise<string | null> {
    const result = await this.runner.run("git", ["rev-parse", "HEAD"], 15_000);
    if (!result.ok) return null;
    return result.stdout.trim() || null;
  }

  async changedFiles(): Promise<string[]> {
    const result = await this.runner.run("git", ["status", "--porcelain"], 15_000);
    if (!result.ok) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
  }
}
