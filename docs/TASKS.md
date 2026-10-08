# AWTY (Are We There Yet?) — Detailed Implementation Tasks

## 0. Execution Order

Implement in small vertical slices:

```text
Docs sync
→ Foundation (Node 24 + pnpm 12 + TypeScript strict)
→ Infrastructure gate (Dockerfile + docker compose: postgres:18 + api up and connected)
→ PostgreSQL/Prisma
→ Task domain
→ POST /tasks
→ OpenAPI documentation core
→ pg-boss
→ Worker
→ Progress
→ GET /tasks/:id + spec coverage
→ WebSocket
→ Reconnect recovery
→ Failure recovery
→ Concurrency
→ Tests
→ Docker Compose finalize (worker service)
→ GitHub Actions CI
→ GitHub Actions CD (build + smoke, no push)
→ README + ADRs
→ Final verification
```

Global rules:

- **strict TypeScript and zero `any`**
- **Node.js 24 and pnpm 12 only; never npm**
- every documented command is a `pnpm` script
- **review-gated commits**: implement a phase, stop for review, and run `git add` / `git commit` only after explicit approval; never commit before review

---

# 1. Repository Foundation

## TASK-001 — Initialize Node.js 24 + pnpm 12 + TypeScript

### Work

- initialize package metadata with `"type": "module"` and `"packageManager": "pnpm@12.10.1"`
- set `engines.node` to `>=24`
- configure TypeScript (strict mode, NodeNext modules)
- define source/build directories
- configure development and production entrypoints
- add `.gitignore` (including the generated Prisma client path)
- add `.env.example`

### Acceptance

- `pnpm install` works
- `tsc` passes
- strict mode is enabled
- no `any`
- production build succeeds
- package manager is pnpm 12 (corepack)

## TASK-002 — Define project scripts

Provide logical scripts for:

```text
dev
build
start
start:worker
typecheck
lint
test
test:unit
test:integration
db:generate
db:migrate
openapi:check
```

### Acceptance

Every documented `pnpm` command works.

## TASK-003 — Enforce zero-`any` TypeScript

### Work

- configure `strict: true`
- forbid explicit `any`
- forbid `as any`
- use `unknown` at untrusted boundaries
- configure lint/type rules as appropriate

### Acceptance

Introducing `any` makes local checks fail and CI reject the change.

---

# 2. Configuration

## TASK-004 — Typed environment configuration

Define and validate only required variables, including at least:

```text
NODE_ENV
PORT
DATABASE_URL
```

Add pg-boss-related configuration only as required by the selected setup.

### Acceptance

Application and worker fail fast on invalid/missing required configuration.

---

# 3. Infrastructure

## TASK-005 — Minimal API bootstrap with health check

### Work

- Express app factory + server entrypoint
- `GET /health` returning process status plus database connectivity (`SELECT 1` through Prisma)
- no task feature code yet

### Acceptance

With PostgreSQL reachable, `pnpm start` responds on `/health` with `db: connected`.

## TASK-006 — Create API Dockerfile

### Work

- multi-stage build: corepack enables pnpm 12, `pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm build`
- runtime stage on `node:24-alpine`, non-root user
- `CMD ["node", "dist/app/server.js"]`

### Acceptance

`docker build` succeeds deterministically.

## TASK-007 — Create docker-compose.yml

### Work

Services:

```text
postgres: postgres:18-alpine, named volume, pg_isready healthcheck
api: build from TASK-006 Dockerfile, depends_on postgres: condition: service_healthy, env from .env
```

### Acceptance

Compose file is valid; `postgres` becomes healthy.

## TASK-008 — Infrastructure gate

### Work

- `docker compose up -d --build`
- verify both services healthy
- `GET /health` reports `db: connected`
- logs show a successful database connection

### Acceptance

**The project and its services are up and connected before any feature code is implemented.**

---

# 4. PostgreSQL + Prisma

