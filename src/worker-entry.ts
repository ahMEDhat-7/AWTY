import "dotenv/config"; // must run before any module reads process.env
import { prisma } from "./lib/prisma.ts";
import { createTaskRepository } from "./modules/tasks/repository.ts";
import { createTaskRunner } from "./modules/tasks/runner.ts";
import { boss } from "./queue/pg-boss.ts";
import { startTaskConsumer } from "./queue/worker.ts";

/**
 * The worker entrypoint: an independent process in the same package and
 * image as the API (`node dist/worker-entry.js`). It consumes queue jobs;
 * the API never does.
 */
const repository = createTaskRepository(prisma);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const runTask = createTaskRunner({
  findById: (id) => repository.findById(id),
  markProcessing: (id) => repository.markProcessing(id),
  // Crash recovery: a redelivered job for a task stuck in `processing`
  // restarts the simulation from 0%.
  restartProcessing: (id) => repository.restartProcessing(id),
  updateProgress: (id, progress) => repository.updateProgress(id, progress),
  markCompleted: (id) => repository.markCompleted(id),
  markFailed: (id) => repository.markFailed(id),
  sleep,
});

await startTaskConsumer(runTask);
console.log("AWTY worker consuming awty-tasks");

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  await boss.stop();
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
