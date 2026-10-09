import type { TaskStateResponse } from "../tasks/types.ts";
import type { FindTaskSnapshot } from "./handler.ts";
import type { WsTaskUpdate } from "./protocol.ts";

/** Channel published by the TASK-014 trigger: payload `{"id","status","progress"}`. */
export const TASK_UPDATES_CHANNEL = "task_updates";

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

const DEFAULT_RECONNECT_MS = 3000;

/**
 * TASK-053 — dedicated LISTEN client inside the API:
 *
 *   worker → PostgreSQL update → trigger pg_notify('task_updates')
 *          → this listener → gateway.broadcast → subscribers
 *
 * A notification is only a *hint* that something changed (TASK-054): the
 * listener re-reads the task and broadcasts that authoritative state, so a
 * missed notification is never a correctness problem — re-subscribe and
 * `GET /tasks/:id` recover. Notifications are handled strictly in sequence,
 * keeping broadcasts monotonic (no stale progress after a newer one).
 *
 * The connection is established at startup and re-established after failures;
 * because of the hint-only design, an unavailable database or a dropped
 * connection degrades live updates without ever affecting task processing —
 * the worker never depends on a connected client (TASK-055).
 */
export function startTaskUpdateListener(deps: TaskUpdateListenerDeps) {
  const reconnectDelayMs = deps.reconnectDelayMs ?? DEFAULT_RECONNECT_MS;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  let client: NotificationClient | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  /** Enqueue one notification; everything before it settles first. */
  function push(payload: string | undefined): void {
    chain = chain
      .then(() => handleOne(payload))
      .catch((cause: unknown) => {
        // A failing snapshot read is a lost hint, not an outage (TASK-054).
        console.error("listener: failed to process notification", cause);
      });
  }

  async function handleOne(payload: string | undefined): Promise<void> {
    const id = extractTaskId(payload);
    if (id === undefined) {
      return;
    }
    const task = await deps.findTask(id);
    if (task === null) {
      return;
    }
    deps.broadcast(toTaskUpdate(task));
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== undefined) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void start();
    }, reconnectDelayMs);
  }

  async function start(): Promise<void> {
    const next = deps.createClient();
    client = next;
    next.on("notification", (message) => {
      if (next !== client) {
        return; // stale connection — superseded or closed
      }
      if (message.channel === TASK_UPDATES_CHANNEL) {
        push(message.payload);
      }
    });
    next.on("error", (error) => {
      if (next !== client) {
        return;
      }
      console.error(`listener: connection error — ${error.message}`);
      scheduleReconnect();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${TASK_UPDATES_CHANNEL}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`listener: connect failed — ${message}`);
      scheduleReconnect();
      return;
    }
    if (closed) {
      void next.end().catch(() => undefined);
      return;
    }
    console.log(`listener: listening on ${TASK_UPDATES_CHANNEL}`);
  }

  void start();

  return {
    async close(): Promise<void> {
      closed = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
      const current = client;
      client = undefined;
      if (current !== undefined) {
        try {
          await current.end();
        } catch {
          // already dead — closing is best-effort
        }
      }
    },
  };
}

export type TaskUpdateListener = ReturnType<typeof startTaskUpdateListener>;

function extractTaskId(payload: string | undefined): string | undefined {
  if (payload === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const id = (parsed as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/** TASK-053 — broadcast the authoritative state, not the hint's contents. */
function toTaskUpdate(task: TaskStateResponse): WsTaskUpdate {
  if (task.status === "completed") {
    return { type: "completed", taskId: task.id };
  }
  if (task.status === "failed") {
    return { type: "failed", taskId: task.id };
  }
  return { type: "progress", taskId: task.id, progress: task.progress };
}