## TASK-009 — Verify PostgreSQL locally

PostgreSQL runs as the `postgres` service introduced in TASK-007 (`postgres:18-alpine`).

### Acceptance

Database can be started and reached reliably by the `api` service.

## TASK-010 — Initialize Prisma 7

- configure `prisma.config.ts` at the repository root (dotenv + datasource URL)
- configure the `prisma-client` generator with a required output path inside `src/`
- generate Prisma client
- gitignore the generated client

### Acceptance

Prisma commands complete successfully and the client imports cleanly under ESM.

## TASK-011 — Design Task schema

Fields:

```text
id
duration
status
progress
createdAt
updatedAt
startedAt
completedAt
failedAt
```

Decide and document:

- UUID
- duration DB type
- status representation
- nullable timestamps
- progress type

## TASK-012 — Add database invariants

Protect:

- unique ID
- positive duration within the documented `1..300` bound
- progress `0..100`
- valid statuses

## TASK-013 — Create initial migration

Verify migration works from an empty database.

## TASK-014 — Add state-change notification trigger

### Work

- SQL migration creating a trigger function and an `AFTER UPDATE` trigger on `Task`
- emit `pg_notify('task_updates', …)` with `{ id, status, progress }`

### Acceptance

Updating a row emits a notification whose payload matches the expected shape.

---

# 5. Domain Model

## TASK-015 — Define task status

Use a type-safe enum/union for:

```text
pending
processing
completed
failed
```

## TASK-016 — Define application types

Create named types for:

- create input
- task state
- task response
- queue payload
- state transition input/result
- WebSocket inbound messages
- WebSocket outbound messages

## TASK-017 — Implement state transition rules

Valid transitions:

```text
pending -> processing
processing -> completed
processing -> failed
```

Test invalid transitions.

---

# 6. Validation

## TASK-018 — Validate POST `/tasks`

Receive unknown request data, validate it, then produce typed `CreateTaskInput`.

Document the duration assumption (`1..300` integer seconds) because the source requirement does not define exact range semantics.

## TASK-019 — Validate WebSocket messages

Flow:

```text
unknown data
→ safe JSON parsing
→ runtime schema validation
→ discriminated union
→ handler
```

Malformed data must not crash the process.

## TASK-020 — Validate queue payloads

Do not blindly trust pg-boss payloads. Convert unknown payload data into a validated typed task job.

---

# 7. Repository

## TASK-021 — Design Task Repository

Methods should cover:

```text
create
findById
markProcessing
updateProgress
markCompleted
markFailed
```

Use Prisma.

## TASK-022 — Implement guarded updates

Guard transitions by current state so stale/duplicate worker execution cannot perform arbitrary transitions.

---

# 8. POST /tasks

## TASK-023 — Implement create-task application service

Flow:

```text
validate
→ create pending task
→ enqueue job
→ return task ID
```

## TASK-024 — Coordinate DB insert + pg-boss publication

Use the transaction-aware feature supported by the exact pg-boss version selected (`fromPrisma(tx)` inside `prisma.$transaction`).

Do not assume a pg-boss API from memory; verify the installed version first.

### Acceptance

Avoid intentional creation of inconsistent states where the database task exists without its queue job or vice versa.

## TASK-025 — Implement REST controller

### Success

```json
{
  "id": "abc123",
  "status": "pending"
}
```

### Acceptance

HTTP returns immediately; it never waits for task completion.

## TASK-026 — Add HTTP error mapping

Handle:

- validation error -> 4xx
- missing task -> 404
- unexpected error -> 500

Do not expose internal stack traces.

---

# 9. OpenAPI Documentation

## TASK-027 — Build OpenAPI spec generator

### Work

- extend the zod schemas with OpenAPI metadata
- generate an OpenAPI 3.1 document from the same schemas used for runtime validation (via `zod-openapi`)

### Acceptance

Spec generation is fully typed with no `any`.

