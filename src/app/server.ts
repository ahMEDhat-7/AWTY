import "dotenv/config"; // must run before any module reads process.env
import { createApp } from "./app.ts";
import { env } from "../config/env.ts";
import { prisma } from "../lib/prisma.ts";
import { ensureQueue } from "../queue/pg-boss.ts";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`AWTY API listening on http://localhost:${env.PORT}`);
  void checkDatabase();
  void startQueue();
});

async function checkDatabase(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log("database: connected");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`database: connection failed — ${message}`);
  }
}

async function startQueue(): Promise<void> {
  try {
    await ensureQueue();
    console.log("queue: ready");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`queue: init failed — ${message}`);
  }
}

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    process.exit(0);
  });
}

process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  shutdown("SIGINT");
});
