import { describe, expect, it, vi } from "vitest";
import type {
  PrismaClient,
  Task,
} from "../../../src/generated/prisma/client.ts";
import {
  createTaskRepository,
  type TaskRepository,
} from "../../../src/modules/tasks/repository.ts";

const TASK_ID = "0b7f8f3e-1c2d-4a5b-9e8f-112233445566";

// expect.any() returns `any`; asserted as Date to satisfy zero-`any` lint.
const dateMatcher = expect.any(Date) as Date;

function taskRow(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    duration: 10,
    status: "pending",
    progress: 0,
    createdAt: new Date("2026-10-09T00:00:00Z"),
    updatedAt: new Date("2026-10-09T00:00:01Z"),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    ...overrides,
  };
}

function makeDb(updateCount = 1, row: Task | null = taskRow()) {
  const create = vi.fn().mockResolvedValue(taskRow());
  const findUnique = vi.fn().mockResolvedValue(row);
  const updateMany = vi.fn().mockResolvedValue({ count: updateCount });
  const client = {
    task: { create, findUnique, updateMany },
  } as unknown as PrismaClient;
  const repo: TaskRepository = createTaskRepository(client);
  return { repo, create, findUnique, updateMany };
}

describe("task repository (TASK-021)", () => {
  it("creates a task from the duration only", async () => {
    const { repo, create } = makeDb();
    const result = await repo.create({ duration: 25 });
    expect(create).toHaveBeenCalledTimes(1);
    // exact match: no status/progress/shouldFail may reach the insert
    expect(create).toHaveBeenCalledWith({ data: { duration: 25 } });
    expect(result.id).toBe(TASK_ID);
  });

  it("finds a task by id", async () => {
    const { repo, findUnique } = makeDb();
    const result = await repo.findById(TASK_ID);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: TASK_ID } });
    expect(result?.id).toBe(TASK_ID);
  });

  it("returns null from findById for an unknown task", async () => {
    const { repo } = makeDb(1, null);
    expect(await repo.findById(TASK_ID)).toBeNull();
  });

  it("refreshes from the database after a successful guarded update", async () => {
    const afterUpdate = taskRow({
      status: "processing",
      startedAt: new Date("2026-10-09T00:00:02Z"),
    });
    const { repo, findUnique, updateMany } = makeDb(1, afterUpdate);
    const result = await repo.markProcessing(TASK_ID);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: TASK_ID } });
    expect(result?.status).toBe("processing");
  });

  it("skips the refresh when the guard rejects the update", async () => {
    const { repo, findUnique } = makeDb(0);
    expect(await repo.markProcessing(TASK_ID)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("guarded updates (TASK-022)", () => {
  it("markProcessing only moves a task that is still pending", async () => {
    const { repo, updateMany } = makeDb(1);
    await repo.markProcessing(TASK_ID);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: TASK_ID, status: "pending" },
      data: { status: "processing", startedAt: dateMatcher },
    });
  });

  it("updateProgress only writes while the task is processing", async () => {
    const { repo, updateMany } = makeDb(1);
    await repo.updateProgress(TASK_ID, 42);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: TASK_ID, status: "processing" },
      data: { progress: 42 },
    });
  });

  it("markCompleted forces progress to 100 and stamps completion", async () => {
    const { repo, updateMany } = makeDb(1);
    await repo.markCompleted(TASK_ID);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: TASK_ID, status: "processing" },
      data: {
        status: "completed",
        progress: 100,
        completedAt: dateMatcher,
      },
    });
  });

  it("markFailed stamps failure without touching preserved progress", async () => {
    const { repo, updateMany } = makeDb(1);
    await repo.markFailed(TASK_ID);
    // exact argument match: `progress` must not appear in the update
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: TASK_ID, status: "processing" },
      data: { status: "failed", failedAt: dateMatcher },
    });
  });

  it("pins id and source status in every guarded update", async () => {
    const { repo, updateMany } = makeDb(1);
    await repo.markProcessing(TASK_ID);
    await repo.updateProgress(TASK_ID, 10);
    await repo.markCompleted(TASK_ID);
    await repo.markFailed(TASK_ID);
    expect(updateMany).toHaveBeenCalledTimes(4);
    for (const call of updateMany.mock.calls) {
      const args = call[0] as { where: { id?: unknown; status?: unknown } };
      expect(args.where.id).toBe(TASK_ID);
      expect(args.where.status).toEqual(expect.any(String));
    }
  });

  it("returns null for every guarded update that fails its guard", async () => {
    const { repo } = makeDb(0);
    expect(await repo.markProcessing(TASK_ID)).toBeNull();
    expect(await repo.updateProgress(TASK_ID, 10)).toBeNull();
    expect(await repo.markCompleted(TASK_ID)).toBeNull();
    expect(await repo.markFailed(TASK_ID)).toBeNull();
  });
});