## TASK-028 — Serve Swagger UI and specification

### Work

- Swagger UI at `/docs` (via `swagger-ui-express`)
- `GET /openapi.json` returns the specification

### Acceptance

Both routes respond and the UI renders the spec.

## TASK-029 — Register POST `/tasks` in the specification

### Work

- document request body, `201`, `400`, `500` responses
- add a specification validity test

### Acceptance

The spec test passes and documented behavior matches runtime validation.

---

# 10. pg-boss

## TASK-030 — Initialize pg-boss

Configure:

- PostgreSQL connection
- queue/job name
- worker startup
- retry/recovery behavior
- concurrency

Use the exact API/semantics of the installed pg-boss version.

## TASK-031 — Implement typed publisher

Queue payload should be minimal:

```text
{ taskId: string, shouldFail: boolean }
```

`shouldFail` is documented in PRD §5 and never persisted in the Task table.

## TASK-032 — Implement worker consumer

Worker runtime must be independently startable from the API.

---

# 11. Worker

## TASK-033 — Separate worker entrypoint

Provide an independent worker process as a second entrypoint in the same package.

Logical script:

```text
pnpm start:worker
```

Production: the **same Docker image** runs `node dist/worker-entry.js` as the worker command.

## TASK-034 — Worker start transition

When a job is received:

```text
load task
→ pending -> processing
```

Only the worker that successfully performs the guarded transition should proceed.

## TASK-035 — Implement task simulation

For `duration = 10`, normal completion should take approximately 10 seconds.

Processing must not block the HTTP server.

## TASK-036 — Worker error boundary

Wrap task processing so a single task error does not terminate the worker process.

Treat caught errors as `unknown` and safely normalize them.

---

# 12. Progress

## TASK-037 — Implement progress calculation

Recommended:

```text
floor(elapsed / duration * 100)
```

Clamp to `0..100`.

## TASK-038 — Persist periodic progress

Persist changed progress values to PostgreSQL.

Avoid unnecessary duplicate writes where practical.

## TASK-039 — Broadcast progress signal

After a durable progress update, make the update available to the WebSocket layer (via the TASK-014 trigger).

## TASK-040 — Complete task

Set:

```text
status = completed
progress = 100
completedAt = now
```

Only transition from `processing`.

---

# 13. GET /tasks/:id

## TASK-041 — Implement get-task service

Read current state from PostgreSQL.

## TASK-042 — Implement `GET /tasks/:id`

Success example:

```json
{
  "id": "abc123",
  "status": "processing",
  "progress": 50
}
```

Missing task -> `404`.

## TASK-043 — Complete OpenAPI coverage

### Work

- register `GET /tasks/:id` with `200`/`404` responses and error schemas
- extend the spec test to assert both endpoints are present and valid

### Acceptance

The published specification documents both REST endpoints completely.

---

# 14. WebSocket Infrastructure

## TASK-044 — Add WebSocket endpoint `/ws`

Attach WebSocket support to the Express HTTP server.

## TASK-045 — Implement connection manager

Responsibilities:

- add connection
- remove connection
- detect close/error
- clean subscriptions on disconnect

## TASK-046 — Implement subscription manager

Conceptual data structure:

```text
Map(TaskId, Set<Connection>)
```

Support:

```text
subscribe
unsubscribe (recommended even if not required)
get subscribers
remove connection
```

---

# 15. WebSocket Protocol

## TASK-047 — Implement `subscribe`

Input:

```json
{
  "type": "subscribe",
  "taskId": "abc123"
}
```

Flow:

```text
validate
→ register subscription
→ read current state
→ send synchronization message
```

## TASK-048 — Implement state synchronization message

Recommended:

```json
{
  "type": "state",
  "taskId": "abc123",
  "status": "processing",
  "progress": 72
}
```

This is required for reconnect correctness.

## TASK-049 — Implement progress broadcast

Broadcast:

