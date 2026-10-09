import "dotenv/config"; // must run before any module reads process.env
import { Client } from "pg";
import { createApp } from "./app.ts";
import { env } from "../config/env.ts";
import { prisma } from "../lib/prisma.ts";
import { attachWebSocketGateway } from "../modules/websocket/gateway.ts";
import type { FindTaskSnapshot } from "../modules/websocket/handler.ts";
import { startTaskUpdateListener } from "../modules/websocket/listener.ts";
import { createTaskRepository } from "../modules/tasks/repository.ts";
import { ensureQueue } from "../queue/pg-boss.ts";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`AWTY API listening on http://localhost:${env.PORT}`);
  void checkDatabase();
  void startQueue();
});

// TASK-044 — the same HTTP server also serves /ws; TASK-047 — subscribe
// synchronizes against DB-authoritative state read through the repository.
const taskRepository = createTaskRepository(prisma);
const findTask: FindTaskSnapshot = async (taskId) => {
  const task = await taskRepository.findById(taskId);
  return task === null
    ? null
    : { id: task.id, status: task.status, progress: task.progress };
};
const gateway = attachWebSocketGateway(server, { findTask });

// TASK-053 — dedicated LISTEN client: worker updates flow
// trigger → listener → gateway.broadcast → subscribers (hints only).
const listener = startTaskUpdateListener({
  createClient: () => new Client({ connectionString: env.DATABASE_URL }),
  findTask,
  broadcast: gateway.broadcast,
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
  void listener.close();
  for (const client of gateway.wss.clients) {
    client.terminate();
  }
  gateway.wss.close();
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
