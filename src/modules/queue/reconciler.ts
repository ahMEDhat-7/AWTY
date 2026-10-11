import type { WorkHandler } from "pg-boss";
import { parseQueuePayload } from "../tasks/dto.ts";
import type { TaskQueuePayloadDto } from "../tasks/types.ts";
import {
  TASK_DLQ_NAME,
  TASK_DLQ_WORK_OPTIONS,
} from "./config.ts";
import { boss, ensureQueue } from "./pg-boss.ts";
import type { ReconcileTask } from "./types.ts";

/**
 * Builds the pg-boss handler that settles dead-lettered task jobs.
 *
 * A job arrives here only after its retries were exhausted in the main
 * queue: pg-boss copied its payload to the dead-letter queue and the job
 * will never run again. Without this handler the task row it names could
 * stay `pending`/`processing` forever, so the handler fails it through
 * the same guarded, idempotent path the rest of the system uses.
 *
 * The payload is untrusted (anything can be dead-lettered) and is
 * re-validated with the API's schema. An invalid payload is a poison
 * job with no identifiable task: it is logged and settled without
 * throwing, because redelivery could never fix it. A reconciliation
 * error (e.g. a transient database failure) is thrown so pg-boss
 * redelivers the dead-letter job per its own retry policy.
 *
 * @param reconcile - the guarded fail-one-task operation, wired to the
 *                    task repository
 * @returns a handler that validates each dead-letter payload and fails
 *          the task it names; it never touches a terminal task
 */
export function createDeadJobReconciler(
  reconcile: ReconcileTask,
): WorkHandler<TaskQueuePayloadDto> {
  return async (jobs) => {
    for (const job of jobs) {
      const parsed = parseQueuePayload(job.data);
      if (!parsed.ok) {
        const detail = parsed.issues
          .map((issue) => `${issue.path || "<body>"}: ${issue.message}`)
          .join("; ");
        console.error(
          `reconciler: dropping unparseable dead-letter job ${job.id} — ${detail}`,
        );
        continue;
      }
      const task = await reconcile(parsed.data.taskId);
      if (task === null) {
        // Already terminal (a run settled it before the dead letter
        // landed) or deleted: reconciliation is idempotent by design.
        continue;
      }
      console.log(
        `reconciler: dead-lettered job ${job.id} failed stranded task ${task.id}`,
      );
    }
  };
}

/**
 * Registers the dead-letter consumer with pg-boss. Called only by the
 * worker entrypoint, alongside the main consumer; the API never consumes
 * jobs. `ensureQueue()` makes the worker independently startable,
 * including against a fresh database.
 *
 * @param reconcile - the guarded fail-one-task operation handed to the handler
 * @returns resolves once the dead-letter consumer is registered with pg-boss
 */
export async function startDeadJobReconciler(
  reconcile: ReconcileTask,
): Promise<void> {
  await ensureQueue();
  await boss.work<TaskQueuePayloadDto>(
    TASK_DLQ_NAME,
    TASK_DLQ_WORK_OPTIONS,
    createDeadJobReconciler(reconcile),
  );
}
