import type { Queue, WorkOptions } from "pg-boss";

/**
 * pg-boss configuration. Side-effect free (type-only pg-boss import) so it
 * can be unit tested without a database or environment. Every option is
 * type-checked against the installed pg-boss 12.37.0 types.
 */
export const TASK_QUEUE_NAME = "awty-tasks";

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
