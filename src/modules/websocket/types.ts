import type { z } from "zod";
import type { ValidationIssue } from "../../lib/validation.ts";
import type { TaskStateResponse, TaskStatus } from "../tasks/types.ts";
import type { inboundMessageSchema, subscribeMessageSchema } from "./dto.ts";
import type { attachWebSocketGateway } from "./gateway.ts";
import type { createMessageHandler } from "./handler.ts";
import type { startTaskUpdateListener } from "./listener.ts";
import type { createConnectionManager } from "./connections.ts";
import type { createSubscriptionManager } from "./subscriptions.ts";

/**
 * Structured protocol errors: the WebSocket mirror of the REST error
 * contract (`validation_failed` + issues / `not_found` /
 * `internal_error`). Malformed input is a value here, never an exception.
 */
export type WsProtocolError =
  | { type: "error"; error: "validation_failed"; issues: ValidationIssue[] }
  | { type: "error"; error: "not_found" }
  | { type: "error"; error: "internal_error" };

export type WsOutboundMessage =
  | { type: "progress"; taskId: string; progress: number }
  | { type: "completed"; taskId: string }
  | { type: "failed"; taskId: string }
  | { type: "state"; taskId: string; status: TaskStatus; progress: number }
  | WsProtocolError;

/**
 * Broadcastable updates: every outbound message addressed to a task's
 * subscribers. Protocol errors are per-socket replies and are
 * deliberately excluded.
 */
export type WsTaskUpdate = Extract<WsOutboundMessage, { taskId: string }>;

export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;
export type WsInboundMessage = z.infer<typeof inboundMessageSchema>;

/**
 * The connection port shared by both managers: the minimal surface they
 * rely on, so the managers stay testable with plain fakes and are never
 * coupled to the `ws` package.
 */
export interface WsPeer {
  send(data: string): void;
}

export type SubscriptionManager = ReturnType<typeof createSubscriptionManager>;

export type ConnectionManager = ReturnType<typeof createConnectionManager>;

/** DB-authoritative snapshot reader — wired to the task repository. */
export type FindTaskSnapshot = (
  taskId: string,
) => Promise<TaskStateResponse | null>;

export interface MessageHandlerDeps {
  subscriptions: Pick<SubscriptionManager, "subscribe" | "unsubscribe">;
  findTask: FindTaskSnapshot;
}

export type MessageHandler = ReturnType<typeof createMessageHandler>;

/** Notification shape as delivered by the `pg` client. */
export interface NotificationMessage {
  channel?: string;
  payload?: string;
}

/**
 * Minimal `pg` client port — keeps the listener decoupled from the package
 * and testable with a fake; `pg.Client` satisfies it structurally.
 */
export interface NotificationClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
  on(
    event: "notification",
    listener: (message: NotificationMessage) => void,
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "end", listener: () => void): void;
}

export interface TaskUpdateListenerDeps {
  /** Dedicated LISTEN connection factory — one connection per listener. */
  createClient: () => NotificationClient;
  findTask: FindTaskSnapshot;
  broadcast: (message: WsTaskUpdate) => void;
  /** Test seam; production default is a calm retry cadence. */
  reconnectDelayMs?: number;
}

export type TaskUpdateListener = ReturnType<typeof startTaskUpdateListener>;

export interface WebSocketGatewayDeps {
  findTask: FindTaskSnapshot;
}

export type WebSocketGateway = ReturnType<typeof attachWebSocketGateway>;
