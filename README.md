# AWTY — Are We There Yet?

AWTY is a real-time asynchronous task-processing backend. A client submits a long-running task, immediately receives a task ID, and follows progress live over a WebSocket connection while PostgreSQL remains the durable source of truth.

**Status:** implementation in progress — this README documents the target contract; current phase status lives in [docs/TASKS.md](docs/TASKS.md).

## Problem

Task processing takes time, but clients should not block. AWTY accepts a task, returns an ID right away, and lets any number of subscribers watch the task move through:

```text
pending → processing → completed / failed
```

with `progress` updates streamed in real time — surviving API restarts, worker crashes, and client disconnects.

## Architecture

```text
Client ── REST ──▶ Express API ──▶ PostgreSQL + Prisma (source of truth)
   │                    │                    ▲
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

Detailed diagram: [docs/DESIN.excalidraw](docs/DESIN.excalidraw) · full specification: [docs/PRD.md](docs/PRD.md) §7

## Technology Stack

| Layer           | Choice                                         |
| --------------- | ---------------------------------------------- |
| Runtime         | Node.js 24                                     |
| Package manager | pnpm 12                                        |
| Language        | TypeScript (strict, zero `any`)                |
| HTTP            | Express 5                                      |
| WebSocket       | `ws`                                           |
| Database        | PostgreSQL 18                                  |
| ORM             | Prisma ORM 7                                   |
| Job queue       | pg-boss                                        |
| Validation      | zod 4                                          |
| API docs        | OpenAPI 3.1 + Swagger UI at `/docs`            |
| Tests           | Vitest (unit + integration)                    |
| Local infra     | Docker Compose (`postgres` + `api` + `worker`) |
| CI/CD           | GitHub Actions                                 |

## Setup

### Prerequisites

- Node.js 24
- pnpm 12 (enabled via corepack; never npm)
- Docker with Docker Compose v2

### Quick start

```bash
git clone https://github.com/ahMEDhat-7/AWTY.git
cd AWTY
pnpm install
cp .env.example .env
docker compose up -d --build   # postgres + api + worker
pnpm db:migrate                # apply database migrations
curl localhost:3000/health     # → {"status":"ok","db":"connected"}
```

### Local development (containerized database only)

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm dev            # API on http://localhost:3000 (native TypeScript watch)
pnpm start:worker   # worker process, in a second terminal
```

## How to Run

### Scripts

| Command                                    | Purpose                                                      |
| ------------------------------------------ | ------------------------------------------------------------ |
| `pnpm dev`                                 | Run the API in watch mode (native TypeScript, no build step) |
| `pnpm build`                               | Generate the Prisma client and compile to `dist/`            |
| `pnpm start`                               | Run the compiled API (`dist/app/server.js`)                  |
| `pnpm start:worker`                        | Run the worker (`dist/worker-entry.js`)                      |
| `pnpm typecheck`                           | Strict TypeScript check (no emit)                            |
| `pnpm lint`                                | ESLint — type-aware, zero-`any` policy enforced              |
| `pnpm test`                                | Full test suite                                              |
| `pnpm test:unit` / `pnpm test:integration` | Run one suite                                                |
| `pnpm db:generate`                         | Regenerate the Prisma client                                 |
| `pnpm db:migrate`                          | Apply migrations (dev mode, detects drift)                   |
| `pnpm openapi:check`                       | Validate the generated OpenAPI specification                 |

### Docker Compose

```bash
docker compose up -d --build          # build and start the stack
docker compose ps                     # service health
docker compose logs -f api            # follow API logs
docker compose up -d --scale worker=2 # run two workers
docker compose down                   # stop (database volume persists)
docker compose down -v                # stop and wipe the database
```

Services: `postgres` (`postgres:18-alpine`, port 5432), `api` (port 3000) and `worker` — one image, two commands. `api` and `worker` start only after `postgres` is healthy.

> Note: the containerized `api` and `pnpm dev` both bind port 3000 — run one or the other.

## REST API

Interactive documentation: **http://localhost:3000/docs** (raw specification: `/openapi.json`).

### Create a task — `POST /tasks`