```json
{
  "type": "progress",
  "taskId": "abc123",
  "progress": 25
}
```

to all current subscribers.

## TASK-050 — Implement completion broadcast

Broadcast:

```json
{
  "type": "completed",
  "taskId": "abc123"
}
```

## TASK-051 — Implement failure broadcast

Recommended:

```json
{
  "type": "failed",
  "taskId": "abc123"
}
```

## TASK-052 — Implement protocol-error handling

Invalid messages produce a structured protocol error rather than crashing the server.

---

# 16. Worker-to-WebSocket Propagation

## TASK-053 — Wire state-change notifications

Decision (PRD §5/§18): the mechanism is the TASK-014 database trigger plus a dedicated `pg` LISTEN client inside the API:

```text
Worker
→ PostgreSQL update
→ trigger pg_notify('task_updates')
→ API LISTEN client
→ WebSocket gateway
→ subscribers
```

No Redis and no custom broker.

## TASK-054 — Make DB state authoritative

A notification is never the source of truth.

If an event is missed, `GET /tasks/:id` and WebSocket re-subscription must still recover the correct current state.

## TASK-055 — Handle no-subscriber case

Worker must continue processing normally when there are zero WebSocket subscribers.

---

# 17. Reconnection

## TASK-056 — Implement reconnect recovery

On reconnect and resubscribe:

```text
connect
→ subscribe
→ query PostgreSQL
→ send state
→ continue future updates
```

## TASK-057 — Reconnect during processing

Scenario:

```text
20%
↓
disconnect
↓
worker continues
↓
reconnect
↓
current state maybe 60%
```

Verify current persisted state is returned.

## TASK-058 — Reconnect after completion

If the task finishes while the client is disconnected, the client must discover `completed / 100` after reconnect.

## TASK-059 — Reconnect after failure

If the task fails while the client is disconnected, the client must recover the `failed` state.

---

# 18. Failure and Recovery

## TASK-060 — Persist failed state

On processing failure:

```text
status = failed
failedAt = now
```

Preserve last progress according to the documented policy (PRD §5).

## TASK-061 — Configure pg-boss recovery

Verify and configure job retry/ownership/timeout behavior from the actual pg-boss version (per-job `expireInSeconds = duration + margin`, `retryLimit`).

### Acceptance

A crashed worker cannot strand a task in `processing` forever.

## TASK-062 — Document crash progress behavior

Decision (PRD §5): recovery **restarts processing from 0%**. Guarded transitions prevent double-processing; exact resume from persisted progress is not attempted. Record this in ADR-005.

## TASK-063 — Ensure task failure isolation

One failed job does not terminate other processing.

## TASK-064 — Implement failure injection

### Work

- optional `shouldFail` boolean on `POST /tasks`, carried only in the queue payload (TASK-031)
- worker fails deterministically mid-run when set
- REST and WebSocket both reflect the `failed` state

### Acceptance

A controlled failure can be reproduced on demand without schema changes.

---

# 19. Concurrency

## TASK-065 — Configure worker concurrency

Choose an intentional worker concurrency level and document it.

## TASK-066 — Run multiple workers

Run at least two worker processes for verification (`docker compose up --scale worker=2`).

## TASK-067 — Verify single-task ownership

Ensure one task cannot be actively processed by two workers simultaneously.

Use pg-boss delivery/ownership plus guarded DB transitions.

## TASK-068 — Verify independent task progress

Run several tasks, for example:

```text
A = 10s
B = 3s
C = 5s
```

Verify B and C do not wait for A.

---

# 20. Restart Tests

## TASK-069 — API restart

Scenario:

```text
create task
→ processing
→ restart API
```

Verify task persists and client can recover state.

## TASK-070 — Worker restart

Scenario:

```text
create task
→ processing
→ interrupt worker
→ restart worker
```

Verify task is eventually completed or failed rather than permanently processing.

## TASK-071 — Client disconnect

