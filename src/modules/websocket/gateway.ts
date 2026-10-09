import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { parseWsMessage } from "./dto.ts";
import { createConnectionManager } from "./connections.ts";
import { createSubscriptionManager } from "./subscriptions.ts";

/**
 * TASK-044 — WebSocket gateway: attaches a `ws` server to the existing
 * Express HTTP server at `/ws` and owns the connection lifecycle
 * (TASK-045): every accepted socket is tracked, and `close`/`error` both
 * route through `connections.remove()`, which also scrubs all of the
 * socket's subscriptions.
 *
 * Message handling (subscribe → state sync, broadcasts, protocol errors)
 * arrives with the protocol phase (TASK-047+). Today inbound frames are
 * parsed and discarded — parsing here already proves the never-crash path
 * (PRD §21): malformed input is a value, not an exception.
 */
export function attachWebSocketGateway(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const subscriptions = createSubscriptionManager();
  const connections = createConnectionManager(subscriptions);

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
      void parseWsMessage(text);
    });
  });

  return { wss, connections, subscriptions };
}

export type WebSocketGateway = ReturnType<typeof attachWebSocketGateway>;
