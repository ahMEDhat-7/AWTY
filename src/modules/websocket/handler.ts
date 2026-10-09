import type { TaskStateResponse } from "../tasks/types.ts";
import { parseWsMessage } from "./dto.ts";
import type { WsOutboundMessage } from "./protocol.ts";
import type { SubscriptionManager, WsPeer } from "./subscriptions.ts";

/** DB-authoritative snapshot reader — wired to the task repository. */
export type FindTaskSnapshot = (
  taskId: string,
) => Promise<TaskStateResponse | null>;

export interface MessageHandlerDeps {
  subscriptions: Pick<SubscriptionManager, "subscribe" | "unsubscribe">;
  findTask: FindTaskSnapshot;
}

/**
 * TASK-047/048/052 — the WebSocket protocol handler.
 *
 * `subscribe` follows the task's flow: validate → register the subscription →
 * read the current state → send the `state` synchronization message. The
 * registration deliberately happens *before* the read: an update committed in
 * between is then still broadcast to this socket, so a reconnecting client can
 * never end up stuck on a stale terminal state (PRD §17).
 *
 * Every failure branch answers with a structured protocol error instead of
 * throwing; the handler never rejects, so a single bad frame can never take
 * the process down (PRD §21).
 */
export function createMessageHandler(deps: MessageHandlerDeps) {
  return async function handleMessage(
    socket: WsPeer,
    raw: string,
  ): Promise<void> {
    const parsed = parseWsMessage(raw);
    if (!parsed.ok) {
      send(socket, {
        type: "error",
        error: "validation_failed",
        issues: parsed.issues,
      });
      return;
    }

    const { taskId } = parsed.data;
    deps.subscriptions.subscribe(taskId, socket);
    try {
      const task = await deps.findTask(taskId);
      if (task === null) {
        // Nothing to synchronize against: drop the registration again and
        // mirror the REST 404 contract.
        deps.subscriptions.unsubscribe(taskId, socket);
        send(socket, { type: "error", error: "not_found" });
        return;
      }
      send(socket, {
        type: "state",
        taskId: task.id,
        status: task.status,
        progress: task.progress,
      });
    } catch (cause) {
      deps.subscriptions.unsubscribe(taskId, socket);
      console.error("ws: failed to read task state", cause);
      send(socket, { type: "error", error: "internal_error" });
    }
  };
}

export type MessageHandler = ReturnType<typeof createMessageHandler>;

function send(socket: WsPeer, message: WsOutboundMessage): void {
  socket.send(JSON.stringify(message));
}