Scenario:

```text
subscribe
→ disconnect
→ task continues
→ reconnect
```

Verify processing is unaffected.

---

# 21. Unit Tests

## TASK-072 — Validation tests

Cover valid/invalid duration and documented boundary assumptions (`1..300`).

## TASK-073 — State machine tests

Cover all valid and invalid transitions.

## TASK-074 — Progress tests

Cover:

- 0
- early progress
- middle
- near completion
- exact completion
- clamping

## TASK-075 — Subscription manager tests

Cover:

- subscribe
- multiple clients
- unsubscribe
- disconnect cleanup
- no subscribers

## TASK-076 — WebSocket protocol tests

Cover:

- valid subscribe
- malformed JSON
- missing task ID
- wrong data types
- unknown message type

## TASK-077 — Error normalization tests

Verify unknown thrown values can be safely converted to loggable/public-safe error information.

## TASK-078 — OpenAPI specification tests

Cover:

- both REST endpoints present
- request/response schemas match runtime validation
- specification is well-formed OpenAPI 3.1

---

# 22. Integration / E2E Tests

## TASK-079 — POST /tasks integration

Verify:

- HTTP response
- task row
- queue job

## TASK-080 — GET /tasks/:id integration

Verify:

- existing task
- missing task
- current persistent state

## TASK-081 — End-to-end completion

```text
POST
→ pg-boss
→ worker
→ processing
→ progress
→ completed
```

## TASK-082 — End-to-end failure

```text
POST (shouldFail)
→ worker error
→ failed
```

Verify REST and WebSocket reflect failure.

## TASK-083 — WebSocket progress

Verify progress messages arrive while processing.

## TASK-084 — WebSocket completion

Verify completion message arrives.

## TASK-085 — Multiple subscribers

At least two clients subscribe to one task and both receive updates.

## TASK-086 — Reconnect recovery

Disconnect mid-task, reconnect later, and verify state synchronization.

## TASK-087 — Concurrent tasks

Run several different-duration tasks at once and verify independent progress.

## TASK-088 — Worker restart/recovery

Verify the recovery path in a repeatable automated/integration scenario where practical (spawn worker subprocess, SIGKILL mid-task, start a fresh worker, assert the task completes).

## TASK-089 — API documentation endpoints integration

Verify `/docs` and `/openapi.json` serve a valid specification against the running app.

---

# 23. Docker Compose

## TASK-090 — Add worker service to Compose topology

Services:

```text
postgres (from TASK-007)
api (from TASK-007)
worker (same image as api, command: node dist/worker-entry.js)
```

## TASK-091 — Verify PostgreSQL persistence

The named volume from TASK-007 persists data across restarts.

### Acceptance

Data survives `docker compose down && docker compose up`.

## TASK-092 — Handle startup ordering

Use health/dependency behavior so API/worker initialization is reliable when PostgreSQL starts slowly.

## TASK-093 — Validate one-command local startup

Document and test:

```text
docker compose up
```

---

# 24. Production Build

## TASK-094 — Create production build container

Use a deterministic Node.js production build (TASK-006 Dockerfile).

## TASK-095 — Support separate API/worker commands

Decision: **one production image, two commands** (`node dist/app/server.js`, `node dist/worker-entry.js`). Compose selects the command per service.

## TASK-096 — Verify runtime configuration

No secrets or environment-specific values committed to source.

---

# 25. GitHub Actions CI

## TASK-097 — Create `.github/workflows/ci.yml`

Triggers:

- pull request
- push to main/default branch

Pipeline:

```text
checkout
→ setup pnpm 12 + Node.js 24 (pnpm store cache)
→ pnpm install --frozen-lockfile
→ Prisma generate
→ Prisma/schema/migration validation
→ typecheck
→ lint
→ unit tests
→ integration tests
→ OpenAPI specification check
→ build
```

## TASK-098 — Provide PostgreSQL in CI

