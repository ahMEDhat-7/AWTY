# AWTY — Are We There Yet?

AWTY is a real-time asynchronous task-processing backend. A client submits a long-running task, immediately receives a task ID, and follows its progress live through a WebSocket connection while PostgreSQL remains the durable source of truth.

**Status:** implementation in progress — foundation and data layer complete, feature layers underway. The execution plan lives in [docs/TASKS.md](docs/TASKS.md).

## Problem

Task processing takes time, but clients should not block. AWTY accepts a task, returns an ID right away, and lets any number of subscribers watch the task move through:

```text
pending → processing → completed / failed
```

with `progress` updates streamed in real time — surviving API restarts, worker crashes, and client disconnects.

## Architecture

```text
Client ── REST ──▶ Express API ──▶ PostgreSQL + Prisma (source of truth)
   │                   │                    ▲
   └── WebSocket /ws ◀──┤                    │ pg-boss (job queue)
                        │                    │
                        │   DB trigger → pg_notify → LISTEN
                        │                    │
                        └────────────── Worker process (simulation,
                                          progress, complete/fail)
```

- **Express REST + WebSocket gateway** — validation, task creation/querying, live connections, in-memory subscriptions only
- **PostgreSQL + Prisma** — durable task state; nothing important lives in memory
- **pg-boss** — asynchronous job delivery with ownership/retry semantics (no custom queue)
- **Separate worker process** — consumes jobs, simulates duration, persists progress, completes or fails tasks
- **Database trigger → LISTEN/NOTIFY** — state-change signals to the WebSocket layer; notifications are hints, never the source of truth

Detailed diagram: [docs/DESIN.excalidraw](docs/DESIN.excalidraw)

## Technology Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 |
| Package manager | pnpm 12 |
| Language | TypeScript (strict, zero `any`) |
| HTTP | Express 5 |
| WebSocket | `ws` |
| Database | PostgreSQL 18 |
| ORM | Prisma ORM 7 |
| Job queue | pg-boss |
| Validation | zod 4 |
| API docs | OpenAPI 3.1 + Swagger UI at `/docs` |
| Tests | Vitest (unit + integration) |
| Local infra | Docker Compose (`postgres` + `api` + `worker`) |
| CI/CD | GitHub Actions |

## Required Capabilities

- `POST /tasks` / `GET /tasks/:id` REST API
- Asynchronous processing via pg-boss, independent per task
- Durable task state with restart recovery
- WebSocket `/ws` subscriptions with progress, completion, and failure messages
- Multiple simultaneous subscribers per task
- Reconnect state synchronization (DB state always authoritative)
- Failure handling with isolated, controlled task failures
- Multi-worker-safe processing with guarded state transitions

## Progress

Completed so far (tracked as TASK-001–017 in [docs/TASKS.md](docs/TASKS.md)):

- [x] Documentation synced to recorded decisions (PRD, TASKS)
- [x] Foundation: Node.js 24 + pnpm 12 + strict TypeScript (zero `any` enforced by lint)
- [x] Infrastructure gate: `docker compose up` runs `postgres:18-alpine` + `api`, `GET /health` reports `db: connected`
- [x] Typed environment configuration with fail-fast validation
- [x] Task schema: UUID PK, status enum, CHECK-constrained duration/progress, state-change `pg_notify` trigger — proven from an empty database
- [x] Domain model: status types, application types, guarded state transitions with exhaustive tests

Next up: zod validation → REST endpoints → pg-boss queue → worker → WebSocket → recovery → tests → CI/CD → final README/ADRs.

## API Documentation

Once the API is running, interactive OpenAPI documentation is served at **`/docs`** (specification at `/openapi.json`). The WebSocket protocol is documented separately because OpenAPI does not cover WebSocket APIs.

## Documentation

| Document | Purpose |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product & system requirements, decisions, architecture |
| [docs/TASKS.md](docs/TASKS.md) | Detailed implementation tasks (TASK-001–128) and execution order |
| [docs/DESIN.excalidraw](docs/DESIN.excalidraw) | End-to-end architecture diagram |
| `docs/adr/` | Architecture decision records (planned) |

Setup, API, WebSocket, recovery, and CI/CD guides will land here as their phases complete — see the execution order in [docs/TASKS.md](docs/TASKS.md).
