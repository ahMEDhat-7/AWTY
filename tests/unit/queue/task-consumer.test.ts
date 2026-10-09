import { describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";
import type { TaskQueuePayloadDto } from "../../../src/modules/tasks/dto.ts";
import type { TaskExecutor } from "../../../src/queue/worker.ts";

// Same pattern as config.test.ts: the consumer module chain reaches the
// env-validated pg-boss singleton, so DATABASE_URL must exist first.
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/testdb";

const { createTaskJobHandler } = await import("../../../src/queue/worker.ts");

const TASK_ID = "0b7f8f3e-1c2d-4a5b-9e8f-112233445566";

function makeJob(data: unknown): Job<TaskQueuePayloadDto> {
  return {
    id: "job-1",
    name: "awty-tasks",
    data,
    expireInSeconds: 360,
    heartbeatSeconds: 10,
    retryCount: 0,
    signal: new AbortController().signal,
  } as unknown as Job<TaskQueuePayloadDto>;
}

describe("worker consumer (TASK-032)", () => {
  it("runs the task for a valid queue payload", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const handler = createTaskJobHandler(execute as TaskExecutor);

    await handler([makeJob({ taskId: TASK_ID, shouldFail: true })]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ taskId: TASK_ID, shouldFail: true });
  });

  it("never executes a payload that fails validation", async () => {
    const execute = vi.fn();
    const handler = createTaskJobHandler(execute as TaskExecutor);

    await expect(handler([makeJob({ wrong: true })])).rejects.toThrow(
      /invalid queue payload/,
    );

    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a mistyped payload even when the taskId is valid", async () => {
    const execute = vi.fn();
    const handler = createTaskJobHandler(execute as TaskExecutor);

    await expect(
      handler([makeJob({ taskId: TASK_ID, shouldFail: "yes" })]),
    ).rejects.toThrow(/invalid queue payload/);

    expect(execute).not.toHaveBeenCalled();
  });

  it("propagates executor failures so pg-boss can redeliver the job", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("db down"));
    const handler = createTaskJobHandler(execute as TaskExecutor);

    await expect(
      handler([makeJob({ taskId: TASK_ID, shouldFail: false })]),
    ).rejects.toThrow("db down");
  });
});
