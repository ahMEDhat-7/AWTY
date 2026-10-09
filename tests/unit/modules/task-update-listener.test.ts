import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  TASK_UPDATES_CHANNEL,
  startTaskUpdateListener,
  type TaskUpdateListener,
} from "../../../src/modules/websocket/listener.ts";
import type { WsTaskUpdate as Update } from "../../../src/modules/websocket/protocol.ts";
import type { FindTaskSnapshot } from "../../../src/modules/websocket/handler.ts";
import type { TaskStateResponse } from "../../../src/modules/tasks/types.ts";

const TASK_ID = "33333333-3333-4333-8333-333333333333";

/** The TASK-014 trigger's payload shape; contents are only a hint. */
function hintPayload(taskId: string): string {
  return JSON.stringify({ id: taskId, status: "processing", progress: 10 });
}

function snapshot(
  progress: number,
  status: TaskStateResponse["status"] = "processing",
): TaskStateResponse {
  return { id: TASK_ID, status, progress };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await sleep(10);
  }
}

class FakeClient extends EventEmitter {
  readonly queries: string[] = [];
  connectResult: Promise<void> = Promise.resolve();
  ended = false;

  connect(): Promise<void> {
    return this.connectResult;
  }

  query(text: string): Promise<unknown> {
    this.queries.push(text);
    return Promise.resolve(undefined);
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }
}

function startFakeListener(options?: {
  failFirstConnect?: boolean;
  findTask?: FindTaskSnapshot;
}): {
  clients: FakeClient[];
  broadcasts: Update[];
  listener: TaskUpdateListener;
} {
  const clients: FakeClient[] = [];
  const broadcasts: Update[] = [];
  const listener = startTaskUpdateListener({
    createClient: () => {
      const client = new FakeClient();
      if (options?.failFirstConnect === true && clients.length === 0) {
        client.connectResult = Promise.reject(new Error("refused"));
      }
      clients.push(client);
      return client;
    },
    findTask: options?.findTask ?? (() => Promise.resolve(snapshot(50))),
    broadcast: (message) => void broadcasts.push(message),
    reconnectDelayMs: 5,
  });
  return { clients, broadcasts, listener };
}

function clientAt(clients: FakeClient[], index: number): FakeClient {
  const client = clients[index];
  if (client === undefined) {
    throw new Error(`expected a client at index ${index}`);
  }
  return client;
}

function deliver(client: FakeClient, payload: string | undefined): void {
  client.emit("notification", { channel: TASK_UPDATES_CHANNEL, payload });
}

