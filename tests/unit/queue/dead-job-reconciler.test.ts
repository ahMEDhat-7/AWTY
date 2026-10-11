import { describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";
import type { TaskQueuePayloadDto } from "../../../src/modules/tasks/dto.ts";
import type { ReconcileTask } from "../../../src/queue/reconciler.ts";

// Same pattern as task-consumer.test.ts: the reconciler module chain
// reaches the env-validated pg-boss singleton, so DATABASE_URL must
// exist first.
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/testdb";

const { createDeadJobReconciler } = await import("../../../src/queue/reconciler.ts");

const TASK_ID = "0b7f8f3e-1c2d-4a5b-9e8f-112233445566";

function makeJob(data: unknown): Job<TaskQueuePayloadDto> {
  return {
    id: "job-1",
    name: "awty-tasks-dead",
    data,
    retryCount: 0,
    signal: new AbortController().signal,
  } as unknown as Job<TaskQueuePayloadDto>;
}

describe("dead-job reconciler", () => {
  it("fails the task named by a valid dead-letter payload", async () => {
    const reconcile = vi.fn().mockResolvedValue({ id: TASK_ID });
    const handler = createDeadJobReconciler(reconcile as ReconcileTask);

    await handler([makeJob({ taskId: TASK_ID, shouldFail: true })]);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(TASK_ID);
  });

  it("settles without error when the task is already terminal or missing", async () => {
    const reconcile = vi.fn().mockResolvedValue(null);
    const handler = createDeadJobReconciler(reconcile as ReconcileTask);

    await expect(
      handler([makeJob({ taskId: TASK_ID, shouldFail: false })]),
    ).resolves.toBeUndefined();

    expect(reconcile).toHaveBeenCalledWith(TASK_ID);
  });

  it("drops a poison payload without reconciling or throwing", async () => {
    const reconcile = vi.fn();
    const handler = createDeadJobReconciler(reconcile as ReconcileTask);

    // Redelivery can never repair an unparseable payload, so the job is
    // settled rather than thrown back into a retry loop.
    await expect(handler([makeJob({ wrong: true })])).resolves.toBeUndefined();

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("rejects a mistyped payload even when the taskId is valid", async () => {
    const reconcile = vi.fn();
    const handler = createDeadJobReconciler(reconcile as ReconcileTask);

    await expect(
      handler([makeJob({ taskId: TASK_ID, shouldFail: "yes" })]),
    ).resolves.toBeUndefined();

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("propagates reconciliation failures so pg-boss can redeliver", async () => {
    const reconcile = vi.fn().mockRejectedValue(new Error("db down"));
    const handler = createDeadJobReconciler(reconcile as ReconcileTask);

    await expect(
      handler([makeJob({ taskId: TASK_ID, shouldFail: false })]),
    ).rejects.toThrow("db down");
  });
});