Use a GitHub Actions PostgreSQL service or equivalent so integration tests run against a real database.

## TASK-099 — Apply migrations in CI

Run the repository's migration path against the CI database from a clean state.

## TASK-100 — Enforce no-`any` in CI

CI must reject explicit `any` and type-check failures.

## TASK-101 — Cache dependencies

Use the pnpm store cache only if it improves CI without making the workflow harder to understand.

---

# 26. GitHub Actions CD

## TASK-102 — Confirm deployment target decision

Decision (PRD §5): **no hosted deployment target**. CD builds and smoke-runs the production image; the image is the deployable artifact; nothing is pushed.

## TASK-103 — Create `.github/workflows/cd.yml`

Stages:

```text
main
→ CI gates
→ docker build (no push)
→ smoke-run image + worker against PostgreSQL service
→ POST /tasks → poll GET /tasks/:id until completed / progress 100
```

### Acceptance

A green CD run proves the project builds and runs; no registry interaction exists.

## TASK-104 — Configure secrets policy

No registry or provider secrets are required (default `GITHUB_TOKEN` only). Never commit credentials; if any secret is ever added it belongs in GitHub Environments/Secrets.

## TASK-105 — Add deployment smoke test

Verify the freshly built API image is reachable and completes a real task with the worker image after deployment-equivalent startup.

## TASK-106 — Document deployment assumptions

README must clearly say what is built, what is intentionally not deployed, how CD verifies the image, and what configuration is required.

---

# 27. Documentation

## TASK-107 — Write README overview

Include:

- problem statement
- architecture
- major components
- technology stack (Node 24, pnpm 12, Prisma 7)
- link to Swagger UI at `/docs`

## TASK-108 — Document setup

Include:

- Node 24 + pnpm 12 requirements
- dependency installation (`pnpm install`)
- `.env` setup
- PostgreSQL startup (`docker compose up`)
- Prisma migrations (`pnpm db:migrate`)
- API startup (`pnpm start` / compose `api`)
- worker startup (`pnpm start:worker` / compose `worker`)

## TASK-109 — Document REST API

Document:

- POST `/tasks`
- GET `/tasks/:id`
- request/response examples
- statuses
- errors
- OpenAPI/Swagger usage (`/docs`, `/openapi.json`)

## TASK-110 — Document WebSocket API

Document:

- `/ws`
- connection
- subscribe
- state synchronization
- progress
- completed
- failed
- malformed message behavior
- reconnect workflow

## TASK-111 — Document recovery/concurrency

Explain:

- API restarts
- worker restarts
- client disconnects
- multiple subscribers
- multiple workers
- guarded state transitions
- crash-recovery restart-from-zero policy

## TASK-112 — Document CI/CD

Explain:

- CI triggers
- CI stages (pnpm 12, Node 24)
- CD trigger
- CD = build + smoke-run, no push, no hosted target
- required secrets (none beyond default)
- smoke test

## TASK-113 — Keep documentation in sync

### Work

After each reviewed phase, update `docs/PRD.md`, `docs/TASKS.md`, and the README if any decision or scope changed.

### Acceptance

Docs always match the implemented behavior at the time of each commit.

---

# 28. ADRs

## TASK-114 — ADR 001: PostgreSQL as source of truth

Cover:

- persistence requirement
- restart survival
- why memory cannot be authoritative

## TASK-115 — ADR 002: pg-boss for background processing

Cover:

- explicit task requirement
- PostgreSQL-backed queue
- why no custom queue is used

## TASK-116 — ADR 003: Express + Prisma

Cover:

- Express selection
- Prisma 7 selection (driver adapters, ESM)
- TypeScript integration
- fit for assignment scope

## TASK-117 — ADR 004: WebSocket architecture

Cover:

- connection manager
- subscription manager
- multiple clients
- state synchronization

## TASK-118 — ADR 005: Worker failure/recovery

