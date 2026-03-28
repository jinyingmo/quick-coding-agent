import { CommandRunner } from "../tools/command-runner.js";
import { defaultPipeline } from "./pipelines.js";

export interface VerifyResult {
  ok: boolean;
  stage: "typecheck" | "lint" | "target-test" | "full-test";
  summary: string;
  logs: string;
  durationMs: number;
}

export class Verifier {
  constructor(
    private runner: CommandRunner,
    private cwd: string
  ) {}

  async run(input: { targetTests: string[] }): Promise<VerifyResult> {
    const start = Date.now();
    const stages = defaultPipeline(this.cwd, input.targetTests);
    if (stages.length === 0) {
      return {
        ok: true,
        stage: "target-test",
        summary: "no verify scripts found, skipped verification",
        logs: "",
        durationMs: Date.now() - start,
      };
    }
    for (const stage of stages) {
      const result = await this.runner.run(stage.command, stage.args, stage.timeoutMs);
      if (!result.ok) {
        return {
          ok: false,
          stage: stage.name,
          summary: `${stage.name} failed with exitCode=${result.exitCode}`,
          logs: result.combined,
          durationMs: Date.now() - start,
        };
      }
    }
    return {
      ok: true,
      stage: "target-test",
      summary: "all checks passed",
      logs: "",
      durationMs: Date.now() - start,
    };
  }
}
