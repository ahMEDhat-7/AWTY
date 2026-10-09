import { describe, expect, it, vi } from "vitest";
import type { Prisma, Task } from "../../../src/generated/prisma/client.ts";
import { createCreateTaskService } from "../../../src/modules/tasks/service.ts";

const TASK_ID = "0b7f8f3e-1c2d-4a5b-9e8f-112233445566";

function taskRow(): Task {
  return {
    id: TASK_ID,
    duration: 10,
    status: "pending",
    progress: 0,
    createdAt: new Date("2026-10-09T00:00:00Z"),
    updatedAt: new Date("2026-10-09T00:00:00Z"),
    startedAt: null,
    completedAt: null,
    failedAt: null,
  };
}

interface Harness {
  service: ReturnType<typeof createCreateTaskService>;
  publish: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  tx: Prisma.TransactionClient;
  stats: { transactions: number };
}

function makeHarness(options?: {
  publishError?: Error;
  createError?: Error;
}): Harness {
  const create = vi.fn();
  if (options?.createError !== undefined) {
    create.mockRejectedValue(options.createError);
  } else {
    create.mockResolvedValue(taskRow());
  }
  const tx = { task: { create } } as unknown as Prisma.TransactionClient;

  const publish = vi.fn();
  if (options?.publishError !== undefined) {
    publish.mockRejectedValue(options.publishError);
  } else {
    publish.mockResolvedValue(undefined);
  }

  const stats = { transactions: 0 };
  const runInTransaction = <T,>(
    fn: (t: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> => {
    stats.transactions += 1;
    return fn(tx);
  };

  const service = createCreateTaskService({ runInTransaction, publish });
  return { service, publish, create, tx, stats };
}

describe("create-task service (TASK-023)", () => {
  it("creates a pending task, enqueues its job and returns the id", async () => {
    const h = makeHarness();
    const result = await h.service({ duration: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected success");
    }
    expect(result.task).toEqual({ id: TASK_ID, status: "pending" });
    expect(h.create).toHaveBeenCalledWith({ data: { duration: 10 } });
    expect(h.publish).toHaveBeenCalledWith(h.tx, {
      taskId: TASK_ID,
      shouldFail: false,
    });
    expect(h.stats.transactions).toBe(1);
  });

  it("carries shouldFail into the queue payload", async () => {
    const h = makeHarness();
    const result = await h.service({ duration: 3, shouldFail: true });
    expect(result.ok).toBe(true);
    expect(h.publish).toHaveBeenCalledWith(h.tx, {
      taskId: TASK_ID,
      shouldFail: true,
    });
  });

  it("rejects invalid bodies before touching the database", async () => {
    const h = makeHarness();
    const invalid: unknown[] = [
      undefined,
      null,
      {},
      { duration: 0 },
      { duration: 301 },
      { duration: "5" },
      { duration: 10, shouldFail: "yes" },
    ];
    for (const body of invalid) {
      const result = await h.service(body);
      expect(result.ok, JSON.stringify(body)).toBe(false);
      if (result.ok || result.kind !== "validation") {
        throw new Error("expected validation failure");
      }
      expect(result.issues).toBeDefined();
    }
    expect(h.stats.transactions).toBe(0);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("inserts before publishing, inside the same transaction", async () => {
    const h = makeHarness();
    const order: string[] = [];
    h.create.mockImplementation(() => {
      order.push("insert");
      return taskRow();
    });
    h.publish.mockImplementation(() => {
      order.push("publish");
      return undefined;
    });
    const result = await h.service({ duration: 10 });
    expect(result.ok).toBe(true);
    expect(order).toEqual(["insert", "publish"]);
    expect(h.publish).toHaveBeenCalledWith(h.tx, expect.anything());
  });
});

describe("create-task service (TASK-024 consistency)", () => {
  it("surfaces a queue failure as unexpected (transaction rolls back)", async () => {
    const boom = new Error("pg-boss unavailable");
    const h = makeHarness({ publishError: boom });
    const result = await h.service({ duration: 10 });
    expect(result).toEqual({
      ok: false,
      kind: "unexpected",
      cause: boom,
    });
  });

  it("surfaces a repository failure as unexpected", async () => {
    const boom = new Error("connection reset");
    const h = makeHarness({ createError: boom });
    const result = await h.service({ duration: 10 });
    expect(result).toEqual({
      ok: false,
      kind: "unexpected",
      cause: boom,
    });
    expect(h.publish).not.toHaveBeenCalled();
  });
});
