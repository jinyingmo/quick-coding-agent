/**
 * Agent Progress UI - Visualizes agent operations in real-time
 */

import chalk from "chalk";
import ora, { type Ora } from "ora";
import type { TaskResult } from "../core/types.js";
import {
  status,
  section,
  kv,
  divider,
  blank,
  header,
  box,
} from "./components.js";

export type AgentPhase = 
  | "init"
  | "retrieval"
  | "analysis"
  | "llm-call"
  | "patch"
  | "verification"
  | "memory"
  | "complete";

export interface ProgressState {
  phase: AgentPhase;
  attempt: number;
  maxAttempts: number;
  message: string;
  startTime: number;
  phaseStartTime: number;
  steps: StepInfo[];
}

export interface StepInfo {
  name: string;
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
}

const phaseLabels: Record<AgentPhase, string> = {
  init: "Initializing",
  retrieval: "Retrieving context",
  analysis: "Analyzing task",
  "llm-call": "Calling LLM",
  patch: "Applying patch",
  verification: "Verifying changes",
  memory: "Updating memory",
  complete: "Complete",
};

const phaseIcons: Record<AgentPhase, string> = {
  init: "⚙",
  retrieval: "🔍",
  analysis: "📊",
  "llm-call": "🤖",
  patch: "✏️",
  verification: "✓",
  memory: "💾",
  complete: "🎉",
};

/**
 * Agent Progress UI Manager
 */
export class AgentProgressUI {
  private state: ProgressState;
  private enabled: boolean;
  private spinner: Ora | null = null;

  constructor(enabled = true) {
    this.enabled = enabled && process.stdout.isTTY;
    this.state = {
      phase: "init",
      attempt: 1,
      maxAttempts: 4,
      message: "",
      startTime: Date.now(),
      phaseStartTime: Date.now(),
      steps: [],
    };
  }

  /**
   * Start the progress display
   */
  start(task: string, maxAttempts: number): void {
    this.state.maxAttempts = maxAttempts;
    this.state.startTime = Date.now();
    
    if (!this.enabled) {
      process.stdout.write(`\n${chalk.bold("Task:")} ${task}\n\n`);
      return;
    }

    header("Quick Coding Agent", task);
    this.showPhase("init", "Preparing agent...");
  }

  /**
   * Update the current phase
   */
  setPhase(phase: AgentPhase, message?: string): void {
    const now = Date.now();
    const phaseDuration = now - this.state.phaseStartTime;
    
    // Log previous phase completion
    if (this.state.phase !== "init" && this.state.phase !== phase) {
      this.logPhaseComplete(this.state.phase, phaseDuration);
    }
    
    this.state.phase = phase;
    this.state.phaseStartTime = now;
    this.state.message = message || phaseLabels[phase];
    
    const displayMessage = this.formatPhaseMessage();
    
    if (this.enabled) {
      if (this.spinner && this.spinner.isSpinning) {
        this.spinner.text = displayMessage;
      } else {
        this.spinner = ora({
          text: displayMessage,
          spinner: "dots",
          color: "cyan",
        }).start();
      }
    } else {
      process.stdout.write(`${chalk.dim(`[${phase}]`)} ${message || phaseLabels[phase]}\n`);
    }
  }

  /**
   * Update attempt number
   */
  setAttempt(attempt: number): void {
    this.state.attempt = attempt;
    this.updateDisplay();
  }

  /**
   * Update steps
   */
  setSteps(steps: StepInfo[]): void {
    this.state.steps = steps;
    this.updateDisplay();
  }

  /**
   * Update a single step
   */
  updateStep(index: number, step: Partial<StepInfo>): void {
    if (this.state.steps[index]) {
      this.state.steps[index] = { ...this.state.steps[index], ...step };
      this.updateDisplay();
    }
  }

  /**
   * Show retrieval progress
   */
  showRetrievalProgress(retrieved: number, memoryHits: number): void {
    this.setPhase("retrieval", `Found ${retrieved} chunks, ${memoryHits} memory hits`);
  }

  /**
   * Show LLM call progress
   */
  showLLMProgress(operation: string): void {
    this.setPhase("llm-call", operation);
  }

  /**
   * Show patch progress
   */
  showPatchProgress(file: string): void {
    this.setPhase("patch", `Applying to ${file}`);
  }

  /**
   * Show verification progress
   */
  showVerificationProgress(tests: string[]): void {
    this.setPhase("verification", `Running ${tests.length} test(s)`);
  }

  /**
   * Complete with success
   */
  completeSuccess(result: Extract<TaskResult, { ok: true }>): void {
    const totalDuration = Date.now() - this.state.startTime;
    
    if (this.enabled && this.spinner) {
      this.spinner.succeed("Task completed successfully");
      this.spinner = null;
    }
    
    blank();
    const attemptCount = "attempt" in result ? result.attempt : this.state.attempt;
    this.showSummary(true, totalDuration, attemptCount);
  }

  /**
   * Complete with failure
   */
  completeFailure(reason: string): void {
    const totalDuration = Date.now() - this.state.startTime;
    
    if (this.enabled && this.spinner) {
      this.spinner.fail(`Task failed: ${reason}`);
      this.spinner = null;
    }
    
    blank();
    this.showSummary(false, totalDuration, this.state.attempt);
  }

  /**
   * Show an error
   */
  error(message: string): void {
    if (this.enabled && this.spinner) {
      this.spinner.fail(message);
      this.spinner = null;
    } else {
      status("error", message);
    }
  }

  /**
   * Show a warning
   */
  warn(message: string): void {
    status("warning", message);
  }

  /**
   * Show info message
   */
  info(message: string): void {
    if (!this.enabled) {
      status("info", message);
    }
  }

  /**
   * Stop any running spinner (cleanup)
   */
  stop(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  // Private methods

  private showPhase(phase: AgentPhase, message: string): void {
    this.state.phase = phase;
    this.state.message = message;
    this.state.phaseStartTime = Date.now();
    
    if (this.enabled) {
      this.spinner = ora({
        text: this.formatPhaseMessage(),
        spinner: "dots",
        color: "cyan",
      }).start();
    }
  }

  private formatPhaseMessage(): string {
    const icon = phaseIcons[this.state.phase];
    const label = phaseLabels[this.state.phase];
    const attemptInfo = this.state.attempt > 1 
      ? ` ${chalk.dim(`(attempt ${this.state.attempt}/${this.state.maxAttempts})`)}` 
      : "";
    
    return `${icon} ${label}${attemptInfo}`;
  }

  private updateDisplay(): void {
    if (this.enabled && this.spinner && this.spinner.isSpinning) {
      this.spinner.text = this.formatPhaseMessage();
    }
  }

  private logPhaseComplete(phase: AgentPhase, duration: number): void {
    const ms = duration.toFixed(0);
    // Silent logging for now, could be verbose mode
  }

  private showSummary(success: boolean, duration: number, attempts: number): void {
    const seconds = (duration / 1000).toFixed(2);
    
    section("Execution Summary");
    kv("Status", success ? chalk.green("Success") : chalk.red("Failed"));
    kv("Duration", `${seconds}s`);
    kv("Attempts", attempts.toString());
    blank();
  }
}

/**
 * Create a global progress UI instance
 */
export function createProgressUI(enabled = true): AgentProgressUI {
  return new AgentProgressUI(enabled);
}

/**
 * Quick one-off progress display
 */
export async function withProgress<T>(
  message: string,
  action: () => Promise<T>
): Promise<T> {
  const spinner = ora(message).start();
  try {
    const result = await action();
    spinner.succeed();
    return result;
  } catch (error) {
    spinner.fail();
    throw error;
  }
}
