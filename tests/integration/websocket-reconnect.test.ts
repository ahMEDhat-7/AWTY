import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  attachWebSocketGateway,
  type WebSocketGateway,
} from "../../src/modules/websocket/gateway.ts";
import type { TaskStateResponse } from "../../src/modules/tasks/types.ts";

// Simulates the authoritative task table: tests mutate rows to play the
// worker's part while no WebSocket client is connected.
let tasks: Map<string, TaskStateResponse>;

let server: Server;
let gateway: WebSocketGateway;
let port: number;

beforeAll(async () => {
  tasks = new Map();
  server = createServer();
  gateway = attachWebSocketGateway(server, {
    findTask: (taskId) => Promise.resolve(tasks.get(taskId) ?? null),
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

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function seed(state: TaskStateResponse): TaskStateResponse {
  tasks.set(state.id, state);
  return state;
}

async function subscribe(
  socket: WebSocket,
  taskId: string,
): Promise<Record<string, unknown>> {
  socket.send(JSON.stringify({ type: "subscribe", taskId }));
  return nextMessage(socket);
}

describe("websocket reconnection", () => {
  it("resubscribe after a drop returns fresh state and keeps updates flowing", async () => {
    const taskId = randomUUID();
    seed({ id: taskId, status: "pending", progress: 0 });

    const first = await openClient();
    expect(await subscribe(first, taskId)).toEqual({
      type: "state",
      taskId,
      status: "pending",
      progress: 0,
    });
    first.close();
    await waitFor(() => gateway.connections.count() === 0);

    // The worker keeps going while nobody is connected.
    tasks.set(taskId, { id: taskId, status: "processing", progress: 60 });

    const second = await openClient();
    expect(await subscribe(second, taskId)).toEqual({
      type: "state",
      taskId,
      status: "processing",
      progress: 60,
    });

    // Future updates continue to flow to the reconnected client.
    gateway.broadcast({ type: "progress", taskId, progress: 75 });
    expect(await nextMessage(second)).toEqual({
      type: "progress",
      taskId,
      progress: 75,
    });

    second.close();
  });

  it("resubscribing on the same connection re-sends state without duplicating the subscription", async () => {
    const taskId = randomUUID();
    seed({ id: taskId, status: "processing", progress: 40 });

    const socket = await openClient();
    await subscribe(socket, taskId);
    expect(await subscribe(socket, taskId)).toEqual({
      type: "state",
      taskId,
      status: "processing",
      progress: 40,
    });
    expect(gateway.subscriptions.getSubscribers(taskId)).toHaveLength(1);

    socket.close();
    await waitFor(() => gateway.connections.count() === 0);
  });

  it("reconnect mid-processing returns the current persisted progress (20% → 60%)", async () => {
    const taskId = randomUUID();
    seed({ id: taskId, status: "processing", progress: 20 });

    const first = await openClient();
    expect(await subscribe(first, taskId)).toEqual({
      type: "state",
      taskId,
      status: "processing",
      progress: 20,
    });
    first.close();
    await waitFor(() => gateway.connections.count() === 0);

    tasks.set(taskId, { id: taskId, status: "processing", progress: 60 });

    const second = await openClient();
    expect(await subscribe(second, taskId)).toEqual({
      type: "state",
      taskId,
      status: "processing",
      progress: 60,
    });

    second.close();
  });

  it("a task completed while disconnected is discovered as completed/100 on reconnect", async () => {
    const taskId = randomUUID();
    seed({ id: taskId, status: "processing", progress: 25 });

    const first = await openClient();
    await subscribe(first, taskId);
    first.close();
    await waitFor(() => gateway.connections.count() === 0);

    // Terminal transition happens with no client attached.
    tasks.set(taskId, { id: taskId, status: "completed", progress: 100 });

    const second = await openClient();
    expect(await subscribe(second, taskId)).toEqual({
      type: "state",
      taskId,
      status: "completed",
      progress: 100,
    });

    second.close();
  });

  it("a task failed while disconnected is recovered as failed with progress preserved", async () => {
    const taskId = randomUUID();
    seed({ id: taskId, status: "processing", progress: 40 });

    const first = await openClient();
    await subscribe(first, taskId);
    first.close();
    await waitFor(() => gateway.connections.count() === 0);

    // Failure keeps the last durable progress.
    tasks.set(taskId, { id: taskId, status: "failed", progress: 40 });

    const second = await openClient();
    expect(await subscribe(second, taskId)).toEqual({
      type: "state",
      taskId,
      status: "failed",
      progress: 40,
    });

    second.close();
  });
});
