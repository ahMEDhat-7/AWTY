import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../../src/generated/prisma/client.ts";
import { createGetTaskService } from "../../../src/modules/tasks/service.ts";

const TASK_ID = "0b7f8f3e-1c2d-4a5b-9e8f-112233445566";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    duration: 10,
    status: "pending",
    progress: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    ...overrides,
  };
}

describe("get-task service (TASK-041)", () => {
  it("returns the current state from PostgreSQL", async () => {
    const findById = vi
      .fn()
      .mockResolvedValue(makeTask({ status: "processing", progress: 42 }));
    const service = createGetTaskService({ findById });

    const result = await service(TASK_ID);

    expect(result).toEqual({
      ok: true,
      task: { id: TASK_ID, status: "processing", progress: 42 },
    });
    expect(findById).toHaveBeenCalledWith(TASK_ID);
  });

  it("reports an unknown task as not_found", async () => {
    const service = createGetTaskService({
      findById: vi.fn().mockResolvedValue(null),
    });

    expect(await service(TASK_ID)).toEqual({ ok: false, kind: "not_found" });
  });

  it("treats a malformed id as a validation error without touching the database", async () => {
    const findById = vi.fn();
    const service = createGetTaskService({ findById });

    const result = await service("not-a-uuid");

    if (result.ok || result.kind !== "validation") {
      throw new Error("expected a validation failure");
    }
    expect(result.issues.length).toBeGreaterThan(0);
    expect(findById).not.toHaveBeenCalled();
  });

  it("maps unexpected read failures to the unexpected branch", async () => {
    const service = createGetTaskService({
      findById: vi.fn().mockRejectedValue(new Error("db down")),
    });

    const result = await service(TASK_ID);

    if (result.ok) {
      throw new Error("expected an unexpected failure");
    }
    expect(result.kind).toBe("unexpected");
  });
});
