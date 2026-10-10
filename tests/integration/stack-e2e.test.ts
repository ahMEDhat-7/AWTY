/**
 * Stack integration/E2E: the real Express app (`createApp`),
 * real PostgreSQL, real pg-boss queue, the real LISTEN → broadcast pipeline,
 * and a real spawned worker subprocess (`dist/worker-entry.js`) — wired the
 * same way `src/app/server.ts` wires them in production.
 *
 * Prerequisites (self-skips when missing):
 * - PostgreSQL reachable through DATABASE_URL (.env)
 * - a built worker: `pnpm build` (the suite spawns dist/worker-entry.js)
 * - no other worker-entry process consuming `awty-tasks` — a stray dev
 *   worker would race this suite's worker and make the kill-and-recover
 *   scenario non-deterministic.
 */
import "dotenv/config"; // must run before any module reads process.env
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createApp } from "../../src/app/app.ts";
import { env } from "../../src/config/env.ts";
import { prisma } from "../../src/lib/prisma.ts";
import {
  attachWebSocketGateway,
  type WebSocketGateway,
} from "../../src/modules/websocket/gateway.ts";
import type { FindTaskSnapshot } from "../../src/modules/websocket/handler.ts";
import { startTaskUpdateListener } from "../../src/modules/websocket/listener.ts";
import { createTaskRepository } from "../../src/modules/tasks/repository.ts";
import { TASK_QUEUE_NAME } from "../../src/queue/config.ts";
import { boss, ensureQueue } from "../../src/queue/pg-boss.ts";

/** True when PostgreSQL answers a plain connection within 4s. */
async function probeDatabase(): Promise<boolean> {
  const client = new Client({ connectionString: process.env.DATABASE_URL ?? "" });
  const connecting = client.connect();
  void connecting.catch(() => undefined); // a late rejection must not escape the race
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("database probe timed out")), 4000);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    try {
      await client.end();
    } catch {
      // never connected, or already closed — nothing to release
    }
  }
}

const dbReady = await probeDatabase();
const workerBuilt = existsSync(join(process.cwd(), "dist/worker-entry.js"));
if (!dbReady || !workerBuilt) {
  console.warn(
    `stack E2E skipped — postgres reachable: ${dbReady}, built worker: ${workerBuilt}`,
  );
}

// ---------------------------------------------------------------------------
// Harness (mirrors src/app/server.ts)
// ---------------------------------------------------------------------------

const WORKER_LOG = join(tmpdir(), "awty-stack-e2e-worker.log");

let server: Server;
let gateway: WebSocketGateway;
let listener: ReturnType<typeof startTaskUpdateListener> | undefined;
let worker: ChildProcess | undefined;
let port = 0;

const base = (): string => `http://127.0.0.1:${port}`;

