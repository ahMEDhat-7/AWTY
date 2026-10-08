import { describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.PORT = "4001";
process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";

const { env, envSchema } = await import("../../src/config/env.ts");

describe("env schema", () => {
  it("accepts a valid configuration", () => {
    const result = envSchema.safeParse({
      NODE_ENV: "test",
      PORT: 4000,
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing DATABASE_URL", () => {
    const result = envSchema.safeParse({
      NODE_ENV: "test",
      PORT: 4000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range PORT", () => {
    const result = envSchema.safeParse({
      NODE_ENV: "test",
      PORT: 70000,
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    const result = envSchema.safeParse({
      NODE_ENV: "test",
      PORT: 4000,
      DATABASE_URL: "mysql://user:pass@localhost:5432/db",
    });
    expect(result.success).toBe(false);
  });

  it("exports the parsed environment", () => {
    expect(env.NODE_ENV).toBe("test");
    expect(env.PORT).toBe(4001);
    expect(env.DATABASE_URL).toContain("postgresql://");
  });
});