```bash
curl -X POST http://localhost:3000/tasks \
  -H 'Content-Type: application/json' \
  -d '{"duration": 10}'
```

`201 Created`:

```json
{ "id": "0b7f8f3e-1c2d-4a5b-9e8f-112233445566", "status": "pending" }
```

Optional `"shouldFail": true` injects a controlled failure for demonstrating failure handling. It travels only in the queue payload and is never stored on the task.

| Code  | When                                                                      |
| ----- | ------------------------------------------------------------------------- |
| `201` | Task created and queued — returns immediately, processing is asynchronous |
| `400` | Validation error (e.g. `duration` outside the documented 1–300 seconds)   |
| `500` | Unexpected server error (no stack traces leaked)                          |

### Read a task — `GET /tasks/:id`

```bash
curl http://localhost:3000/tasks/0b7f8f3e-1c2d-4a5b-9e8f-112233445566
```

`200 OK`:

```json
{
  "id": "0b7f8f3e-1c2d-4a5b-9e8f-112233445566",
  "status": "processing",
  "progress": 50
}
```

| Code  | When                                                    |
| ----- | ------------------------------------------------------- |
| `200` | Current task state — PostgreSQL is always authoritative |
| `404` | Unknown task                                            |

## WebSocket API

Connect to `ws://localhost:3000/ws`.

### Subscribe

```json
{ "type": "subscribe", "taskId": "0b7f8f3e-1c2d-4a5b-9e8f-112233445566" }
```

The server immediately answers with a `state` message reflecting the current database state, then streams live updates:

```json
{ "type": "progress", "taskId": "…", "progress": 25 }
{ "type": "completed", "taskId": "…" }
{ "type": "failed", "taskId": "…" }
```

### Reconnect

Sockets are not durable. Reconnect and resubscribe — the fresh `state` message always reflects persisted truth:

```json
{ "type": "state", "taskId": "…", "status": "processing", "progress": 82 }
```

or, if the task finished meanwhile:

```json
{ "type": "state", "taskId": "…", "status": "completed", "progress": 100 }
```

Malformed messages produce a structured protocol error and never crash the server. Subscriptions are in-memory only (`Map<taskId, Set<connection>>`); task processing never depends on a connected client.

## Recovery & Concurrency

- **API restart** — task state lives in PostgreSQL; clients recover through `GET /tasks/:id` or by resubscribing.
- **Worker crash** — pg-boss re-delivers the job and guarded state transitions prevent double-processing. The recovered simulation **restarts from 0%** (documented decision, ADR-005); a task can never be stranded in `processing`.
- **Client disconnect** — processing continues unaffected; reconnect + subscribe resynchronizes.
- **Multiple subscribers** — every subscriber of a task receives the same progress/completion/failure messages.
- **Multiple workers** — pg-boss job ownership plus guarded transitions guarantee one active worker per task: `docker compose up -d --scale worker=2`.

## CI/CD

- **CI** (`.github/workflows/ci.yml`, on pull requests and pushes to `main`): pnpm 12 + Node.js 24 install → Prisma generate/migration validation → typecheck → lint → unit + integration tests → OpenAPI specification check → build. Type errors, lint errors, test failures, or specification failures fail the pipeline.
- **CD** (`.github/workflows/cd.yml`, on `main`): builds the production Docker image, smoke-runs api + worker against PostgreSQL inside the CI runner (`POST /tasks` → poll `GET /tasks/:id` until `completed` / `progress = 100`), and **never pushes to any registry** — there is intentionally no hosted deployment target. No secrets beyond the default `GITHUB_TOKEN`.

## Documentation

| Document                                       | Purpose                                                |
| ---------------------------------------------- | ------------------------------------------------------ |
| [docs/PRD.md](docs/PRD.md)                     | Product & system requirements, decisions, architecture |
| [docs/TASKS.md](docs/TASKS.md)                 | Detailed implementation tasks and execution order      |
| [docs/DESIN.excalidraw](docs/DESIN.excalidraw) | End-to-end architecture diagram                        |
| `docs/adr/`                                    | Architecture decision records (planned)                |
