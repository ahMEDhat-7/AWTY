import type { WorkHandler } from "pg-boss";
import {
  parseQueuePayload,
  type TaskQueuePayloadDto,
} from "../modules/tasks/dto.ts";
import { TASK_QUEUE_NAME, TASK_WORK_OPTIONS } from "./config.ts";
import { boss, ensureQueue } from "./pg-boss.ts";

export type TaskExecutor = (payload: TaskQueuePayloadDto) => Promise<void>;

/**
 * Builds the pg-boss job handler that runs one task job.
 *
 * The queue payload is untrusted input: it is re-validated with the same
 * zod schema the API used on write. A payload that fails validation is a
 * poison job — it is thrown before any execution, so pg-boss redelivers
 * it per the queue's retry policy and finally fails it.
 *
 * `TASK_WORK_OPTIONS.batchSize` is 1, so one job arrives per call: a
 * thrown error hands exactly that job back for redelivery and can never
 * fail a batch containing other tasks. The task execution itself is
 * injected, so this unit never touches the database.
 *
 * @param execute - the injected task runner, called with the validated payload
 * @returns a handler that validates each job's payload and awaits `execute`
 */
export function createTaskJobHandler(
  execute: TaskExecutor,
): WorkHandler<TaskQueuePayloadDto> {
  return async (jobs) => {
    for (const job of jobs) {
      const parsed = parseQueuePayload(job.data);
      if (!parsed.ok) {
        const detail = parsed.issues
          .map((issue) => `${issue.path || "<body>"}: ${issue.message}`)
          .join("; ");
        throw new Error(`invalid queue payload for job ${job.id} — ${detail}`);
      }
      await execute(parsed.data);
    }
  };
}

/**
 * Registers the task consumer with pg-boss. Called only by the worker
 * entrypoint; the API never consumes jobs. `ensureQueue()` makes the
 * worker independently startable, including against a fresh database.
 *
 * @param execute - the injected task runner handed to the job handler
 * @returns resolves once the consumer is registered with pg-boss
 */
export async function startTaskConsumer(execute: TaskExecutor): Promise<void> {
  await ensureQueue();
  await boss.work<TaskQueuePayloadDto>(
    TASK_QUEUE_NAME,
    TASK_WORK_OPTIONS,
    createTaskJobHandler(execute),
  );
}
