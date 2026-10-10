import { describe, expect, it } from "vitest";
import { calculateProgress } from "../../../src/modules/tasks/progress.ts";

describe("progress calculation", () => {
  it("floors elapsed over duration", () => {
    expect(calculateProgress(0, 10)).toBe(0);
    expect(calculateProgress(1000, 10)).toBe(10);
    expect(calculateProgress(5000, 10)).toBe(50);
    expect(calculateProgress(9900, 10)).toBe(99);
  });

  it("never rounds up", () => {
    // 49.9% floors to 49 — progress uses floor(), not round().
    expect(calculateProgress(4999, 10)).toBe(49);
  });

  it("clamps to 100 at and beyond the duration", () => {
    expect(calculateProgress(10_000, 10)).toBe(100);
    expect(calculateProgress(25_000, 10)).toBe(100);
  });

  it("clamps negative elapsed to 0", () => {
    expect(calculateProgress(-500, 10)).toBe(0);
  });

  it("stays within database bounds for long tasks", () => {
    // 300s is the maximum duration; early ticks floor to 0 and only whole
    // percent changes ever get persisted.
    expect(calculateProgress(1000, 300)).toBe(0);
    expect(calculateProgress(39_000, 300)).toBe(13);
    expect(calculateProgress(300_000, 300)).toBe(100);
  });
});
