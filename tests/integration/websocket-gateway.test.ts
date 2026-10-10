import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  attachWebSocketGateway,
  type WebSocketGateway,
} from "../../src/modules/websocket/gateway.ts";

let server: Server;
let gateway: WebSocketGateway;
let port: number;

beforeAll(async () => {
  server = createServer();
  gateway = attachWebSocketGateway(server, { findTask: () => Promise.resolve(null) });
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

function openClient(path = "/ws"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("websocket gateway", () => {
  it("accepts connections at /ws and tracks them", async () => {
    const a = await openClient();
    const b = await openClient();

    expect(gateway.connections.count()).toBe(2);

    a.close();
    b.close();
    await waitFor(() => gateway.connections.count() === 0);
    expect(gateway.connections.count()).toBe(0);
  });

  it("refuses connections on other paths", async () => {
    await expect(openClient("/nope")).rejects.toThrow();
  });

  it("cleans a connection's subscriptions when it drops", async () => {
    // Subscribing through the wire protocol is covered elsewhere; subscribe
    // the server-side socket directly to pin the disconnect invariant end to end.
    let serverSide: WebSocket | undefined;
    const capture = (socket: WebSocket): void => {
      serverSide = socket;
    };
    gateway.wss.on("connection", capture);
    const socket = await openClient();
    gateway.wss.off("connection", capture);
    if (serverSide === undefined) {
      throw new Error("expected a server-side socket");
    }

    gateway.subscriptions.subscribe("task-x", serverSide);
    expect(gateway.subscriptions.getSubscribers("task-x")).toHaveLength(1);

    socket.terminate();
    await waitFor(
      () => gateway.subscriptions.getSubscribers("task-x").length === 0,
    );
    expect(gateway.subscriptions.getSubscribers("task-x")).toEqual([]);
  });

  it("survives malformed frames and keeps serving", async () => {
    const noisy = await openClient();
    noisy.send("{not json");
    noisy.send(JSON.stringify({ type: "nonsense" }));
    noisy.send(JSON.stringify({ type: "subscribe", taskId: "not-a-uuid" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    noisy.close();

    // The server must still accept fresh connections afterwards.
    const fresh = await openClient();
    expect(fresh.readyState).toBe(WebSocket.OPEN);
    fresh.close();
    await waitFor(() => gateway.connections.count() === 0);
  });
});
