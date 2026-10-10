import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  attachWebSocketGateway,
  type WebSocketGateway,
} from "../../src/modules/websocket/gateway.ts";
import type { TaskStateResponse } from "../../src/modules/tasks/types.ts";

const TASK_A: TaskStateResponse = {
  id: randomUUID(),
  status: "processing",
  progress: 40,
};
const TASK_B: TaskStateResponse = {
  id: randomUUID(),
  status: "completed",
  progress: 100,
};

let server: Server;
let gateway: WebSocketGateway;
let port: number;

beforeAll(async () => {
  server = createServer();
  gateway = attachWebSocketGateway(server, {
    findTask: (taskId) =>
      Promise.resolve(
        taskId === TASK_A.id ? TASK_A : taskId === TASK_B.id ? TASK_B : null,
      ),
  });
  port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
});

afterAll(async () => {
  for (const client of gateway.wss.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve, reject) =>
    gateway.wss.close((error) => (error ? reject(error) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function openClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function toText(data: RawData): string {
  return Buffer.isBuffer(data)
    ? data.toString()
    : Array.isArray(data)
      ? Buffer.concat(data).toString()
      : Buffer.from(data).toString();
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(JSON.parse(toText(data)) as Record<string, unknown>);
    });
  });
}

function expectSilence(socket: WebSocket, ms = 150): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData): void => {
      clearTimeout(timer);
      reject(new Error(`unexpected message: ${toText(data)}`));
    };
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve();
    }, ms);
    socket.once("message", onMessage);
  });
}

async function subscribe(
  socket: WebSocket,
  taskId: string,
): Promise<Record<string, unknown>> {
  socket.send(JSON.stringify({ type: "subscribe", taskId }));
  return nextMessage(socket);
}

describe("websocket protocol", () => {
  it("answers subscribe with the current state sync message", async () => {
    const socket = await openClient();

    expect(await subscribe(socket, TASK_A.id)).toEqual({
      type: "state",
      taskId: TASK_A.id,
      status: "processing",
      progress: 40,
    });

    socket.close();
  });

  it("answers subscribe to an unknown task with not_found", async () => {
    const socket = await openClient();
    const unknownId = randomUUID();

    expect(await subscribe(socket, unknownId)).toEqual({
      type: "error",
      error: "not_found",
    });
    expect(gateway.subscriptions.getSubscribers(unknownId)).toEqual([]);

    socket.close();
  });

  it("answers malformed input with a structured validation error", async () => {
    const socket = await openClient();

    socket.send("{broken json");
    const message = await nextMessage(socket);
    expect(message["type"]).toBe("error");
    expect(message["error"]).toBe("validation_failed");

    socket.send(JSON.stringify({ type: "subscribe", taskId: "not-a-uuid" }));
    const second = await nextMessage(socket);
    expect(second["error"]).toBe("validation_failed");

    socket.close();
  });
});

describe("websocket broadcasts", () => {
  it("fans updates out to all subscribers of the task, and only those", async () => {
    const clientA = await openClient();
    const clientB = await openClient();
    await subscribe(clientA, TASK_A.id);
    await subscribe(clientB, TASK_B.id);

    gateway.broadcast({ type: "progress", taskId: TASK_A.id, progress: 75 });
    expect(await nextMessage(clientA)).toEqual({
      type: "progress",
      taskId: TASK_A.id,
      progress: 75,
    });
    await expectSilence(clientB);

    gateway.broadcast({ type: "completed", taskId: TASK_A.id });
    expect(await nextMessage(clientA)).toEqual({
      type: "completed",
      taskId: TASK_A.id,
    });

    gateway.broadcast({ type: "failed", taskId: TASK_A.id });
    expect(await nextMessage(clientA)).toEqual({
      type: "failed",
      taskId: TASK_A.id,
    });

    clientA.close();
    clientB.close();
  });

  it("sends to nobody when a task has no subscribers", async () => {
    const lonely = await openClient();
    await expectSilence(lonely);

    gateway.broadcast({ type: "progress", taskId: randomUUID(), progress: 10 });

    await expectSilence(lonely);
    lonely.close();
  });
});
