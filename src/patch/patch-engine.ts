import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CommandRunner } from "../tools/command-runner.js";
import { PatchValidator } from "./patch-validator.js";

type HunkLine = {
  type: "context" | "add" | "remove";
  content: string;
};

type Hunk = {
  oldStart: number;
  lines: HunkLine[];
};

type FilePatch = {
  filePath: string;
  hunks: Hunk[];
};

export interface ApplyResult {
  ok: boolean;
  changedFiles: string[];
  rollbackId?: string;
  error?: string;
}

function normalizePatchText(input: string): string {
  const text = input.trim();
  if (!text) return "";

  const diffFence = text.match(/```diff\s*([\s\S]*?)```/i);
  if (diffFence?.[1]) return diffFence[1].trim();

  const anyFence = text.match(/```\s*([\s\S]*?)```/);
  if (anyFence?.[1] && anyFence[1].includes("--- ") && anyFence[1].includes("+++ ")) {
    return anyFence[1].trim();
  }

  return text;
}

function parsePatch(patch: string, cwd: string): FilePatch[] {
  const lines = patch.split("\n");
  const filePatches: FilePatch[] = [];
  let current: FilePatch | null = null;
  let currentHunk: Hunk | null = null;

  const flushHunk = (): void => {
    if (!current || !currentHunk) return;
    current.hunks.push(currentHunk);
    currentHunk = null;
  };

  const flushFile = (): void => {
    if (!current) return;
    flushHunk();
    if (current.hunks.length > 0) filePatches.push(current);
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      continue;
    }

    if (line.startsWith("+++ ")) {
      flushHunk();
      let raw = line.slice(4).trim();
      if (raw.startsWith("b/")) raw = raw.slice(2);
      if (raw === "/dev/null") continue;
      current = {
        filePath: path.resolve(cwd, raw),
        hunks: [],
      };
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (!current) continue;
      flushHunk();
      const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      const oldStart = header ? Number(header[1]) : 1;
      currentHunk = {
        oldStart,
        lines: [],
      };
      continue;
    }

    if (!currentHunk) continue;
    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1) });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "remove", content: line.slice(1) });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", content: line.slice(1) });
    }
  }

  flushFile();
  return filePatches;
}

function getAnchorLine(hunk: Hunk): string | null {
  for (const line of hunk.lines) {
    if (line.type === "context" || line.type === "remove") return line.content;
  }
  return null;
}

function findNearestStart(lines: string[], preferred: number, anchor: string | null): number {
  const base = Math.max(0, preferred);
  if (!anchor) return base;
  if (lines[base] === anchor) return base;
  for (let delta = 1; delta <= 50; delta++) {
    const left = base - delta;
    const right = base + delta;
    if (left >= 0 && lines[left] === anchor) return left;
    if (right < lines.length && lines[right] === anchor) return right;
  }
  return base;
}

function applyHunk(lines: string[], hunk: Hunk, shift: number): { nextShift: number; error?: string } {
  let idx = findNearestStart(lines, hunk.oldStart - 1 + shift, getAnchorLine(hunk));
  let localShift = 0;

  for (const line of hunk.lines) {
    if (line.type === "context") {
      if (lines[idx] !== line.content) {
        return { nextShift: shift + localShift, error: `context mismatch: expected "${line.content}" at ${idx + 1}` };
      }
      idx += 1;
    } else if (line.type === "remove") {
      if (lines[idx] !== line.content) {
        return { nextShift: shift + localShift, error: `remove mismatch: expected "${line.content}" at ${idx + 1}` };
      }
      lines.splice(idx, 1);
      localShift -= 1;
    } else {
      lines.splice(idx, 0, line.content);
      idx += 1;
      localShift += 1;
    }
  }

  return { nextShift: shift + localShift };
}

export class PatchEngine {
  private rollbackStore = new Map<string, Map<string, string>>();
  private gitRollbackStore = new Map<string, string>();

  constructor(
    private cwd: string,
    private runner: CommandRunner,
    private validator = new PatchValidator()
  ) {}

