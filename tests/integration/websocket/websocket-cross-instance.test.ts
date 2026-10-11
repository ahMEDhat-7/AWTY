/**
 * Cross-instance WebSocket fan-out: two separately spawned API processes
 * (`dist/app/server.js`, the production entrypoint) on different ports,
 * each with its own HTTP server, gateway, subscription map, and dedicated
 * LISTEN connection — all against one PostgreSQL.
 *
 * The property under test: an update persisted by any writer (here the
 * test drives the same guarded repository writes a worker performs)
 * reaches subscribers connected to *every* API instance, because
 * propagation goes through the database trigger → pg_notify → each
 * instance's own listener — never through in-memory state shared
 * between processes.
 *
 * Prerequisites (self-skips when missing):
 * - PostgreSQL reachable through DATABASE_URL (.env)
 * - a built server: `pnpm build` (the suite spawns dist/app/server.js)
 */
import "dotenv/config"; // must run before any module reads process.env
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { prisma } from "../../../src/lib/prisma.ts";
import { createTaskRepository } from "../../../src/modules/tasks/repository.ts";

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
const serverBuilt = existsSync("dist/app/server.js");
if (!dbReady || !serverBuilt) {
  console.warn(
    `cross-instance suite skipped — postgres reachable: ${dbReady}, built server: ${serverBuilt}`,
  );
}

/** Reserves an ephemeral port and immediately releases it for the spawn. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const chosen = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(chosen));
    });
  });
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

function spawnApi(port: number): ChildProcess {
  return spawn(process.execPath, ["dist/app/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitHealthy(port: number, proc: ChildProcess): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`api process on port ${port} exited with ${proc.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // not listening yet — keep polling
    }
    if (Date.now() - start > 20_000) {
      throw new Error(`timed out waiting for api on port ${port} to become healthy`);
    }
    await sleep(200);
  }
}

interface Frame {
  type: string;
  taskId?: string;
  status?: string;
  progress?: number;
}

function toText(data: RawData): string {
  return Buffer.isBuffer(data)
    ? data.toString()
    : Array.isArray(data)
      ? Buffer.concat(data).toString()
      : Buffer.from(data).toString();
}

interface WsHandle {
  socket: WebSocket;
  frames: Frame[];
}

async function connectAndSubscribe(
  port: number,
  taskId: string,
): Promise<WsHandle> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: Frame[] = [];
  socket.on("message", (data: RawData) => {
    frames.push(JSON.parse(toText(data)) as Frame);
  });
  socket.send(JSON.stringify({ type: "subscribe", taskId }));
  await waitFor(() => frames.some((frame) => frame.type === "state"), 10_000, "state frame");
  return { socket, frames };
}

// ---------------------------------------------------------------------------
// Harness state
// ---------------------------------------------------------------------------

let apiA: ChildProcess | undefined;
let apiB: ChildProcess | undefined;
let portA = 0;
let portB = 0;

describe.skipIf(!dbReady || !serverBuilt)("websocket cross-instance fan-out", () => {
  beforeAll(async () => {
    [portA, portB] = await Promise.all([freePort(), freePort()]);
    apiA = spawnApi(portA);
    apiB = spawnApi(portB);
    await Promise.all([waitHealthy(portA, apiA), waitHealthy(portB, apiB)]);
  }, 40_000);

  afterAll(async () => {
    for (const proc of [apiA, apiB]) {
      if (proc !== undefined && proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
        await once(proc, "exit");
      }
    }
    apiA = undefined;
    apiB = undefined;
    await prisma.$disconnect();
  }, 30_000);

  it("delivers one persisted update to subscribers on both API instances", async () => {
    const repository = createTaskRepository(prisma);

    // The row is inserted directly (no queue job), so no worker can claim
    // it — the test alone drives the state, keeping it hermetic while the
    // writes themselves are exactly the guarded ones the worker performs.
    const { id: taskId } = await prisma.task.create({ data: { duration: 60 } });

    // One subscriber per instance — separate processes, separate
    // subscription maps, separate LISTEN connections.
    const [handleA, handleB] = await Promise.all([
      connectAndSubscribe(portA, taskId),
      connectAndSubscribe(portB, taskId),
    ]);

    try {
      // Both instances answer the subscribe with the DB-authoritative
      // snapshot — neither holds task state in memory.
      for (const handle of [handleA, handleB]) {
        const state = handle.frames.find((frame) => frame.type === "state");
        expect(state).toMatchObject({ taskId, status: "pending", progress: 0 });
      }

      // Persist the same guarded writes a worker performs. The database
      // trigger notifies both instances; neither process was told anything
      // directly.
      expect(await repository.markProcessing(taskId)).not.toBeNull();
      expect(await repository.updateProgress(taskId, 40)).not.toBeNull();
      expect(await repository.updateProgress(taskId, 80)).not.toBeNull();
      expect(await repository.markCompleted(taskId)).not.toBeNull();

      // Each instance's listener must independently pick up the change
      // and fan it out to its own subscriber.
      for (const [name, handle] of [
        ["A", handleA],
        ["B", handleB],
      ] as const) {
        await waitFor(
          () =>
            handle.frames.some(
              (frame) => frame.type === "progress" && frame.progress === 80,
            ) && handle.frames.some((frame) => frame.type === "completed"),
          15_000,
          `progress and completed frames on instance ${name}`,
        );
        const progress = handle.frames.find(
          (frame) => frame.type === "progress" && frame.progress === 40,
        );
        expect(progress, `instance ${name} saw the 40% frame`).toBeDefined();
        const terminal = handle.frames.find((frame) => frame.type === "completed");
        expect(terminal).toMatchObject({ taskId });
      }
    } finally {
      handleA.socket.close();
      handleB.socket.close();
    }
  }, 40_000);

  it("keeps REST reads on either instance consistent with the persisted state", async () => {
    const repository = createTaskRepository(prisma);
    // Direct insert again: hermetic against any running worker.
    const { id: taskId } = await prisma.task.create({ data: { duration: 45 } });

    expect(await repository.markProcessing(taskId)).not.toBeNull();
    expect(await repository.updateProgress(taskId, 55)).not.toBeNull();

    // Written through the repository, read through both HTTP instances:
    // every reader sees the same persisted truth regardless of process.
    for (const port of [portA, portB]) {
      const read = await fetch(`http://127.0.0.1:${port}/tasks/${taskId}`);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        id: taskId,
        status: "processing",
        progress: 55,
      });
    }

    expect(await repository.markFailed(taskId)).not.toBeNull();
  }, 30_000);
});