describe("task update listener (TASK-053/054)", () => {
  it("connects a dedicated client and listens on the task_updates channel", async () => {
    const { clients, listener } = startFakeListener();

    await waitFor(() => clients.length === 1 && clientAt(clients, 0).queries.length > 0);
    expect(clientAt(clients, 0).queries).toEqual(["LISTEN task_updates"]);

    await listener.close();
  });

  it("broadcasts authoritative state, not the hint's contents", async () => {
    // The hint claims processing/10; the row says completed/100 — the row wins.
    const { clients, broadcasts, listener } = startFakeListener({
      findTask: () => Promise.resolve(snapshot(100, "completed")),
    });
    await waitFor(() => clients.length === 1);

    deliver(clientAt(clients, 0), hintPayload(TASK_ID));
    await waitFor(() => broadcasts.length === 1);
    expect(broadcasts).toEqual([{ type: "completed", taskId: TASK_ID }]);

    await listener.close();
  });

  it("maps terminal states to completed and failed broadcasts", async () => {
    const cases = [
      { status: "completed" as const, expected: { type: "completed", taskId: TASK_ID } },
      { status: "failed" as const, expected: { type: "failed", taskId: TASK_ID } },
    ];
    for (const { status, expected } of cases) {
      const { clients, broadcasts, listener } = startFakeListener({
        findTask: () => Promise.resolve(snapshot(33, status)),
      });
      await waitFor(() => clients.length === 1);

      deliver(clientAt(clients, 0), hintPayload(TASK_ID));
      await waitFor(() => broadcasts.length === 1);
      expect(broadcasts).toEqual([expected]);

      await listener.close();
    }
  });

  it("skips malformed payloads, non-string ids and vanished rows", async () => {
    const { clients, broadcasts, listener } = startFakeListener({
      findTask: () => Promise.resolve(null),
    });
    await waitFor(() => clients.length === 1);
    const client = clientAt(clients, 0);

    for (const payload of [
      undefined,
      "{broken json",
      JSON.stringify({ id: 42 }),
      JSON.stringify({ status: "processing" }),
      "null",
      hintPayload(TASK_ID), // well-formed, but the row is gone
    ]) {
      deliver(client, payload);
    }
    await sleep(25);
    expect(broadcasts).toEqual([]);

    await listener.close();
  });

  it("survives a failing snapshot read and keeps processing", async () => {
    let calls = 0;
    const { clients, broadcasts, listener } = startFakeListener({
      findTask: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("database gone"))
          : Promise.resolve(snapshot(66));
      },
    });
    await waitFor(() => clients.length === 1);
    const client = clientAt(clients, 0);

    deliver(client, hintPayload(TASK_ID));
    deliver(client, hintPayload(TASK_ID));
    await waitFor(() => broadcasts.length === 1);
    expect(broadcasts).toEqual([{ type: "progress", taskId: TASK_ID, progress: 66 }]);

    await listener.close();
  });

  it("processes notifications strictly in order", async () => {
    const resolvers: ((task: TaskStateResponse | null) => void)[] = [];
    const { clients, broadcasts, listener } = startFakeListener({
      findTask: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    });
    await waitFor(() => clients.length === 1);
    const client = clientAt(clients, 0);

    deliver(client, hintPayload(TASK_ID));
    deliver(client, hintPayload(TASK_ID));
    await waitFor(() => resolvers.length === 1);

    // Serialization: the second read must not even start until the first ends.
    await sleep(25);
    expect(resolvers.length).toBe(1);

    const first = resolvers[0];
    if (first === undefined) {
      throw new Error("expected the first read to be pending");
    }
    first(snapshot(33));
    await waitFor(() => resolvers.length === 2);
    const second = resolvers[1];
    if (second === undefined) {
      throw new Error("expected the second read to be pending");
    }
    second(snapshot(66));
    await waitFor(() => broadcasts.length === 2);
    expect(broadcasts).toEqual([
      { type: "progress", taskId: TASK_ID, progress: 33 },
      { type: "progress", taskId: TASK_ID, progress: 66 },
    ]);

    await listener.close();
  });

  it("ignores notifications from other channels", async () => {
    const { clients, broadcasts, listener } = startFakeListener();
    await waitFor(() => clients.length === 1);

    clientAt(clients, 0).emit("notification", {
      channel: "other",
      payload: hintPayload(TASK_ID),
    });
    await sleep(25);
    expect(broadcasts).toEqual([]);

    await listener.close();
  });

  it("reconnects with a fresh LISTEN client after a connection error", async () => {
    const { clients, listener } = startFakeListener();
    await waitFor(() => clients.length === 1);

    clientAt(clients, 0).emit("error", new Error("connection reset"));

    await waitFor(() => clients.length === 2);
    await waitFor(() => clientAt(clients, 1).queries.length > 0);
    expect(clientAt(clients, 1).queries).toEqual(["LISTEN task_updates"]);

    await listener.close();
  });

  it("retries with a new client after a failed connect", async () => {
    const { clients, listener } = startFakeListener({ failFirstConnect: true });

    await waitFor(() => clients.length === 2);
    await waitFor(() => clientAt(clients, 1).queries.length > 0);
    expect(clientAt(clients, 1).queries).toEqual(["LISTEN task_updates"]);

    await listener.close();
  });

  it("ends the connection and stops reconnecting after close", async () => {
    const { clients, listener } = startFakeListener();
    await waitFor(() => clients.length === 1);

    await listener.close();
    expect(clientAt(clients, 0).ended).toBe(true);

    clientAt(clients, 0).emit("error", new Error("late error"));
    await sleep(25);
    expect(clients.length).toBe(1);
  });

  it("ignores events from a stale client after reconnect", async () => {
    const { clients, broadcasts, listener } = startFakeListener();
    await waitFor(() => clients.length === 1);
    clientAt(clients, 0).emit("error", new Error("connection reset"));
    await waitFor(() => clients.length === 2);

    deliver(clientAt(clients, 0), hintPayload(TASK_ID));
    await sleep(25);
    expect(broadcasts).toEqual([]);

    // The fresh client still delivers.
    deliver(clientAt(clients, 1), hintPayload(TASK_ID));
    await waitFor(() => broadcasts.length === 1);

    await listener.close();
  });
});
