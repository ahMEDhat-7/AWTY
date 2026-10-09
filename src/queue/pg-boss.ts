import { PgBoss } from "pg-boss";
import { env } from "../config/env.ts";

/** Queue name for task jobs (TASK-030 formalizes retry/concurrency options). */
export const TASK_QUEUE_NAME = "awty-tasks";

export const boss = new PgBoss({ connectionString: env.DATABASE_URL });

let queueReady: Promise<void> | undefined;

/**
 * Start pg-boss (schema migration + queue cache) and ensure the task queue
 * exists — send() fails fast when the queue is missing. Memoized, and the
 * memo is cleared on failure so a later call retries. Verified against the
 * installed pg-boss 12.37.0: start() and createQueue() are idempotent
 * (create_queue uses ON CONFLICT DO NOTHING).
 */
export function ensureQueue(): Promise<void> {
  if (queueReady === undefined) {
    queueReady = (async () => {
      await boss.start();
      await boss.createQueue(TASK_QUEUE_NAME);
    })().catch((error: unknown) => {
      queueReady = undefined;
      throw error;
    });
  }
  return queueReady;
}
