# ADR-001: PostgreSQL as the source of truth

**Status:** Accepted

## Context

Task processing takes time and must survive process restarts. The system restarts its API, kills its workers, and disconnects its clients on purpose (see the restart/recovery walkthroughs in `docs/TASKS.md` §29). Any state held only in memory would be lost by any of those events, and clients reconnecting later would have nothing to resynchronize against.

## Decision

PostgreSQL is the single durable source of truth for task state, accessed through Prisma.

- Every task read (`GET /tasks/:id`, the WebSocket `state` frame) is answered from the database, never from a cache or in-process map.
- The API is stateless: it can be restarted at any moment without data loss.
- The WebSocket layer keeps only ephemeral, in-memory *subscriptions* (`Map<taskId, Set<connection>>`); they are routing aids, not state.
- The database trigger → `pg_notify` → `LISTEN` path carries *hints* about changes; subscribers always treat the persisted row as authoritative.

## Consequences

- Restart survival is structural, not best-effort: an API restart mid-task loses nothing, and reconnecting clients resync from `GET`/`state` frames.
- PostgreSQL is a hard dependency; `/health` reports `db: connected` (or fails) accordingly.
- One operational surface: durable state, the pg-boss queue, and notification fan-out all live in the same database.
