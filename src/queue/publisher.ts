import { fromPrisma } from "pg-boss";
import type { Prisma } from "../generated/prisma/client.ts";
import type { TaskQueuePayloadDto } from "../modules/tasks/dto.ts";
import { TASK_QUEUE_NAME } from "./config.ts";
import { boss, ensureQueue } from "./pg-boss.ts";

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
 */
export async function publishTaskJob(
  tx: Prisma.TransactionClient,
  payload: TaskQueuePayloadDto,
): Promise<void> {
  await ensureQueue();
  await boss.send(TASK_QUEUE_NAME, payload, { db: fromPrisma(tx) });
}
