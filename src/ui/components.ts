/**
 * Terminal UI Components for Agent Visualization
 * Uses battle-tested npm packages for reliable terminal output
 */

import process from "node:process";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import cliTruncate from "cli-truncate";
import logUpdate from "log-update";

// Re-export chalk as colors for convenience
export const colors = {
  reset: chalk.reset,
  bold: chalk.bold,
  dim: chalk.dim,
  italic: chalk.italic,
  underline: chalk.underline,
  
  // Foreground colors
  black: chalk.black,
  red: chalk.red,
  green: chalk.green,
  yellow: chalk.yellow,
  blue: chalk.blue,
  magenta: chalk.magenta,
  cyan: chalk.cyan,
  white: chalk.white,
  
  // Bright foreground colors
  brightRed: chalk.redBright,
  brightGreen: chalk.greenBright,
  brightYellow: chalk.yellowBright,
  brightBlue: chalk.blueBright,
  brightMagenta: chalk.magentaBright,
  brightCyan: chalk.cyanBright,
  brightWhite: chalk.whiteBright,
  
  // Background colors
  bgBlack: chalk.bgBlack,
  bgRed: chalk.bgRed,
  bgGreen: chalk.bgGreen,
  bgYellow: chalk.bgYellow,
  bgBlue: chalk.bgBlue,
  bgMagenta: chalk.bgMagenta,
  bgCyan: chalk.bgCyan,
  bgWhite: chalk.bgWhite,
} as const;

// Status icons
export const icons = {
  success: "✓",
  error: "✗",
  warning: "⚠",
  info: "ℹ",
  arrow: "→",
  bullet: "•",
  check: "✔",
  cross: "✘",
} as const;

// Spinner instance
let spinner: Ora | null = null;

/**
 * Get terminal width safely
 */
function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

/**
 * Truncate text to fit terminal width
 */
export function truncate(text: string, maxWidth?: number): string {
  const width = maxWidth ?? getTerminalWidth();
  return cliTruncate(text, width);
}

/**
 * Start a spinner with the given text
 */
export function startSpinner(text: string): void {
  // Stop existing spinner if any
  stopSpinner(false);
  
  if (process.stdout.isTTY) {
    spinner = ora({
      text,
      spinner: "dots",
      color: "cyan",
    }).start();
  } else {
    // Non-TTY fallback
    process.stdout.write(`${chalk.cyan("⠋")} ${text}\n`);
  }
}

/**
 * Update spinner text
 */
export function updateSpinner(text: string): void {
  if (spinner && spinner.isSpinning) {
    spinner.text = text;
  }
}

/**
 * Stop the spinner and optionally show final message
 */
export function stopSpinner(success: boolean, message?: string): void {
  if (spinner) {
    if (spinner.isSpinning) {
      if (message) {
        spinner[success ? "succeed" : "fail"](message);
      } else {
        spinner.stop();
      }
    }
    spinner = null;
  }
}

/**
 * Print a status message with icon
 */
export function status(type: "success" | "error" | "warning" | "info", message: string): void {
  const config = {
    success: { icon: icons.success, color: chalk.green },
    error: { icon: icons.error, color: chalk.red },
    warning: { icon: icons.warning, color: chalk.yellow },
    info: { icon: icons.info, color: chalk.blue },
  };
  
  const { icon, color } = config[type];
  process.stdout.write(`${color(icon)} ${message}\n`);
}

/**
 * Print a section header
 */
export function header(title: string, subtitle?: string): void {
  const line = "─".repeat(Math.max(title.length + 4, 40));
  process.stdout.write(`\n${chalk.cyanBright(`┌${line}┐`)}\n`);
  process.stdout.write(`${chalk.cyanBright("│")}  ${chalk.bold(title)}${" ".repeat(Math.max(0, 36 - title.length))}${chalk.cyanBright("│")}\n`);
  if (subtitle) {
    process.stdout.write(`${chalk.cyanBright("│")}  ${chalk.dim(subtitle)}${" ".repeat(Math.max(0, 36 - subtitle.length))}${chalk.cyanBright("│")}\n`);
  }
  process.stdout.write(`${chalk.cyanBright(`└${line}┘`)}\n\n`);
}

/**
 * Print a simple section title
 */
export function section(title: string): void {
  process.stdout.write(`\n${chalk.bold.whiteBright(`▸ ${title}`)}\n`);
  process.stdout.write(`${chalk.dim("─".repeat(40))}\n`);
}

/**
 * Print a key-value pair
 */
export function kv(key: string, value: string, indent = 0): void {
  const indentStr = " ".repeat(indent);
  process.stdout.write(`${indentStr}${chalk.cyan(`${key}:`)} ${value}\n`);
}

