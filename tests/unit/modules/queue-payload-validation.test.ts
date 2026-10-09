import { describe, expect, it } from "vitest";
import { parseQueuePayload } from "../../../src/modules/tasks/dto.ts";

const TASK_ID = "0b7f8f3e-1c2d-4a5b-9e8f-112233445566";

describe("queue payload validation (TASK-020)", () => {
  it("accepts a well-formed job payload", () => {
    expect(parseQueuePayload({ taskId: TASK_ID })).toEqual({
      ok: true,
      data: { taskId: TASK_ID },
    });
    expect(parseQueuePayload({ taskId: TASK_ID, shouldFail: true })).toEqual({
      ok: true,
      data: { taskId: TASK_ID, shouldFail: true },
    });
  });

  it("rejects arbitrary data the queue might hand us", () => {
    const untrusted: unknown[] = [
      undefined,
      null,
      "",
      "task-1",
      42,
      true,
      [],
      {},
      { taskId: "task-1" },
      { taskId: 42 },
      { taskId: TASK_ID, shouldFail: "true" },
      { taskId: TASK_ID, shouldFail: 1 },
      { shouldFail: true },
    ];
    for (const payload of untrusted) {
      expect(
        parseQueuePayload(payload).ok,
        JSON.stringify(payload),
      ).toBe(false);
    }
  });

  it("never throws on arbitrary payload data", () => {
    expect(() => parseQueuePayload(undefined)).not.toThrow();
    expect(() => parseQueuePayload(Symbol("job"))).not.toThrow();
    expect(() => parseQueuePayload(new Date())).not.toThrow();
  });

  it("strips unknown payload keys instead of trusting them", () => {
    expect(
      parseQueuePayload({ taskId: TASK_ID, attempts: 3, queue: "awty" }),
    ).toEqual({
      ok: true,
      data: { taskId: TASK_ID },
    });
  });

  it("reports the failing path for rejected payloads", () => {
    const result = parseQueuePayload({ taskId: "not-a-uuid" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a validation failure");
    }
    expect(result.issues[0]?.path).toBe("taskId");
    expect(result.issues[0]?.message.length).toBeGreaterThan(0);
  });
});
