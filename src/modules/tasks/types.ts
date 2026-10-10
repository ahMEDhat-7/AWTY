export const TASK_STATUSES = ["pending", "processing", "completed", "failed"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskState {
  id: string;
  duration: number;
  status: TaskStatus;
  progress: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
}

export interface CreateTaskResponse {
  id: string;
  status: TaskStatus;
}

/** GET /tasks/:id transport shape — current, DB-authoritative state. */
export interface TaskStateResponse {
  id: string;
  status: TaskStatus;
  progress: number;
}

export interface TaskResponse {
  id: string;
  duration: number;
  status: TaskStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
}
