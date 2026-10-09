import type { TaskQueuePayloadDto } from "./dto.ts";
import type { TaskRepository } from "./repository.ts";

/**
 * TASK-036 — normalize a caught error without assuming its shape. Caught
 * values are `unknown`, and coercions like `String(cause)` can themselves
 * throw on exotic objects, so only safe narrowings are applied.
 */
export function toErrorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  return "unknown error";
}

export interface TaskRunnerDeps
  extends Pick<TaskRepository, "findById" | "markProcessing" | "markCompleted" | "markFailed"> {
  /** Injectable timer — unit tests run instantly, the worker injects real timers. */
  sleep(ms: number): Promise<void>;
}

/**
 * TASK-034/035/036 — the task execution pipeline:
 *
 * load → guarded `pending → processing` → simulate duration → guarded
 * `processing → completed` / `processing → failed`.
 *
 * - **TASK-034:** the DB-guarded claim decides who proceeds: `markProcessing`
 *   only matches rows still `pending`, so a duplicate or stale delivery
 *   observes `null` and does nothing (PRD §19).
 * - **TASK-035:** the simulation is timer-based (`sleep`), so it never
 *   blocks the event loop; `shouldFail` (PRD §5) fails deterministically
 *   at the halfway point.
 * - **TASK-036:** errors during simulation/completion are caught (as
 *   `unknown`), normalized, and turned into the terminal `failed` state —
 *   one task's failure resolves its own job and cannot take down the
 *   worker process. Errors before the claim has happened (load/claim) are
 *   left to propagate so pg-boss can retry the job — no state was moved yet.
 */
export function createTaskRunner(deps: TaskRunnerDeps) {
  return async function runTask(payload: TaskQueuePayloadDto): Promise<void> {
    const task = await deps.findById(payload.taskId);
    if (task === null) {
      // The insert/job share a transaction, so this should be impossible;
      // throwing hands the job to pg-boss's retry policy instead of
      // silently completing it.
      throw new Error(`task ${payload.taskId} not found`);
    }

    const claimed = await deps.markProcessing(task.id);
    if (claimed === null) {
      // The task left `pending` already — another attempt owns or finished
      // it. Nothing to do; settle the job without touching the task.
      return;
    }

    try {
      if (payload.shouldFail) {
        await deps.sleep((task.duration * 1000) / 2);
        throw new Error(`simulated failure mid-run (50% of ${task.duration}s)`);
      }
      await deps.sleep(task.duration * 1000);
      await deps.markCompleted(task.id);
    } catch (cause) {
      await deps.markFailed(task.id);
      console.error(`task ${task.id} failed: ${toErrorMessage(cause)}`);
    }
  };
}

export type TaskRunner = ReturnType<typeof createTaskRunner>;
