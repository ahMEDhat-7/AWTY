# ADR-002: pg-boss for background processing

**Status:** Accepted

## Context

The assignment explicitly requires asynchronous background processing backed by PostgreSQL. The alternative would be inventing a queue (in-process timers, a table-based poll loop, or an external broker such as Redis/RabbitMQ), each of which either re-implements hard problems or adds a second runtime to operate.

## Decision

Use **pg-boss** as the job queue, in the same PostgreSQL database as the task data.

- `POST /tasks` enqueues the job **transactionally** with the row insert (`{ db: fromPrisma(tx) }`), so a task row and its job exist together or not at all.
- Per-job `expireInSeconds = duration + 60` (`taskJobExpireSeconds`) overrides the queue-level default, so a slow-but-alive simulation never expires out from under itself.
- The worker consumes with `localConcurrency: 4`, `batchSize: 1`.

## Consequences

- No custom queue code: ownership, retries, expiry, and dead-worker recovery come from pg-boss (verified against the installed 12.37.0 API, not assumed).
- One database to deploy, back up, and reason about — the queue survives restarts with the data.
- Queue semantics are shared by every process (API enqueues, workers consume) through the same connection configuration in `src/queue/config.ts`.
