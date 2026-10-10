import { fromPrisma } from "pg-boss";
import type { Prisma } from "../generated/prisma/client.ts";
import type { TaskQueuePayloadDto } from "../modules/tasks/dto.ts";
import { TASK_QUEUE_NAME, taskJobExpireSeconds } from "./config.ts";
import { boss, ensureQueue } from "./pg-boss.ts";

export interface PublishTaskJobOptions {
  /** Task duration in seconds — drives the per-job expiry (TASK-061). */
  durationSeconds: number;
}

/**
 * TASK-024/031 — enqueue a task job inside the caller's Prisma transaction.
 *
 * The payload is minimal by contract (TASK-031): `{ taskId, shouldFail }`.
 * `shouldFail` (documented in PRD §5) travels only through the queue — it
 * is never a column on `Task`, so nothing about the demonstration hook is
 * persisted.
 *
 * Uses pg-boss's fromPrisma adapter (verified against the installed
 * pg-boss 12.37.0: `send(name, data, { db })` routes the insert through the
 * given database), so the task row and its queue job commit together — a
 * crash can leave neither, never one without the other.
 *
 * TASK-061: each job carries its own `expireInSeconds` (`duration + 60`
 * margin), overriding the queue-level fallback — the ownership bound is
 * sized to the task it carries, which is what lets the crash-recovery
 * path (TASK-061/062, ADR-005) reclaim a dead worker's job quickly
 * without ever racing a healthy one.
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
