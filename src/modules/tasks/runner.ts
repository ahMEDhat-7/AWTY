import type { TaskQueuePayloadDto } from "./dto.ts";
import { calculateProgress, PROGRESS_TICK_MS } from "./progress.ts";
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
  extends Pick<
    TaskRepository,
    "findById" | "markProcessing" | "updateProgress" | "markCompleted" | "markFailed"
  > {
  /** Injectable timer — unit tests run instantly, the worker injects real timers. */
  sleep(ms: number): Promise<void>;
}

/**
 * TASK-034/035/036/037/038/040 — the task execution pipeline:
 *
 * load → guarded `pending → processing` → tick simulation with periodic
 * progress persistence → guarded `processing → completed` / `failed`.
 *
 * - **TASK-034:** the DB-guarded claim decides who proceeds: `markProcessing`
 *   only matches rows still `pending`, so a duplicate or stale delivery
 *   observes `null` and does nothing (PRD §19).
 * - **TASK-035/037:** the simulation advances in timer ticks (never blocking
 *   the event loop); each tick evaluates `calculateProgress` from elapsed
 *   time. `shouldFail` (PRD §5) throws deterministically at the halfway tick.
 * - **TASK-038:** only *changed* values are persisted — identical progress
 *   never writes twice. Every durable write flows through the guarded
 *   UPDATE, which the database trigger turns into a `task_updates`
 *   notification for the WebSocket layer (TASK-039).
 * - **TASK-040:** after the final tick, `markCompleted` forces
 *   `progress = 100` and `completedAt = now`, only from `processing`.
 * - **TASK-036:** errors after the claim are caught (as `unknown`),
 *   normalized, and turned into the terminal `failed` state — one task's
 *   failure settles its own job and cannot take down the worker process.
 *   Errors before the claim (load/claim) propagate so pg-boss can retry:
 *   no state has been moved yet.
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
      const durationMs = task.duration * 1000;
      let elapsedMs = 0;
      let lastPersisted = task.progress;

      for (;;) {
        await deps.sleep(PROGRESS_TICK_MS);
        elapsedMs += PROGRESS_TICK_MS;

        if (payload.shouldFail && elapsedMs >= durationMs / 2) {
          const progress = calculateProgress(elapsedMs, task.duration);
          throw new Error(
            `simulated failure mid-run (${progress}% of ${task.duration}s)`,
          );
        }

        if (elapsedMs >= durationMs) {
          break;
        }

        const progress = calculateProgress(elapsedMs, task.duration);
        if (progress !== lastPersisted) {
          await deps.updateProgress(task.id, progress);
          lastPersisted = progress;
        }
      }

      await deps.markCompleted(task.id);
    } catch (cause) {
      await deps.markFailed(task.id);
      console.error(`task ${task.id} failed: ${toErrorMessage(cause)}`);
    }
  };
}

export type TaskRunner = ReturnType<typeof createTaskRunner>;
