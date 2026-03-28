import fs from "node:fs";
import path from "node:path";

export interface VerifyStage {
  name: "typecheck" | "lint" | "target-test" | "full-test";
  command: string;
  args: string[];
  timeoutMs?: number;
}

type PackageJson = {
  scripts?: Record<string, string>;
};

function readPackageJson(cwd: string): PackageJson | null {
  const file = path.resolve(cwd, "package.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as PackageJson;
  } catch {
    return null;
  }
}

function hasLintConfig(cwd: string): boolean {
  const candidates = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.yaml",
    ".eslintrc.yml",
  ];
  return candidates.some((name) => fs.existsSync(path.resolve(cwd, name)));
}

export function defaultPipeline(cwd: string, targetTests: string[]): VerifyStage[] {
  const pkg = readPackageJson(cwd);
  const scripts = pkg?.scripts ?? {};
  const stages: VerifyStage[] = [];

  if (scripts.typecheck) {
    stages.push({
      name: "typecheck",
      command: "pnpm",
      args: ["run", "typecheck"],
      timeoutMs: 180_000,
    });
  }

  if (scripts.lint && hasLintConfig(cwd)) {
    stages.push({
      name: "lint",
      command: "pnpm",
      args: ["run", "lint"],
      timeoutMs: 180_000,
    });
  }

  if (scripts.test) {
    if (targetTests.length > 0) {
      stages.push({
        name: "target-test",
        command: "pnpm",
        args: ["run", "test", "--", ...targetTests],
        timeoutMs: 300_000,
      });
    } else {
      stages.push({
        name: "target-test",
        command: "pnpm",
        args: ["run", "test"],
        timeoutMs: 300_000,
      });
    }
  }

  return stages;
}
