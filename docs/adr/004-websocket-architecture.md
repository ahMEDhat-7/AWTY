# ADR-004: WebSocket architecture

**Status:** Accepted

## Context

Any number of clients must follow a task live (`progress`, `completed`, `failed`), survive disconnects, and never influence processing. The source of truth is PostgreSQL (ADR-001), so the WebSocket layer must not become a second one.

## Decision

Split the gateway into two responsibilities, both wired as factories in the composition root:

- **Connection manager** — owns the `ws` server on `/ws`, framing, heartbeats, and malformed-message handling. Invalid input answers a structured `{ "type": "error", … }` frame and never crashes or disconnects the process.
- **Subscription manager** — an in-memory `Map<taskId, Set<connection>>`. Subscribing immediately answers with a `state` frame read from the database; afterwards the connection receives matching broadcasts.

Broadcasts are driven by the database trigger → `pg_notify` → `LISTEN` channel (`task_updates`): every `Task` row update emits a hint, and the gateway fans it out to subscribers. Terminal frames (`completed`, `failed`) are their own message types.

## Consequences

- **Multiple clients** per task each get the same updates; zero subscribers means the event is simply dropped — processing never depends on a listener.
- **Reconnect workflow**: sockets are intentionally not durable. Reconnect + resubscribe and the fresh `state` frame resynchronizes from persisted truth (progress or terminal state).
- The WS layer stays stateless and restartable; its memory holds routing only, so an API restart costs subscribers one reconnect, never data.
