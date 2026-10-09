import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createConnectionManager } from "./connections.ts";
import { createMessageHandler, type FindTaskSnapshot } from "./handler.ts";
import type { WsTaskUpdate } from "./protocol.ts";
import { createSubscriptionManager } from "./subscriptions.ts";

export interface WebSocketGatewayDeps {
  findTask: FindTaskSnapshot;
}

/**
 * TASK-044 — WebSocket gateway: attaches a `ws` server to the existing
 * Express HTTP server at `/ws` and owns the connection lifecycle
 * (TASK-045): every accepted socket is tracked, and `close`/`error` both
 * route through `connections.remove()`, which also scrubs all of the
 * socket's subscriptions.
 *
 * Inbound frames go to the protocol handler (TASK-047+), which answers every
 * failure branch itself; the extra catch here is the last-resort guarantee
 * that a handler bug cannot crash the process (PRD §21).
 *
 * `broadcast` fans an update out to every current subscriber of a task
 * (TASK-049/050/051); the worker→gateway propagation wiring arrives with
 * the LISTEN phase (TASK-053).
 */
export function attachWebSocketGateway(
  server: HttpServer,
  deps: WebSocketGatewayDeps,
) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const subscriptions = createSubscriptionManager();
  const connections = createConnectionManager(subscriptions);
  const handleMessage = createMessageHandler({
    subscriptions,
    findTask: deps.findTask,
  });

  wss.on("connection", (socket: WebSocket) => {
    connections.add(socket);
    socket.on("close", () => connections.remove(socket));
    socket.on("error", () => connections.remove(socket));
    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw)
        ? raw.toString()
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString()
          : Buffer.from(raw).toString();
      void handleMessage(socket, text).catch((cause: unknown) => {
        console.error("ws: message handling failed", cause);
      });
    });
  });

  /** TASK-049/050/051 — send an update to every current subscriber. */
  function broadcast(message: WsTaskUpdate): void {
    const payload = JSON.stringify(message);
    for (const peer of subscriptions.getSubscribers(message.taskId)) {
      peer.send(payload);
    }
  }

  return { wss, connections, subscriptions, broadcast };
}

export type WebSocketGateway = ReturnType<typeof attachWebSocketGateway>;