Cover:

- worker crash problem
- pg-boss recovery semantics
- guarded state transitions
- crash-progress policy (restart from 0%)

## TASK-119 — ADR 006: Task state machine

Cover:

- states
- valid transitions
- invalid transitions
- terminal states

## TASK-120 — ADR 007: GitHub Actions CI/CD

Cover:

- automated quality gates
- PostgreSQL integration tests
- build
- CD as build + smoke-run with no push and no hosted target
- secrets/environment management

---

# 29. Final Manual Walkthrough

## TASK-121 — API walkthrough

Demonstrate:

```text
POST /tasks
→ pending
→ GET /tasks/:id
```

## TASK-122 — WebSocket walkthrough

Demonstrate:

```text
connect /ws
→ subscribe
→ state
→ progress
→ completed
```

## TASK-123 — Multiple clients walkthrough

Connect two or more clients to the same task and verify all receive updates.

## TASK-124 — Reconnect walkthrough

Disconnect during processing, reconnect, resubscribe, and verify current state.

## TASK-125 — Failure walkthrough

Cause a controlled processing error (`shouldFail`) and verify:

```text
DB = failed
REST = failed
WS = failed
```

## TASK-126 — Worker crash walkthrough

Interrupt a worker during processing and verify no permanent `processing` state.

## TASK-127 — Concurrency walkthrough

Run several tasks concurrently and verify independent progress.

## TASK-128 — Multi-worker walkthrough

Run multiple workers and verify a single task is never actively processed by two workers.

---

# 30. Final Quality Gate

Before submission:

```text
[ ] Express is used
[ ] Prisma 7 is used
[ ] PostgreSQL 18 is used
[ ] pg-boss is used
[ ] Node.js 24 + pnpm 12 used throughout (no npm)
[ ] TypeScript strict mode is enabled
[ ] No `any` exists in project code/tests
[ ] WebSocket /ws works
[ ] POST /tasks works
[ ] GET /tasks/:id works
[ ] Async processing works
[ ] pending works
[ ] processing works
[ ] completed works
[ ] failed works
[ ] completed progress = 100
[ ] progress updates reach subscribers
[ ] completion reaches subscribers
[ ] failure reaches subscribers
[ ] multiple subscribers work
[ ] reconnect recovery works
[ ] API restart persistence works
[ ] worker restart recovery works
[ ] tasks progress independently
[ ] multiple workers are safe
[ ] migrations exist
[ ] infrastructure gate passed (compose up before feature code)
[ ] docker compose up starts postgres/api/worker in one command
[ ] OpenAPI spec served at /openapi.json
[ ] Swagger UI works at /docs
[ ] README exists
[ ] ADRs exist
[ ] GitHub Actions CI works
[ ] CD builds and smoke-tests the image without pushing
[ ] no deployment secrets are required
[ ] docs kept in sync per phase
[ ] final tests and build pass
```

---

# 31. Suggested Commit Sequence

Each commit happens only after the corresponding phase has been reviewed and explicitly approved.

```text
docs: update prd and tasks for recorded decisions
chore: initialize node 24 pnpm 12 typescript project
chore: enforce strict type safety and zero-any policy
chore: add docker compose infrastructure gate
feat: add prisma postgres task schema and notify trigger
feat: add task domain and state machine
feat: implement create task endpoint
feat: add openapi documentation core
feat: integrate pg-boss publisher
feat: add worker process
feat: add task progress tracking
feat: implement get task endpoint and complete api spec
feat: add websocket gateway
feat: add websocket subscriptions
feat: broadcast progress completion and failure
feat: add reconnect state synchronization
feat: add worker failure and recovery handling
test: add task and worker tests
test: add websocket and reconnection tests
test: add concurrency and restart tests
chore: finalize docker compose with worker service
ci: add github actions ci
ci: add build-and-smoke github actions cd
docs: add readme and adrs
chore: final verification
```
