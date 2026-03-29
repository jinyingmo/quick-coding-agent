export interface TaskResultSuccess {
  ok: true;
  attempt: number;
  changedFiles: string[];
  mode?: "patch";
  summary?: string;
}

export interface TaskResultAnalysis {
  ok: true;
  mode: "analysis";
  summary: string;
}

export interface TaskResultFailed {
  ok: false;
  reason: string;
}

export type TaskResult = TaskResultSuccess | TaskResultAnalysis | TaskResultFailed;
