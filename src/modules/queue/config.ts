import type { Queue, WorkOptions } from "pg-boss";

/**
 * pg-boss configuration. Side-effect free (type-only pg-boss import) so it
 * can be unit tested without a database or environment. Every option is
 * type-checked against the installed pg-boss 12.37.0 types.
 */
export const TASK_QUEUE_NAME = "awty-tasks";

/**
 * Dead-letter queue for the task queue. Against the installed pg-boss
 * 12.37.0 there is no failed-job event (the event set is
 * `error`/`warning`/`wip`/`stopped`/`bam`/`flow`), but there is a native
 * dead-letter feature: a job that exhausts its retries has its payload
 * copied to the queue named here, consumable like any other queue. The
 * worker's reconciler consumes it and fails tasks whose jobs are gone,
 * so retry exhaustion can never strand a row in `pending`/`processing`.
 */
export const TASK_DLQ_NAME = "awty-tasks-dead";

/**
 * Queue-level policy, inherited by every job at send time:
 *
 * - `heartbeatSeconds` (pg-boss requires >= 10): the worker heartbeats
 *   while it holds a job. A crashed worker stops heartbeating, and the
 *   monitor fails/retries the job within this interval — this is the
 *   ownership mechanism that stops a task being stranded in `processing`.
 *   Without it, recovery would wait out `expireInSeconds`
 *   (pg-boss default: 15 minutes).
 * - `expireInSeconds`: hard cap on active time. Must exceed the maximum
 *   task duration (300s) so a healthy long task is never re-delivered
 *   mid-flight, while still bounding a wedged-but-alive worker to 6 min.
 *   This is the queue-level fallback; the publisher overrides it per job
 *   with `duration + margin` (see `taskJobExpireSeconds`).
 * - `retryLimit` + backoff: redelivery after a crash is bounded — three
 *   attempts, 5s base delay doubling (jittered) up to 60s.
 */
export const TASK_QUEUE_OPTIONS = {
  heartbeatSeconds: 10,
  expireInSeconds: 360,
  retryLimit: 3,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 60,
  // pg-boss copies a terminally-failed job's payload here (see
  // TASK_DLQ_NAME); the reconciler turns it into a terminal task state.
  deadLetter: TASK_DLQ_NAME,
} as const satisfies Omit<Queue, "name">;

/**
 * Per-job expiry margin in seconds, added to a task's duration to produce
 * its active-time bound.
 *
 * Against the installed pg-boss 12.37.0: `SendOptions` extends
 * `QueueOptions`, so `expireInSeconds` sent with a job overrides the
 * queue-level fallback for that job. The margin covers queue wait and
 * scheduling jitter — long enough that a healthy worker always finishes
 * (no spurious redelivery into the restart path), short enough that a job
 * owned by a dead worker is reclaimed instead of sitting out the 6-minute
 * queue default.
 */
export const TASK_JOB_EXPIRE_MARGIN_SECONDS = 60;

/**
 * Computes the active-time bound for one job.
 *
 * @param durationSeconds - the task's declared duration
 * @returns the expiry in seconds (`duration + margin`)
 */
export function taskJobExpireSeconds(durationSeconds: number): number {
  return durationSeconds + TASK_JOB_EXPIRE_MARGIN_SECONDS;
}

/**
 * Per-worker consumption policy:
 *
 * - `batchSize: 1`: exactly one job per handler call, so a thrown handler
 *   redelivers that one job and can never fail a batch that also contains
 *   other tasks.
 * - `localConcurrency: 4`: four task slots run in parallel inside one
 *   worker process. pg-boss job claiming guarantees the same job is never
 *   handed to two workers, however many are running.
 */
export const TASK_WORK_OPTIONS = {
  batchSize: 1,
  localConcurrency: 4,
} as const satisfies WorkOptions;

/**
 * Queue policy for the dead-letter queue itself, applied by
 * `ensureQueue()`. Retry is bounded like the main queue so a failing
 * reconciler redelivers its job a few times before the dead-letter copy
 * itself stays failed (visible in pg-boss for manual redrive) — it can
 * never loop forever. No heartbeat or long expiry: the handler only runs
 * one guarded UPDATE.
 */
export const TASK_DLQ_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 60,
  expireInSeconds: 60,
} as const satisfies Omit<Queue, "name">;

/**
 * Per-worker consumption policy for the dead-letter queue: one
 * reconciliation job at a time, one per handler call, so a thrown error
 * redelivers exactly that job and can never fail a batch.
 */
export const TASK_DLQ_WORK_OPTIONS = {
  batchSize: 1,
  localConcurrency: 1,
} as const satisfies WorkOptions;
