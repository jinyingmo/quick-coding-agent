import { execa, type ExecaError } from "execa";

export interface CommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf-8");
  if (Array.isArray(value)) return value.map((v) => stringifyOutput(v)).join("\n");
  return String(value);
}

export class CommandRunner {
  constructor(private cwd: string) {}

  async run(
    command: string,
    args: string[],
    timeoutMs = 120_000
  ): Promise<CommandResult> {
    try {
      const result = await execa(command, args, {
        cwd: this.cwd,
        timeout: timeoutMs,
        reject: true,
      });
      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return {
        ok: true,
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
        combined,
      };
    } catch (error) {
      const e = error as ExecaError;
      const stdout = stringifyOutput(e.stdout);
      const stderr = stringifyOutput(e.stderr ?? e.shortMessage ?? String(error));
      return {
        ok: false,
        exitCode: e.exitCode ?? 1,
        stdout,
        stderr,
        combined: [stdout, stderr].filter(Boolean).join("\n"),
      };
    }
  }
}