  private extractChangedFilesFromFilePatches(filePatches: FilePatch[]): string[] {
    return filePatches.map((p) => p.filePath);
  }

  private async canUseGitApply(): Promise<boolean> {
    const result = await this.runner.run("git", ["rev-parse", "--is-inside-work-tree"], 10_000);
    return result.ok && result.stdout.trim() === "true";
  }

  private async applyByGit(patch: string): Promise<ApplyResult> {
    const tempFile = path.join(os.tmpdir(), `agent_patch_${Date.now()}_${randomUUID()}.diff`);
    await fs.writeFile(tempFile, patch, "utf-8");
    const check = await this.runner.run("git", ["apply", "--check", tempFile], 30_000);
    if (!check.ok) {
      return { ok: false, changedFiles: [], error: check.combined };
    }
    const apply = await this.runner.run("git", ["apply", tempFile], 30_000);
    if (!apply.ok) {
      return { ok: false, changedFiles: [], error: apply.combined };
    }
    const files = parsePatch(patch, this.cwd).map((x) => x.filePath);
    const rollbackId = randomUUID();
    this.gitRollbackStore.set(rollbackId, patch);
    return { ok: true, changedFiles: files, rollbackId };
  }

  private async applyByFs(patch: string): Promise<ApplyResult> {
    const filePatches = parsePatch(patch, this.cwd);
    if (filePatches.length === 0) {
      return { ok: false, changedFiles: [], error: "No file patches found in diff" };
    }

    const snapshots = new Map<string, string>();
    for (const fp of filePatches) {
      if (!fp.filePath.startsWith(path.resolve(this.cwd))) {
        return { ok: false, changedFiles: [], error: `Refusing to patch file outside cwd: ${fp.filePath}` };
      }
      const original = await fs.readFile(fp.filePath, "utf-8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      snapshots.set(fp.filePath, original);
    }

    for (const fp of filePatches) {
      const original = snapshots.get(fp.filePath) ?? "";
      const lines = original.split("\n");
      let shift = 0;
      for (const hunk of fp.hunks) {
        const result = applyHunk(lines, hunk, shift);
        if (result.error) {
          return {
            ok: false,
            changedFiles: [],
            error: `Failed applying hunk in ${fp.filePath}: ${result.error}`,
          };
        }
        shift = result.nextShift;
      }
      await fs.mkdir(path.dirname(fp.filePath), { recursive: true });
      await fs.writeFile(fp.filePath, lines.join("\n"), "utf-8");
    }

    const rollbackId = randomUUID();
    this.rollbackStore.set(rollbackId, snapshots);
    return {
      ok: true,
      changedFiles: this.extractChangedFilesFromFilePatches(filePatches),
      rollbackId,
    };
  }

  async rollback(rollbackId?: string): Promise<void> {
    if (!rollbackId) return;

    const gitPatch = this.gitRollbackStore.get(rollbackId);
    if (gitPatch) {
      const tempFile = path.join(os.tmpdir(), `agent_rollback_${Date.now()}_${randomUUID()}.diff`);
      await fs.writeFile(tempFile, gitPatch, "utf-8");
      await this.runner.run("git", ["apply", "-R", tempFile], 30_000);
      this.gitRollbackStore.delete(rollbackId);
      return;
    }

    const snapshots = this.rollbackStore.get(rollbackId);
    if (!snapshots) return;
    for (const [file, content] of snapshots.entries()) {
      await fs.writeFile(file, content, "utf-8");
    }
    this.rollbackStore.delete(rollbackId);
  }

  async apply(patchInput: string): Promise<ApplyResult> {
    const patch = normalizePatchText(patchInput);
    const validated = this.validator.validate(patch);
    if (!validated.ok) {
      return { ok: false, changedFiles: [], error: validated.error };
    }

    if (await this.canUseGitApply()) {
      return this.applyByGit(patch);
    }
    return this.applyByFs(patch);
  }
}
