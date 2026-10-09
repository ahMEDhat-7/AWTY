import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCreateTaskBody } from "../../../src/modules/tasks/dto.ts";

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  "../../../prisma/migrations",
);

describe("create task body validation (TASK-018)", () => {
  it("accepts durations at both documented bounds", () => {
    expect(parseCreateTaskBody({ duration: 1 })).toEqual({
      ok: true,
      data: { duration: 1 },
    });
    expect(parseCreateTaskBody({ duration: 300 })).toEqual({
      ok: true,
      data: { duration: 300 },
    });
  });

  it("accepts shouldFail when it is a boolean", () => {
    expect(parseCreateTaskBody({ duration: 10, shouldFail: true })).toEqual({
      ok: true,
      data: { duration: 10, shouldFail: true },
    });
    expect(parseCreateTaskBody({ duration: 10, shouldFail: false })).toEqual({
      ok: true,
      data: { duration: 10, shouldFail: false },
    });
  });

  it("rejects durations outside 1..300 or of the wrong type", () => {
    const rejected: unknown[] = [
      { duration: 0 },
      { duration: -1 },
      { duration: 301 },
      { duration: 1.5 },
      { duration: "10" },
      { duration: null },
      { duration: undefined },
      { duration: true },
    ];
    for (const body of rejected) {
      expect(parseCreateTaskBody(body).ok, JSON.stringify(body)).toBe(false);
    }
  });

  it("rejects missing, malformed and non-object bodies", () => {
    const rejected: unknown[] = [
      undefined,
      null,
      {},
      "duration=10",
      10,
      [10],
      [{ duration: 10 }],
    ];
    for (const body of rejected) {
      expect(parseCreateTaskBody(body).ok, JSON.stringify(body)).toBe(false);
    }
  });

  it("reports the failing field path for error responses", () => {
    const result = parseCreateTaskBody({ duration: 301 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a validation failure");
    }
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.path).toBe("duration");
    expect(result.issues[0]?.message.length).toBeGreaterThan(0);
  });

  it("strips unknown keys instead of failing", () => {
    expect(parseCreateTaskBody({ duration: 10, bogus: "x" })).toEqual({
      ok: true,
      data: { duration: 10 },
    });
  });

  it("matches the database duration CHECK constraint", () => {
    const initDir = readdirSync(MIGRATIONS_DIR).find((entry) =>
      entry.endsWith("_init"),
    );
    if (initDir === undefined) {
      throw new Error("init migration directory not found");
    }
    const sql = readFileSync(
      path.join(MIGRATIONS_DIR, initDir, "migration.sql"),
      "utf8",
    );
    const match = /CHECK \("duration" >= (\d+) AND "duration" <= (\d+)\)/.exec(
      sql,
    );
    expect(match).not.toBeNull();
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new Error("Task_duration_range constraint not found in migration");
    }
    const min = Number(match[1]);
    const max = Number(match[2]);
    expect(parseCreateTaskBody({ duration: min }).ok).toBe(true);
    expect(parseCreateTaskBody({ duration: min - 1 }).ok).toBe(false);
    expect(parseCreateTaskBody({ duration: max }).ok).toBe(true);
    expect(parseCreateTaskBody({ duration: max + 1 }).ok).toBe(false);
  });
});
