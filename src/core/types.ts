export interface TaskResultSuccess {
  ok: true;
  attempt: number;
  changedFiles: string[];
}

export interface TaskResultFailed {
  ok: false;
  reason: string;
}

export type TaskResult = TaskResultSuccess | TaskResultFailed;
