# ADR-006: Task state machine

**Status:** Accepted

## Context

Progress is written by concurrent actors — the API at creation, workers during simulation, recovery code after crashes — while readers (REST, WebSocket subscribers) observe continuously. Without an explicit, enforced state machine, invalid writes (e.g. resurrecting a completed task) would be possible and correctness would depend on call sites behaving.

## Decision

The machine lives in one place, `src/modules/tasks/transitions.ts`, and every status write goes through it.

**States**

| State       | Meaning                                            |
| ----------- | -------------------------------------------------- |
| `pending`   | Row created, job queued, not yet claimed           |
| `processing`| Claimed by a worker, simulation running (progress 0–99) |
| `completed` | Terminal success (`progress = 100`)                |
| `failed`    | Terminal failure (controlled or crashed-out)       |

**Valid transitions**

```text
pending    → processing
processing → completed
processing → failed
```

**Invalid transitions** — everything else, notably:

- `pending → completed` / `pending → failed` (must pass through `processing`)
- `completed → *` and `failed → *` (terminal states are immutable)
- any transition out of a terminal state, including re-claim attempts after recovery

**Terminal states:** `completed`, `failed` — no further writes are possible; `ALLOWED_TRANSITIONS` maps both to `[]`.

Recovery's restart-from-0% (ADR-005) is *not* a status transition: the row stays `processing` while `progress`/`startedAt` are reset by the guarded `restartProcessing` claim.

## Consequences

- An invalid write is rejected with `invalid transition: from → to` instead of corrupting history.
- Subscribers can rely on monotonic lifecycle: they see `pending` → `processing` → exactly one terminal frame.
- Adding a state means editing one exhaustive `Record<TaskStatus, …>` — TypeScript reports every place that must decide.
