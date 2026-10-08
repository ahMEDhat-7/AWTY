export const TASK_STATUSES = ["pending", "processing", "completed", "failed"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface CreateTaskInput {
  duration: number;
  shouldFail?: boolean;
}

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

export interface TaskQueuePayload {
  taskId: string;
  shouldFail?: boolean;
}
