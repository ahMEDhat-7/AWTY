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
  restart?: Task | null;
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
    restartProcessing: vi
      .fn()
      .mockResolvedValue(overrides.restart ?? null),
    updateProgress: vi
      .fn()
      .mockResolvedValue(makeTask({ status: "processing" })),
    markCompleted: vi
      .fn()
      .mockResolvedValue(makeTask({ status: "completed", progress: 100 })),
    markFailed: vi.fn().mockResolvedValue(makeTask({ status: "failed" })),
    sleep:
      overrides.sleep ??
      vi.fn((ms: number) => {
        slept.push(ms);
        return Promise.resolve();
      }),
  };
  const persisted = (): number[] =>
    deps.updateProgress.mock.calls.map((call) => call[1] as number);
  return { deps, run: createTaskRunner(deps), slept, persisted };
}

describe("task runner", () => {
  it("claims the task, ticks out the duration and completes it", async () => {
    const h = makeHarness();

    await h.run(makePayload());

    expect(h.deps.findById).toHaveBeenCalledWith(TASK_ID);
    expect(h.deps.markProcessing).toHaveBeenCalledWith(TASK_ID);
    // A fresh claim means there is nothing to recover.
    expect(h.deps.restartProcessing).not.toHaveBeenCalled();
    expect(h.slept).toEqual(Array(10).fill(1000));
    expect(h.deps.markCompleted).toHaveBeenCalledWith(TASK_ID);
    expect(h.deps.markFailed).not.toHaveBeenCalled();
  });

  it("persists periodic progress once per whole percent", async () => {
    const h = makeHarness();

    await h.run(makePayload());

    expect(h.persisted()).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    // The final 100% belongs to completion, not to a progress write.
    expect(h.deps.updateProgress).not.toHaveBeenCalledWith(TASK_ID, 100);
  });

  it("never writes the same progress value twice", async () => {
    // 300s task: the first three ticks still floor to 0%, so they must not
    // write — only whole-percent changes are persisted.
    const h = makeHarness({ task: makeTask({ duration: 300 }) });

    await h.run(makePayload());

    const calls = h.persisted();
    expect(calls[0]).toBe(1);
    expect(calls[calls.length - 1]).toBe(99);
    expect(calls).toEqual([...new Set(calls)]);
    expect(calls).toEqual([...calls].sort((a, b) => a - b));
  });

  it("does nothing when the task is already terminal (both guarded claims miss)", async () => {
    const h = makeHarness({ claim: null });

    await h.run(makePayload());

    // The pending claim missed, so the recovery claim was attempted — and
    // found a terminal task, which must never be resurrected.
    expect(h.deps.restartProcessing).toHaveBeenCalledWith(TASK_ID);
    expect(h.slept).toEqual([]);
    expect(h.deps.updateProgress).not.toHaveBeenCalled();
    expect(h.deps.markCompleted).not.toHaveBeenCalled();
    expect(h.deps.markFailed).not.toHaveBeenCalled();
  });

  it("recovers a crashed attempt by restarting the simulation from 0%", async () => {
    // A redelivered job whose task is still `processing`: the previous
    // attempt's worker died, so this run takes over from the reset row.
    const h = makeHarness({
      claim: null,
      restart: makeTask({ status: "processing", progress: 0 }),
    });

    await h.run(makePayload());

    expect(h.deps.restartProcessing).toHaveBeenCalledWith(TASK_ID);
    expect(h.persisted()).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(h.deps.markCompleted).toHaveBeenCalledWith(TASK_ID);
    expect(h.deps.markFailed).not.toHaveBeenCalled();
  });

  it("fails deterministically at the halfway tick when shouldFail is set", async () => {
    const h = makeHarness();

    await h.run(makePayload({ shouldFail: true }));

    expect(h.slept).toEqual(Array(5).fill(1000));
    // Progress of the failing tick itself is never persisted — the task
    // keeps its last durable progress (40%).
    expect(h.persisted()).toEqual([10, 20, 30, 40]);
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
    // never crash the worker process.
    await expect(h.run(makePayload())).resolves.toBeUndefined();

    expect(h.deps.markFailed).toHaveBeenCalledWith(TASK_ID);
    expect(h.deps.markCompleted).not.toHaveBeenCalled();
  });
});

describe("task failure isolation", () => {
  it("one failing task settles as failed while a concurrent one completes", async () => {
    const TASK_ID_B = "11111111-2222-4333-8444-555555555555";
    // Two jobs, one shared task table: every write is a guarded UPDATE
    // keyed by the task id, so the failing run can only ever touch its own
    // row.
    const rows = new Map<string, Task>([
      [TASK_ID, makeTask()],
      [TASK_ID_B, makeTask({ id: TASK_ID_B })],
    ]);
    const guard = (
      id: string,
      from: Task["status"],
      to: Task["status"],
      data: Partial<Task>,
    ): Promise<Task | null> => {
      const row = rows.get(id);
      if (row === undefined || row.status !== from) {
        return Promise.resolve(null);
      }
      const updated: Task = { ...row, ...data, status: to, updatedAt: new Date() };
      rows.set(id, updated);
      return Promise.resolve(updated);
    };
    const run = createTaskRunner({
      findById: (id) => Promise.resolve(rows.get(id) ?? null),
      markProcessing: (id) => guard(id, "pending", "processing", { startedAt: new Date() }),
      restartProcessing: (id) => guard(id, "processing", "processing", { progress: 0 }),
      updateProgress: (id, progress) => guard(id, "processing", "processing", { progress }),
      markCompleted: (id) => guard(id, "processing", "completed", { progress: 100, completedAt: new Date() }),
      markFailed: (id) => guard(id, "processing", "failed", { failedAt: new Date() }),
      sleep: () => Promise.resolve(),
    });

    await Promise.all([
      run({ taskId: TASK_ID, shouldFail: true }),
      run({ taskId: TASK_ID_B, shouldFail: false }),
    ]);

    expect(rows.get(TASK_ID)?.status).toBe("failed");
    expect(rows.get(TASK_ID_B)?.status).toBe("completed");
  });
});

describe("toErrorMessage", () => {
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

  it("normalizes every unknown throwable to a loggable, public-safe string", () => {
    // Anything can be thrown in JS. The result must always be a non-empty
    // string that never leaks a spoofed shape: only real Error instances
    // expose their message, everything else falls back to a constant.
    const unknowns: unknown[] = [
      42,
      true,
      Symbol("thrown"),
      10n,
      () => undefined,
      ["nested"],
      { message: "spoofed error message" },
    ];
    for (const value of unknowns) {
      const message = toErrorMessage(value);
      expect(message, String(typeof value)).toBe("unknown error");
      expect(message.length).toBeGreaterThan(0);
    }
  });
});
