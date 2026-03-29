/**
 * Result Renderer - Formats and displays agent results in a user-friendly way
 */

import type { TaskResult, TaskResultSuccess, TaskResultAnalysis, TaskResultFailed } from "../core/types.js";
import chalk from "chalk";
import {
  icons,
  header,
  section,
  kv,
  listItem,
  codeBlock,
  box,
  divider,
  blank,
  elapsed,
} from "./components.js";

export interface RenderOptions {
  showReasoning?: boolean;
  showPatch?: boolean;
  showFiles?: boolean;
  showTests?: boolean;
  verbose?: boolean;
}

/**
 * Render a successful task result (patch mode)
 */
export function renderSuccessResult(
  result: TaskResultSuccess,
  startTime: number,
  options: RenderOptions = {}
): void {
  blank();
  divider("═", 60);
  
  // Main success header
  process.stdout.write(
    `\n${chalk.bgGreen.bold(" ✓ SUCCESS ")}\n\n`
  );
  
  // Mode indicator
  if (result.mode) {
    const modeColors: Record<string, (text: string) => string> = {
      analysis: chalk.cyan,
      patch: chalk.magenta,
      verification: chalk.yellow,
    };
    const modeColor = modeColors[result.mode] || chalk.white;
    process.stdout.write(`${chalk.dim("Mode:")} ${modeColor(result.mode)}\n`);
  }
  
  // Attempt number
  if (result.attempt) {
    kv("Attempt", result.attempt.toString());
  }
  
  blank();
  
  // Summary
  if (result.summary) {
    section("Summary");
    const wrappedSummary = wrapText(result.summary, 70);
    process.stdout.write(`${wrappedSummary}\n`);
  }
  
  // Files changed
  if (result.changedFiles && result.changedFiles.length > 0 && options.showFiles !== false) {
    section("Files Changed");
    for (const file of result.changedFiles) {
      process.stdout.write(`  ${chalk.green(icons.success)} ${file}\n`);
    }
    blank();
  }
  
  // Elapsed time
  divider();
  elapsed(startTime, "Total time");
  blank();
}

/**
 * Render a failed task result
 */
export function renderFailureResult(
  result: TaskResultFailed,
  startTime: number,
  options: RenderOptions = {}
): void {
  blank();
  divider("═", 60);
  
  // Main failure header
  process.stdout.write(
    `\n${chalk.bgRed.bold(" ✗ FAILED ")}\n\n`
  );
  
  // Reason
  if (result.reason) {
    section("Failure Reason");
    process.stdout.write(`${chalk.red(result.reason)}\n`);
    blank();
  }
  
  // Elapsed time
  divider();
  elapsed(startTime, "Total time");
  blank();
}

/**
 * Render analysis result
 */
export function renderAnalysisResult(
  analysis: string,
  startTime: number,
  options: RenderOptions = {}
): void {
  blank();
  divider("═", 60);
  
  process.stdout.write(
    `\n${chalk.bgCyan.bold(" ℹ ANALYSIS ")}\n\n`
  );
  
  section("Analysis Result");
  process.stdout.write(`${analysis}\n`);
  
  blank();
  divider();
  elapsed(startTime, "Analysis time");
  blank();
}

/**
 * Render patch preview
 */
export function renderPatchPreview(
  patch: string,
  files: string[],
  reasoning?: string
): void {
  section("Patch Preview");
  
  if (reasoning) {
    process.stdout.write(`${chalk.dim("Reasoning:")}\n`);
    process.stdout.write(`${chalk.italic(reasoning)}\n\n`);
  }
  
  if (files.length > 0) {
    process.stdout.write(`${chalk.dim("Affected files:")}\n`);
    for (const file of files) {
      listItem(file);
    }
    blank();
  }
  
  if (patch) {
    process.stdout.write(`${chalk.dim("Patch:")}\n`);
    renderDiffPatch(patch);
  }
}

/**
 * Render a unified diff patch
 */
export function renderDiffPatch(patch: string): void {
  const lines = patch.split("\n");
  
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      process.stdout.write(`${chalk.bold.cyan(line)}\n`);
    } else if (line.startsWith("@@")) {
      process.stdout.write(`${chalk.magenta(line)}\n`);
    } else if (line.startsWith("+")) {
      process.stdout.write(`${chalk.green(line)}\n`);
    } else if (line.startsWith("-")) {
      process.stdout.write(`${chalk.red(line)}\n`);
    } else if (line.startsWith(" ")) {
      process.stdout.write(`${chalk.dim(line)}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
  blank();
}

/**
 * Render verification results
 */
export function renderVerificationResult(
  passed: boolean,
  output: string,
  tests?: { name: string; passed: boolean }[]
): void {
  const icon = passed ? chalk.green(icons.success) : chalk.red(icons.error);
  const status = passed ? "PASSED" : "FAILED";
  const statusColor = passed ? chalk.green : chalk.red;
  
  process.stdout.write(`\n${icon} ${chalk.bold(statusColor(status))}\n`);
  
  if (tests && tests.length > 0) {
    blank();
    for (const test of tests) {
      const testIcon = test.passed ? chalk.green("✓") : chalk.red("✗");
      process.stdout.write(`  ${testIcon} ${test.name}\n`);
    }
  }
  
  if (!passed && output) {
    blank();
    section("Output");
    codeBlock(output, "log");
  }
}

/**
 * Render a task result (auto-detect type)
 */
export function renderTaskResult(
  result: TaskResult,
  startTime: number,
  options: RenderOptions = {}
): void {
  if (result.ok) {
    if (result.mode === "analysis") {
      renderAnalysisResult(result.summary || "", startTime, options);
    } else {
      renderSuccessResult(result, startTime, options);
    }
  } else {
    renderFailureResult(result, startTime, options);
  }
}

/**
 * Wrap text to a maximum width
 */
function wrapText(text: string, width: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";
  
  for (const word of words) {
    if (currentLine.length + word.length + 1 <= width) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  
  if (currentLine) lines.push(currentLine);
  return lines.join("\n");
}

/**
 * Render a simple message box
 */
export function messageBox(
  message: string,
  type: "info" | "success" | "warning" | "error" = "info"
): void {
  box(type.toUpperCase(), message, type);
}

/**
 * Render operation steps
 */
export function renderSteps(
  steps: { name: string; status: "pending" | "running" | "done" | "failed" }[]
): void {
  for (const step of steps) {
    let icon: string;
    
    switch (step.status) {
      case "pending":
        icon = chalk.dim("○");
        break;
      case "running":
        icon = chalk.cyan("◐");
        break;
      case "done":
        icon = chalk.green("●");
        break;
      case "failed":
        icon = chalk.red("●");
        break;
    }
    
    process.stdout.write(`${icon} ${step.name}\n`);
  }
}
