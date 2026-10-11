# ADR-004: WebSocket architecture

**Status:** Accepted

## Context

Any number of clients must follow a task live (`progress`, `completed`, `failed`), survive disconnects, and never influence processing. The source of truth is PostgreSQL (ADR-001), so the WebSocket layer must not become a second one.

## Decision

Split the gateway into two responsibilities, both wired as factories in the composition root:

- **Connection manager** — owns the `ws` server on `/ws`, framing, heartbeats, and malformed-message handling. Invalid input answers a structured `{ "type": "error", … }` frame and never crashes or disconnects the process.
- **Subscription manager** — an in-memory `Map<taskId, Set<connection>>`. Subscribing immediately answers with a `state` frame read from the database; afterwards the connection receives matching broadcasts.

Broadcasts are driven by the database trigger → `pg_notify` → `LISTEN` channel (`task_updates`): every `Task` row update emits a hint, and the gateway fans it out to subscribers. Terminal frames (`completed`, `failed`) are their own message types.

Because propagation goes through the database rather than between processes, **multiple API instances** each run their own listener and fan out to their own local subscribers — no broker is needed, PostgreSQL already sits between every instance. This property is covered by an integration suite (`tests/integration/websocket/websocket-cross-instance.test.ts`) that spawns two API processes against one database and asserts a single persisted update reaches subscribers on both.

## Consequences

- **Multiple clients** per task each get the same updates; zero subscribers means the event is simply dropped — processing never depends on a listener.
- **Reconnect workflow**: sockets are intentionally not durable. Reconnect + resubscribe and the fresh `state` frame resynchronizes from persisted truth (progress or terminal state).
- The WS layer stays stateless and restartable; its memory holds routing only, so an API restart costs subscribers one reconnect, never data.
