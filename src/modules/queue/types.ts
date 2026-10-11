import type { TaskQueuePayloadDto } from "../tasks/types.ts";

export type TaskExecutor = (payload: TaskQueuePayloadDto) => Promise<void>;

/**
 * Fails one task whose queue job is gone: the repository's guarded
 * `markFailedIfOpen`, returning the updated task or `null` when the task
 * is already terminal or missing.
 */
export type ReconcileTask = (
  taskId: string,
) => Promise<{ id: string } | null>;

export interface PublishTaskJobOptions {
  /** Task duration in seconds — drives the per-job expiry. */
  durationSeconds: number;
}
