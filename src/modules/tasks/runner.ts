import type { TaskQueuePayloadDto } from "./dto.ts";
import { calculateProgress, PROGRESS_TICK_MS } from "./progress.ts";
import type { TaskRepository } from "./repository.ts";

/**
 * Normalizes a caught error to a loggable message.
 *
 * Caught values are `unknown`, and coercions like `String(cause)` can
 * themselves throw on exotic objects, so only safe narrowings are applied.
 *
 * @param cause - the caught value
 * @returns the error's message, the string itself, or `"unknown error"`
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
    | "findById"
    | "markProcessing"
    | "restartProcessing"
    | "updateProgress"
    | "markCompleted"
    | "markFailed"
  > {
  /** Injectable timer — unit tests run instantly, the worker injects real timers. */
  sleep(ms: number): Promise<void>;
}

/**
 * Builds the task execution pipeline:
 *
 * load → guarded `pending → processing` → tick simulation with periodic
 * progress persistence → guarded `processing → completed` / `failed`.
 *
 * - **Guarded claim:** the DB-guarded claim decides who proceeds:
 *   `markProcessing` only matches rows still `pending`, so a duplicate or
 *   stale delivery observes `null` and does nothing.
 * - **Crash recovery:** when the pending claim misses but the task is
 *   still `processing`, `restartProcessing` resets it to 0% and this run
 *   takes over. pg-boss redelivers a job only after the owning worker's
 *   heartbeat has died, so a restart can never race a healthy attempt;
 *   both claims are guarded UPDATEs, so a terminal task is never
 *   resurrected and one failed job can never disturb another.
 * - **Simulation:** the run advances in timer ticks (never blocking the
 *   event loop); each tick evaluates `calculateProgress` from elapsed
 *   time. `shouldFail` throws deterministically at the halfway tick.
 * - **Progress:** only *changed* values are persisted — identical progress
 *   never writes twice. Every durable write flows through the guarded
 *   UPDATE, which the database trigger turns into a `task_updates`
 *   notification for the WebSocket layer.
 * - **Completion:** after the final tick, `markCompleted` forces
 *   `progress = 100` and `completedAt = now`, only from `processing`.
 * - **Failure boundary:** errors after the claim are caught (as `unknown`),
 *   normalized, and turned into the terminal `failed` state — `failedAt`
 *   is stamped while the last durable progress is preserved.
 *   One task's failure settles its own job and cannot take down the
 *   worker process or any other task.
 *   Errors before the claim (load/claim) propagate so pg-boss can retry:
 *   no state has been moved yet.
 *
 * @param deps - repository methods and the injectable timer the run uses
 * @returns an async runner that executes one validated queue payload to a
 *          terminal task state
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

    const started = await deps.markProcessing(task.id);
    const claimed = started ?? (await deps.restartProcessing(task.id));
    if (claimed === null) {
      // The task is already terminal (completed or failed): a straggler
      // duplicate delivery settles its job without touching it.
      return;
    }
    if (started === null) {
      // Recovery of a crashed attempt: restart the simulation from 0%
      // instead of stranding the task in `processing` forever.
      console.log(`task ${task.id} recovered: restarting from 0%`);
    }

    try {
      const durationMs = task.duration * 1000;
      let elapsedMs = 0;
      let lastPersisted = claimed.progress;

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
