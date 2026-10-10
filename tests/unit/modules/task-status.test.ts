import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_STATUSES } from "../../../src/modules/tasks/types.ts";

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  "../../../prisma/migrations",
);

describe("task status", () => {
  it("exposes exactly the four PRD states in order", () => {
    expect([...TASK_STATUSES]).toEqual([
      "pending",
      "processing",
      "completed",
      "failed",
    ]);
  });

  it("matches the database enum declared in the init migration", () => {
    const initDir = readdirSync(MIGRATIONS_DIR).find((entry) =>
      entry.endsWith("_init"),
    );
    expect(initDir).toBeDefined();
    if (initDir === undefined) {
      throw new Error("init migration directory not found");
    }

    const sql = readFileSync(
      path.join(MIGRATIONS_DIR, initDir, "migration.sql"),
      "utf8",
    );
    const match = /CREATE TYPE "TaskStatus" AS ENUM \(([^)]+)\)/.exec(sql);
    expect(match).not.toBeNull();
    if (match === null || match[1] === undefined) {
      throw new Error("TaskStatus enum not found in init migration");
    }

    const dbValues = [...match[1].matchAll(/'([^']+)'/g)].map(
      (captured) => captured[1],
    );
    expect(dbValues).toEqual([...TASK_STATUSES]);
  });
});