function startWorker(): ChildProcess {
  const proc = spawn(process.execPath, ["dist/worker-entry.js"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = (chunk: Buffer): void => appendFileSync(WORKER_LOG, chunk);
  proc.stdout?.on("data", record);
  proc.stderr?.on("data", record);
  worker = proc;
  return proc;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(100);
  }
}

function statusOf(body: Record<string, unknown>): string {
  return typeof body.status === "string" ? body.status : "";
}

function progressOf(body: Record<string, unknown>): number {
  return typeof body.progress === "number" ? body.progress : -1;
}

function idOf(body: Record<string, unknown>): string {
  if (typeof body.id !== "string") {
    throw new Error(`expected a task id in ${JSON.stringify(body)}`);
  }
  return body.id;
}

async function postTask(
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base()}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function fetchTask(
  id: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base()}/tasks/${id}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function waitForTask(
  id: string,
  predicate: (body: Record<string, unknown>) => boolean,
  timeoutMs: number,
  label: string,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const { status, body } = await fetchTask(id);
    if (status === 200 && predicate(body)) {
      return body;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label} — last seen: ${JSON.stringify(body)}`);
    }
    await sleep(150);
  }
}

interface JobRow {
  name: string;
  state: string;
  retry_count: number;
}

function jobRows(taskId: string): Promise<JobRow[]> {
  return prisma.$queryRaw<JobRow[]>`
    SELECT name, state, retry_count FROM pgboss.job
    WHERE data->>'taskId' = ${taskId}`;
}

interface Frame {
  type: string;
  taskId?: string;
  status?: string;
  progress?: number;
}

interface WsHandle {
  socket: WebSocket;
  frames: Frame[];
}

function toText(data: RawData): string {
  return Buffer.isBuffer(data)
    ? data.toString()
    : Array.isArray(data)
      ? Buffer.concat(data).toString()
      : Buffer.from(data).toString();
}

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function connectAndSubscribe(taskId: string): Promise<WsHandle> {
  const socket = await openSocket();
  const frames: Frame[] = [];
  socket.on("message", (data: RawData) => {
    frames.push(JSON.parse(toText(data)) as Frame);
  });
  socket.send(JSON.stringify({ type: "subscribe", taskId }));
  await waitFor(() => frames.some((frame) => frame.type === "state"), 5000, "state frame");
  return { socket, frames };
}

function isTerminalFrame(frame: Frame): boolean {
  return (
    frame.type === "completed" ||
    frame.type === "failed" ||
    (frame.type === "state" &&
      (frame.status === "completed" || frame.status === "failed"))
  );
}

async function waitTerminalFrame(handle: WsHandle, timeoutMs: number): Promise<Frame> {
  await waitFor(() => handle.frames.some(isTerminalFrame), timeoutMs, "terminal frame");
  const frame = handle.frames.find(isTerminalFrame);
  if (frame === undefined) {
    throw new Error("terminal frame vanished");
  }
  return frame;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe.skipIf(!dbReady || !workerBuilt)("stack E2E", () => {
  beforeAll(async () => {
    writeFileSync(WORKER_LOG, ""); // fresh log so the kill-and-recover assertions read only this suite's output
    await ensureQueue();

    const app = createApp();
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    port = (server.address() as AddressInfo).port;

    const repository = createTaskRepository(prisma);
    const findTask: FindTaskSnapshot = async (taskId) => {
      const task = await repository.findById(taskId);
      return task === null
        ? null
        : { id: task.id, status: task.status, progress: task.progress };
    };
    gateway = attachWebSocketGateway(server, { findTask });
    listener = startTaskUpdateListener({
      createClient: () => new Client({ connectionString: env.DATABASE_URL }),
      findTask,
      broadcast: gateway.broadcast,
    });

    startWorker();
    await waitFor(
      () => readFileSync(WORKER_LOG, "utf8").includes("consuming awty-tasks"),
      20_000,
      "worker consuming the queue",
    );
  }, 30_000);

  afterAll(async () => {
    if (worker !== undefined && worker.exitCode === null && worker.signalCode === null) {
      worker.kill("SIGKILL");
      await once(worker, "exit");
    }
    worker = undefined;
    await listener?.close();
    for (const client of gateway.wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => gateway.wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await boss.stop();
    await prisma.$disconnect();
  }, 30_000);

  it("serves /docs and /openapi.json against the running app", async () => {
    const specResponse = await fetch(`${base()}/openapi.json`);
    expect(specResponse.status).toBe(200);
    const document = (await specResponse.json()) as {
      openapi?: string;
      paths?: Record<string, Record<string, unknown>>;
    };
    expect(document.openapi).toMatch(/^3\.1/);
    expect(Object.keys(document.paths ?? {})).toEqual(
      expect.arrayContaining(["/tasks", "/tasks/{id}"]),
    );
    expect(document.paths?.["/tasks"]?.post).toBeDefined();
    expect(document.paths?.["/tasks/{id}"]?.get).toBeDefined();

    const docsResponse = await fetch(`${base()}/docs`);
    expect(docsResponse.status).toBe(200);
    expect(docsResponse.headers.get("content-type")).toContain("text/html");
  }, 15_000);

  it("POST /tasks yields the HTTP response, task row and queue job", async () => {
    const created = await postTask({ duration: 4 });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("pending");
    const id = idOf(created.body);

    const row = await prisma.task.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row?.duration).toBe(4);

    const jobs = await jobRows(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe(TASK_QUEUE_NAME);
  }, 15_000);

  it("GET /tasks/:id for a missing task answers 404 not_found", async () => {
    const { status, body } = await fetchTask("00000000-0000-4000-8000-000000000000");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not_found" });
  }, 10_000);

  it("GET /tasks/:id returns the current persistent state", async () => {
    const id = idOf((await postTask({ duration: 4 })).body);
    const done = await waitForTask(id, (task) => statusOf(task) === "completed", 25_000, "completion");
    const row = await prisma.task.findUnique({ where: { id } });

    expect(row?.status).toBe("completed");
    expect(row?.progress).toBe(100);
    expect(row?.completedAt).not.toBeNull();
    expect(done).toMatchObject({ id, status: "completed", progress: 100 });
    expect(statusOf(done)).toBe(row?.status);
    expect(progressOf(done)).toBe(row?.progress);
  }, 30_000);

  it("completes end to end: POST → pg-boss → worker → processing → progress → completed", async () => {
    const id = idOf((await postTask({ duration: 5 })).body);
    const seen: Array<{ status: string; progress: number }> = [];
    const start = Date.now();
    let final: Record<string, unknown> | undefined;
    while (final === undefined) {
      const { status, body } = await fetchTask(id);
      if (status === 200) {
        seen.push({ status: statusOf(body), progress: progressOf(body) });
        if (statusOf(body) === "completed" || statusOf(body) === "failed") {
          final = body;
        }
      }
      if (Date.now() - start > 25_000) {
        throw new Error(`timed out in E2E completion — last: ${JSON.stringify(body)}`);
      }
      if (final === undefined) {
        await sleep(150);
      }
    }

    expect(seen.some((snapshot) => snapshot.status === "processing" && snapshot.progress > 0)).toBe(true);
    expect(final).toMatchObject({ status: "completed", progress: 100 });
  }, 40_000);

  it("streams WebSocket progress messages while the task is processing", async () => {
    const id = idOf((await postTask({ duration: 6 })).body);
    const handle = await connectAndSubscribe(id);
    const terminal = await waitTerminalFrame(handle, 25_000);
    handle.socket.close();

    expect(terminal.taskId).toBe(id);
    const values = handle.frames
      .filter((frame) => frame.type === "progress")
      .map((frame) => frame.progress ?? -1);
    expect(values.length).toBeGreaterThanOrEqual(1);
    // The claim itself (pending → processing) fires a notification while
    // progress is still 0, so 0 is a legitimate frame; completion is
    // delivered as its own frame type, so progress frames stay below 100.
    expect(values.every((value) => value >= 0 && value < 100)).toBe(true);
    // the LISTEN chain serializes broadcasts, so subscribers see them in order
    expect(values.every((value, index) => index === 0 || value >= (values[index - 1] ?? 0))).toBe(true);
  }, 40_000);

  it("delivers the WebSocket completion message", async () => {
    const id = idOf((await postTask({ duration: 4 })).body);
    const handle = await connectAndSubscribe(id);
    const terminal = await waitTerminalFrame(handle, 25_000);
    handle.socket.close();

    expect(terminal).toMatchObject({ type: "completed", taskId: id });
  }, 40_000);

  it("reflects an injected failure on both REST and WebSocket", async () => {
    const id = idOf((await postTask({ duration: 10, shouldFail: true })).body);
    const handle = await connectAndSubscribe(id);
    const terminal = await waitTerminalFrame(handle, 30_000);
    handle.socket.close();
    expect(terminal).toMatchObject({ type: "failed", taskId: id });

    const rest = await fetchTask(id);
    expect(rest.status).toBe(200);
    expect(statusOf(rest.body)).toBe("failed");
    expect(progressOf(rest.body)).toBeLessThan(100); // last durable progress preserved

    const row = await prisma.task.findUnique({ where: { id } });
    expect(row?.status).toBe("failed");
    expect(row?.failedAt).not.toBeNull();
    expect(row?.completedAt).toBeNull();
  }, 45_000);

  it("sends updates to two subscribers of the same task", async () => {
    const id = idOf((await postTask({ duration: 6 })).body);
    const first = await connectAndSubscribe(id);
    const second = await connectAndSubscribe(id);
    const [terminalA, terminalB] = await Promise.all([
      waitTerminalFrame(first, 30_000),
      waitTerminalFrame(second, 30_000),
    ]);
    first.socket.close();
    second.socket.close();

    expect(terminalA).toMatchObject({ type: "completed", taskId: id });
    expect(terminalB).toMatchObject({ type: "completed", taskId: id });
    expect(first.frames.some((frame) => frame.type === "progress")).toBe(true);
    expect(second.frames.some((frame) => frame.type === "progress")).toBe(true);
  }, 45_000);

  it("disconnects mid-task, reconnects and resynchronizes state", async () => {
    const id = idOf((await postTask({ duration: 8 })).body);
    const first = await connectAndSubscribe(id);
    expect(first.frames[0]?.type).toBe("state");
    await sleep(3000);
    first.socket.terminate();

    const whileGone = await fetchTask(id);
    await sleep(3000);
    const later = await fetchTask(id);
    const advanced =
      progressOf(later.body) > progressOf(whileGone.body) ||
      statusOf(whileGone.body) === "completed" ||
      statusOf(later.body) === "completed";
    expect(advanced).toBe(true); // processing is unaffected by the disconnect

    const second = await connectAndSubscribe(id);
    const resync = second.frames[0];
    expect(resync?.taskId).toBe(id);
    const synced =
      resync?.status === "completed" ||
      resync?.status === "failed" ||
      (resync?.progress ?? -1) >= progressOf(later.body);
    expect(synced).toBe(true); // the fresh subscription reflects post-disconnect state

    const terminal = await waitTerminalFrame(second, 30_000);
    expect(terminal.taskId).toBe(id);
    const final = await fetchTask(id);
    expect(["completed", "failed"]).toContain(statusOf(final.body));
    second.socket.close();
  }, 60_000);

  it("runs different-duration tasks concurrently with independent progress", async () => {
    const a = idOf((await postTask({ duration: 10 })).body);
    const b = idOf((await postTask({ duration: 3 })).body);
    const c = idOf((await postTask({ duration: 5 })).body);
    const [taskA, taskB, taskC] = await Promise.all([
      waitForTask(a, (task) => statusOf(task) === "completed", 40_000, "task A"),
      waitForTask(b, (task) => statusOf(task) === "completed", 40_000, "task B"),
      waitForTask(c, (task) => statusOf(task) === "completed", 40_000, "task C"),
    ]);
    expect(statusOf(taskA)).toBe("completed");
    expect(statusOf(taskB)).toBe("completed");
    expect(statusOf(taskC)).toBe("completed");

    const rows = await prisma.task.findMany({ where: { id: { in: [a, b, c] } } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const doneA = byId.get(a)?.completedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const doneB = byId.get(b)?.completedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const doneC = byId.get(c)?.completedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    expect(doneB).toBeLessThan(doneA); // 3s task did not wait for the 10s task
    expect(doneC).toBeLessThan(doneA); // 5s task did not wait for the 10s task
  }, 60_000);

  it("SIGKILLs a worker mid-task and a fresh worker completes the task", async () => {
    const id = idOf((await postTask({ duration: 30 })).body);
    await waitForTask(
      id,
      (task) => statusOf(task) === "processing" && progressOf(task) >= 5,
      30_000,
      "the spawned worker to claim the task",
    );

    const killed = worker;
    if (killed === undefined || killed.exitCode !== null) {
      throw new Error("expected a running spawned worker");
    }
    const exited = once(killed, "exit");
    killed.kill("SIGKILL");
    await exited;
    worker = undefined;

    // nobody consumes now: the task must be frozen, not progressing
    const frozen1 = await fetchTask(id);
    await sleep(2000);
    const frozen2 = await fetchTask(id);
    expect(statusOf(frozen1.body)).toBe("processing");
    expect(statusOf(frozen2.body)).toBe("processing");
    expect(progressOf(frozen2.body)).toBe(progressOf(frozen1.body));

    // a fresh worker recovers: pg-boss redelivery → restart from 0% → completed
    startWorker();
    await waitForTask(id, (task) => statusOf(task) === "completed", 180_000, "recovery completion");
    expect(readFileSync(WORKER_LOG, "utf8")).toContain("recovered: restarting from 0%");
    const jobs = await jobRows(id);
    expect(jobs[0]?.retry_count ?? 0).toBeGreaterThanOrEqual(1);
  }, 240_000);
});
