import { fromPrisma } from "pg-boss";
import type { Prisma } from "../generated/prisma/client.ts";
import type { TaskQueuePayloadDto } from "../modules/tasks/dto.ts";
import { TASK_QUEUE_NAME, taskJobExpireSeconds } from "./config.ts";
import { boss, ensureQueue } from "./pg-boss.ts";

export interface PublishTaskJobOptions {
  /** Task duration in seconds — drives the per-job expiry. */
  durationSeconds: number;
}

/**
 * Enqueues one task job inside the caller's Prisma transaction.
 *
 * The payload is minimal by contract: `{ taskId, shouldFail }`.
 * `shouldFail` travels only through the queue — it is never a column on
 * `Task`, so nothing about the demonstration hook is persisted.
 *
 * Uses pg-boss's fromPrisma adapter (against the installed pg-boss
 * 12.37.0: `send(name, data, { db })` routes the insert through the
 * given database), so the task row and its queue job commit together — a
 * crash can leave neither, never one without the other.
 *
 * Each job carries its own `expireInSeconds` (`duration + 60` margin),
 * overriding the queue-level fallback — the ownership bound is sized to
 * the task it carries, which is what lets the crash-recovery path reclaim
 * a dead worker's job quickly without ever racing a healthy one.
 *
 * @param tx - the active Prisma transaction the job must commit with
 * @param payload - `{ taskId, shouldFail }`, already validated by the API
 * @param options - `durationSeconds`, the task's declared duration
 * @returns resolves once the job row is written; rejects when the queue is
 *          unreachable, which rolls back the transaction
 */
export async function publishTaskJob(
  tx: Prisma.TransactionClient,
  payload: TaskQueuePayloadDto,
  options: PublishTaskJobOptions,
): Promise<void> {
  await ensureQueue();
  await boss.send(TASK_QUEUE_NAME, payload, {
    db: fromPrisma(tx),
    expireInSeconds: taskJobExpireSeconds(options.durationSeconds),
  });
}
