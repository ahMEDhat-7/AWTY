import { fromPrisma } from "pg-boss";
import type { Prisma } from "../generated/prisma/client.ts";
import type { TaskQueuePayloadDto } from "../modules/tasks/dto.ts";
import { boss, ensureQueue, TASK_QUEUE_NAME } from "./pg-boss.ts";

/**
 * TASK-024 — enqueue a task job inside the caller's Prisma transaction.
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
