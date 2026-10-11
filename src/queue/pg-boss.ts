import { PgBoss } from "pg-boss";
import { env } from "../config/env.ts";
import {
  TASK_DLQ_NAME,
  TASK_DLQ_QUEUE_OPTIONS,
  TASK_QUEUE_NAME,
  TASK_QUEUE_OPTIONS,
} from "./config.ts";

export const boss = new PgBoss({ connectionString: env.DATABASE_URL });

let queueReady: Promise<void> | undefined;

/**
 * Starts pg-boss (schema migration + queue cache) and ensures the task
 * queue and its dead-letter queue exist with their policy — `send()`
 * fails fast when the queue is missing. Memoized, and the memo is
 * cleared on failure so a later call retries. Against the installed
 * pg-boss 12.37.0, `start()` and `createQueue()` are idempotent
 * (create_queue uses ON CONFLICT DO NOTHING).
 *
 * Because of that ON CONFLICT DO NOTHING, `createQueue()` cannot apply
 * options to a queue that already exists — so `updateQueue()` (an
 * idempotent UPDATE) follows it, leaving fresh volumes and pre-existing
 * queues with the same heartbeat/retry/expiry policy.
 *
 * The dead-letter queue is created first: `createQueue()` validates a
 * `deadLetter` option against the live queue list, so the DLQ must
 * already exist when the task queue declares it.
 *
 * @returns resolves once pg-boss is started and both queues exist with
 *          their policy; rejects on the first failure
 */
export function ensureQueue(): Promise<void> {
  if (queueReady === undefined) {
    queueReady = (async () => {
      await boss.start();
      await boss.createQueue(TASK_DLQ_NAME, TASK_DLQ_QUEUE_OPTIONS);
      await boss.updateQueue(TASK_DLQ_NAME, TASK_DLQ_QUEUE_OPTIONS);
      await boss.createQueue(TASK_QUEUE_NAME, TASK_QUEUE_OPTIONS);
      await boss.updateQueue(TASK_QUEUE_NAME, TASK_QUEUE_OPTIONS);
    })().catch((error: unknown) => {
      queueReady = undefined;
      throw error;
    });
  }
  return queueReady;
}
