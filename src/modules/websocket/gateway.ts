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
 * Attaches a `ws` server to the existing Express HTTP server at `/ws`.
 *
 * Owns the connection lifecycle: every accepted socket is tracked, and
 * `close`/`error` both route through `connections.remove()`, which also
 * scrubs all of the socket's subscriptions.
 *
 * Inbound frames go to the protocol handler, which answers every failure
 * branch itself; the extra catch here is the last-resort guarantee that a
 * handler bug cannot crash the process.
 *
 * `broadcast` fans an update out to every current subscriber of a task;
 * the worker→gateway propagation is wired through the LISTEN listener.
 *
 * @param server - the HTTP server the gateway shares with the REST API
 * @param deps - `findTask`, the DB-authoritative snapshot reader
 * @returns the gateway handle: `wss`, `connections`, `subscriptions`, `broadcast`
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

  /**
   * Sends an update to every current subscriber.
   *
   * @param message - the task-addressed update to fan out
   * @returns nothing; each subscriber socket receives the JSON payload
   */
  function broadcast(message: WsTaskUpdate): void {
    const payload = JSON.stringify(message);
    for (const peer of subscriptions.getSubscribers(message.taskId)) {
      peer.send(payload);
    }
  }

  return { wss, connections, subscriptions, broadcast };
}

export type WebSocketGateway = ReturnType<typeof attachWebSocketGateway>;
