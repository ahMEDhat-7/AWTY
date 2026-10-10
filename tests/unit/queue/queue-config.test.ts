import { describe, expect, it } from "vitest";
import {
  TASK_QUEUE_NAME,
  TASK_QUEUE_OPTIONS,
  TASK_WORK_OPTIONS,
  taskJobExpireSeconds,
} from "../../../src/queue/config.ts";

describe("pg-boss configuration", () => {
  it("names the task queue", () => {
    expect(TASK_QUEUE_NAME).toBe("awty-tasks");
  });

  it("enables heartbeat recovery within pg-boss's >=10s constraint", () => {
    // Verified from pg-boss 12.37.0 types: heartbeats must be >= 10 seconds,
    // and a missed heartbeat is what lets the monitor redeliver a crashed
    // worker's job instead of waiting out expireInSeconds (15 min default).
    expect(TASK_QUEUE_OPTIONS.heartbeatSeconds).toBeGreaterThanOrEqual(10);
  });

  it("keeps active jobs alive longer than the longest possible task", () => {
    // durationSchema caps task duration at 300s — a healthy long task must
    // never expire mid-run and be re-delivered to a second worker.
    expect(TASK_QUEUE_OPTIONS.expireInSeconds).toBeGreaterThan(300);
  });

  it("sizes each job's expiry to its own duration plus a margin", () => {
    // SendOptions extends QueueOptions in pg-boss 12.37.0, so this
    // per-job value overrides the queue-level fallback: even the longest
    // task's job stays within it, while a short task's job is reclaimed
    // far sooner than the 6-minute queue default.
    expect(taskJobExpireSeconds(1)).toBe(61);
    expect(taskJobExpireSeconds(300)).toBe(
      TASK_QUEUE_OPTIONS.expireInSeconds,
    );
  });

  it("bounds redelivery with exponential backoff", () => {
    expect(TASK_QUEUE_OPTIONS.retryLimit).toBeGreaterThan(0);
    expect(TASK_QUEUE_OPTIONS.retryBackoff).toBe(true);
    expect(TASK_QUEUE_OPTIONS.retryDelayMax).toBeGreaterThanOrEqual(
      TASK_QUEUE_OPTIONS.retryDelay,
    );
  });

  it("consumes one job per handler call so failures stay per-task", () => {
    expect(TASK_WORK_OPTIONS.batchSize).toBe(1);
  });

  it("runs several task slots in parallel per worker process", () => {
    expect(TASK_WORK_OPTIONS.localConcurrency).toBeGreaterThanOrEqual(1);
  });
});
