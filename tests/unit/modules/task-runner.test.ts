import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../../src/generated/prisma/client.ts";
import type { TaskQueuePayloadDto } from "../../../src/modules/tasks/dto.ts";
import {
  createTaskRunner,
  toErrorMessage,
} from "../../../src/modules/tasks/runner.ts";

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

function makePayload(overrides: Partial<TaskQueuePayloadDto> = {}): TaskQueuePayloadDto {
  return { taskId: TASK_ID, shouldFail: false, ...overrides };
}

function makeHarness(overrides: {
  task?: Task | null;
  claim?: Task | null;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  const slept: number[] = [];
  const deps = {
    findById: vi
      .fn()
      .mockResolvedValue(overrides.task === undefined ? makeTask() : overrides.task),
    markProcessing: vi
      .fn()
      .mockResolvedValue(
        overrides.claim === undefined ? makeTask({ status: "processing" }) : overrides.claim,
      ),
    markCompleted: vi.fn().mockResolvedValue(makeTask({ status: "completed", progress: 100 })),
    markFailed: vi.fn().mockResolvedValue(makeTask({ status: "failed" })),
    sleep:
      overrides.sleep ??
      vi.fn((ms: number) => {
        slept.push(ms);
        return Promise.resolve();
      }),
  };
  return { deps, run: createTaskRunner(deps), slept };
}

describe("task runner (TASK-034/035/036)", () => {
  it("claims the task, waits out the duration and completes it", async () => {
    const h = makeHarness();

    await h.run(makePayload());

    expect(h.deps.findById).toHaveBeenCalledWith(TASK_ID);
    expect(h.deps.markProcessing).toHaveBeenCalledWith(TASK_ID);
    expect(h.slept).toEqual([10_000]);
    expect(h.deps.markCompleted).toHaveBeenCalledWith(TASK_ID);
    expect(h.deps.markFailed).not.toHaveBeenCalled();
  });

  it("does nothing when the guarded pending -> processing claim is lost", async () => {
    const h = makeHarness({ claim: null });

    await h.run(makePayload());

    expect(h.slept).toEqual([]);
    expect(h.deps.markCompleted).not.toHaveBeenCalled();
    expect(h.deps.markFailed).not.toHaveBeenCalled();
  });

  it("fails deterministically mid-run when shouldFail is set", async () => {
    const h = makeHarness();

    await h.run(makePayload({ shouldFail: true }));

    expect(h.slept).toEqual([5_000]);
    expect(h.deps.markFailed).toHaveBeenCalledWith(TASK_ID);
    expect(h.deps.markCompleted).not.toHaveBeenCalled();
  });

  it("throws (so pg-boss retries) when the task does not exist", async () => {
    const h = makeHarness({ task: null });

    await expect(h.run(makePayload())).rejects.toThrow(/not found/);

    expect(h.deps.markProcessing).not.toHaveBeenCalled();
  });

  it("contains a task failure inside its own job (error boundary)", async () => {
    const h = makeHarness({
      sleep: vi.fn().mockRejectedValue(new Error("timer exploded")),
    });

    // The runner must resolve — a failed task settles its own job and can
    // never crash the worker process (PRD §13).
    await expect(h.run(makePayload())).resolves.toBeUndefined();

    expect(h.deps.markFailed).toHaveBeenCalledWith(TASK_ID);
    expect(h.deps.markCompleted).not.toHaveBeenCalled();
  });
});

describe("toErrorMessage (TASK-036)", () => {
  it("uses the message of real errors", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("passes through plain strings", () => {
    expect(toErrorMessage("boom")).toBe("boom");
  });

  it("falls back safely for unknown shapes, including throwing coercions", () => {
    const hostile = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(toErrorMessage(hostile)).toBe("unknown error");
    expect(toErrorMessage(null)).toBe("unknown error");
    expect(toErrorMessage(undefined)).toBe("unknown error");
  });
});