/**
 * Print a list item
 */
export function listItem(text: string, indent = 0): void {
  const indentStr = " ".repeat(indent);
  process.stdout.write(`${indentStr}${chalk.dim(icons.bullet)} ${text}\n`);
}

/**
 * Print a code block
 */
export function codeBlock(code: string, language?: string): void {
  const lines = code.split("\n");
  const maxLineNum = lines.length.toString().length;
  
  process.stdout.write(`${chalk.dim("─".repeat(50))}\n`);
  if (language) {
    process.stdout.write(`${chalk.dim(`  ${language}`)}\n\n`);
  }
  
  lines.forEach((line, i) => {
    const lineNum = (i + 1).toString().padStart(maxLineNum, " ");
    process.stdout.write(`${chalk.dim(`  ${lineNum} │`)} ${line}\n`);
  });
  
  process.stdout.write(`${chalk.dim("─".repeat(50))}\n`);
}

/**
 * Print a box with content
 */
export function box(title: string, content: string, style: "info" | "success" | "error" | "warning" = "info"): void {
  const styleColors = {
    info: chalk.blue,
    success: chalk.green,
    error: chalk.red,
    warning: chalk.yellow,
  };
  
  const borderColor = styleColors[style];
  const lines = content.split("\n");
  const maxLen = Math.max(title.length, ...lines.map(l => l.length), 20);
  const width = maxLen + 4;
  
  process.stdout.write(`\n${borderColor(`┌${"─".repeat(width)}┐`)}\n`);
  process.stdout.write(`${borderColor("│")} ${chalk.bold(title)}${" ".repeat(width - title.length - 1)}${borderColor("│")}\n`);
  process.stdout.write(`${borderColor(`├${"─".repeat(width)}┤`)}\n`);
  
  for (const line of lines) {
    process.stdout.write(`${borderColor("│")} ${line}${" ".repeat(width - line.length - 1)}${borderColor("│")}\n`);
  }
  
  process.stdout.write(`${borderColor(`└${"─".repeat(width)}┘`)}\n`);
}

/**
 * Print a progress bar
 */
export function progressBar(current: number, total: number, label?: string): void {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * 20);
  const empty = 20 - filled;
  
  const bar = `${chalk.green("█".repeat(filled))}${chalk.dim("░".repeat(empty))}`;
  const labelText = label ? ` ${label}` : "";
  
  logUpdate(`${bar} ${percent}%${labelText}`);
}

/**
 * Print a table
 */
export function table(headers: string[], rows: string[][]): void {
  const colWidths = headers.map((h, i) => 
    Math.max(h.length, ...rows.map(r => r[i]?.length ?? 0))
  );
  
  // Header
  const headerRow = headers.map((h, i) => chalk.bold(h.padEnd(colWidths[i]))).join(" │ ");
  const separator = colWidths.map(w => "─".repeat(w)).join("─┼─");
  
  process.stdout.write(`\n${chalk.dim(separator)}\n`);
  process.stdout.write(`  ${headerRow}\n`);
  process.stdout.write(`${chalk.dim(separator)}\n`);
  
  // Rows
  for (const row of rows) {
    const rowStr = row.map((cell, i) => cell.padEnd(colWidths[i])).join(" │ ");
    process.stdout.write(`  ${rowStr}\n`);
  }
  
  process.stdout.write(`${chalk.dim(separator)}\n`);
}

/**
 * Print a diff-like view
 */
export function diffView(changes: { type: "add" | "remove" | "context"; line: string }[]): void {
  for (const change of changes) {
    switch (change.type) {
      case "add":
        process.stdout.write(`${chalk.green(`+ ${change.line}`)}\n`);
        break;
      case "remove":
        process.stdout.write(`${chalk.red(`- ${change.line}`)}\n`);
        break;
      case "context":
        process.stdout.write(`${chalk.dim(`  ${change.line}`)}\n`);
        break;
    }
  }
}

/**
 * Print elapsed time
 */
export function elapsed(startTime: number, label = "Elapsed"): void {
  const ms = Date.now() - startTime;
  const seconds = (ms / 1000).toFixed(2);
  process.stdout.write(`${chalk.dim(`${label}:`)} ${seconds}s\n`);
}

/**
 * Clear the terminal screen
 */
export function clear(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }
}

/**
 * Print a divider line
 */
export function divider(char = "─", length = 50): void {
  process.stdout.write(`${chalk.dim(char.repeat(length))}\n`);
}

/**
 * Print blank line
 */
export function blank(): void {
  process.stdout.write("\n");
}
