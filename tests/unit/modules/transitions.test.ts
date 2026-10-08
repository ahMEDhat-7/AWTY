import { describe, expect, it } from "vitest";
import {
  canTransition,
  checkTransition,
  type StateTransitionResult,
} from "../../../src/modules/tasks/transitions.ts";
import { TASK_STATUSES, type TaskStatus } from "../../../src/modules/tasks/types.ts";

const VALID: ReadonlyArray<readonly [TaskStatus, TaskStatus]> = [
  ["pending", "processing"],
  ["processing", "completed"],
  ["processing", "failed"],
];

function isValidPair(from: TaskStatus, to: TaskStatus): boolean {
  return VALID.some(([validFrom, validTo]) => validFrom === from && validTo === to);
}

describe("state transitions (TASK-017)", () => {
  it.each(VALID)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    const result: StateTransitionResult = checkTransition({ from, to });
    expect(result).toEqual({ ok: true, from, to });
  });

  it("rejects every pair not in the allowed set", () => {
    const invalidPairs = TASK_STATUSES.flatMap((from) =>
      TASK_STATUSES.filter((to) => !isValidPair(from, to)).map((to) => [from, to] as const),
    );

    expect(invalidPairs).toHaveLength(TASK_STATUSES.length ** 2 - VALID.length);

    for (const [from, to] of invalidPairs) {
      const result = checkTransition({ from, to });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.from).toBe(from);
        expect(result.to).toBe(to);
        expect(result.reason).toContain(`${from} -> ${to}`);
      }
    }
  });

  it("rejects skipping the processing phase", () => {
    expect(canTransition("pending", "completed")).toBe(false);
    expect(canTransition("pending", "failed")).toBe(false);
  });

  it("treats completed and failed as terminal", () => {
    for (const to of TASK_STATUSES) {
      expect(canTransition("completed", to)).toBe(false);
      expect(canTransition("failed", to)).toBe(false);
    }
  });

  it("rejects self-transitions", () => {
    for (const status of TASK_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});
