# AWTY (Are We There Yet?) — Product Requirements Document

## 1. Purpose

AWTY is a real-time asynchronous task-processing backend. A client submits a task that takes time to complete, immediately receives a task ID, and follows progress through a WebSocket connection.

This PRD converts the recruitment-task requirements into an implementation-ready product and system specification.

## 2. Explicit Requirements

The system must use:

- Node.js 24
- pnpm 12 (never npm)
- TypeScript
- Express
- REST API
- WebSocket
- PostgreSQL
- Prisma ORM 7
- pg-boss
- Swagger/OpenAPI for REST API documentation
- GitHub Actions for CI/CD

The source task additionally requires asynchronous processing, persistent task state, restart recovery, multiple subscribers, reconnection recovery, failure handling, and independent task processing. It explicitly defines the states `pending`, `processing`, `completed`, and `failed`; a completed task has `progress = 100`.

## 3. Type-Safety Requirement

Type safety is a hard engineering rule for the whole project.

### Mandatory rules

1. TypeScript strict mode is enabled.
2. `any` is forbidden in application code, tests, and infrastructure TypeScript configuration.
3. Never use `as any` or another type-system escape hatch to bypass correctness.
4. Use explicit domain types, discriminated unions, enums, generics, and Prisma-generated types.
5. Use `unknown` for genuinely unknown external values and narrow them safely.
6. Validate HTTP bodies, route parameters, WebSocket messages, queue payloads, and environment configuration at runtime.
7. Errors caught by `catch` are handled as `unknown` and narrowed safely.
8. CI must fail when type-checking fails or the no-`any` policy is violated.

## 4. Product Scope

### In scope

- `POST /tasks`
- `GET /tasks/:id`
- asynchronous pg-boss processing
- periodic progress persistence
- WebSocket `/ws`
- task subscription
- multiple simultaneous subscribers
- progress/completion/failure messages
- reconnect state synchronization
- durable PostgreSQL task state
- worker crash recovery
- independent task processing
- multi-worker-safe processing
- automated tests
- database migrations/schema
- OpenAPI 3.1 specification at `GET /openapi.json` and Swagger UI at `/docs`
- README
- ADRs
- Docker Compose (`postgres:18-alpine` + `api` + `worker`, one image with two commands)
- GitHub Actions CI
- GitHub Actions CD (build + smoke-run of the production image, no push)

### Out of scope

Unless the evaluator introduces new requirements, do not add authentication, authorization, billing, admin UI, Redis, Kafka, RabbitMQ, Kubernetes, microservices, event sourcing, CQRS, GraphQL, task cancellation, retry APIs, priorities, schedules, or complex task history.

## 5. Assumptions to Document

The task document leaves some details open. These are recorded here as explicit implementation decisions, not silently presented as source requirements.

### Duration

The source says `duration` is the number of seconds the task should take but does not define exact minimum/maximum/type semantics. **Decision:** positive integer seconds in the range **1–300**, enforced by runtime validation and a database CHECK constraint.

### Failed progress

The source does not define failed-task progress. **Decision:** preserve the last known progress.

### Worker crash progress

The source requires that a worker crash cannot leave a task in `processing` forever, but it does not explicitly require exact resume. **Decision:** recovery **restarts the simulation from 0%**; guarded state transitions prevent double-processing. Exact resume from persisted progress is not attempted.

### Task ID

The source only requires a task ID. **Decision:** UUID.

### Failure injection

The source requires demonstrating failure handling but defines no input for causing a failure. **Decision:** `POST /tasks` accepts an optional `shouldFail` boolean that is carried **only in the pg-boss queue payload**; the `Task` table shape stays exactly as specified in §9. The worker fails deterministically mid-run when the flag is set.

### CD deployment target

The source requires source-code submission and documentation but does not name a hosting provider. **Decision:** there is **no hosted deployment target**. GitHub Actions CD builds the production Docker image and smoke-runs it (API + worker + PostgreSQL) inside the CI runner; the image is the deployable artifact. No registry push and no provider-specific steps.

### Toolchain versions

**Decision:** Node.js 24, pnpm 12, Prisma ORM 7 (stable; v8 is release-candidate only), TypeScript pinned to a version supported by the lint toolchain. PRD §2 names the technologies without versions; versions are implementation decisions.

## 6. Actors

### Client

Creates tasks, queries tasks, connects to `/ws`, subscribes, receives updates, and reconnects to recover state.

### API process

Express REST API plus WebSocket gateway. Handles validation, task creation/querying, live connections, and subscriptions.

### Worker process

Consumes pg-boss jobs, performs simulated work, updates progress, completes or fails tasks.

### PostgreSQL

Durable source of truth for task state and pg-boss persistence.

### pg-boss

Asynchronous job queue and worker delivery mechanism. No custom queue is allowed.

## 7. High-Level Architecture

```text
                         ┌───────────────────────┐
                         │        Client         │
                         │   REST + WebSocket    │
                         └───────────┬───────────┘
                                     │
                    ┌────────────────┴─────────────────┐
                    │                                  │
                    ▼                                  ▼
            ┌────────────────┐                 ┌────────────────┐
            │ Express REST   │                 │ WebSocket      │
            │ API            │                 │ Gateway        │
            │                │                 │                │
            │ Controllers    │                 │ Connections    │
            │ Task Service   │                 │ Subscriptions  │
            └───────┬────────┘                 └───────┬────────┘
                    │                                  │
                    └────────────────┬─────────────────┘
                                     │
                                     ▼
                         ┌────────────────────────┐
                         │      PostgreSQL        │
                         │       + Prisma         │
                         │                        │
                         │       tasks            │
                         │   source of truth      │
                         └─────────┬──────┬───────┘
                                   │      │
                              queue│      │notifications
                                   │      │
                                   ▼      │
                            ┌────────────┐│
                            │  pg-boss   ││
                            │ task jobs  ││
                            └─────┬──────┘│
                                  │       │
                                  ▼       │
                           ┌────────────┐ │
                           │   Worker   │─┘
                           │            │
                           │ Process    │
                           │ Progress   │
                           │ Complete   │
                           │ Fail       │
                           └────────────┘
```

### Core principle

> PostgreSQL owns durable state, pg-boss owns asynchronous work delivery, workers execute the work, Express serves REST/WebSocket traffic, and in-memory structures only track live WebSocket connections/subscriptions.

## 8. Component Responsibilities

### Task Controller

Maps HTTP requests to application services and maps domain results/errors to HTTP responses. It does not own business logic or SQL.

### Task Service

Coordinates creation, retrieval, state transitions, progress updates, completion, and failure semantics.

### Task Repository

Prisma-backed persistence abstraction for task reads and guarded state updates.

### Queue publisher

Publishes typed task jobs through pg-boss.

### Worker

Consumes the job, performs the simulated task, updates progress, and transitions the task to completed or failed.

### WebSocket Gateway

Owns socket lifecycle and protocol handling.

### Connection Manager

Tracks live sockets in memory.

### Subscription Manager

Maintains the logical mapping `taskId -> Set<connection>`.

### Notification mechanism

Signals that persisted state changed so the WebSocket gateway can broadcast it. A notification is not durable state.

### API documentation module

Builds the OpenAPI 3.1 document from the same zod schemas used for runtime request validation and serves it at `/openapi.json` with Swagger UI at `/docs`. It never duplicates validation logic.

## 9. Database Model

### `Task`

```text
Task
├── id
├── duration
├── status
├── progress
├── createdAt
├── updatedAt
├── startedAt
├── completedAt
└── failedAt
```

### State invariants

```text
pending      => progress = 0
processing   => 0 <= progress < 100
completed    => progress = 100
failed       => last known progress, according to documented policy
```

The database/schema and domain layer should protect ID uniqueness, positive duration, progress bounds, and valid statuses.

## 10. Task State Machine

```text
                  ┌──────────────┐
                  │    PENDING   │
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │  PROCESSING  │
                  └──────┬───────┘
                         │
                  ┌──────┴─────────┐
                  │                │
                  ▼                ▼
           ┌────────────┐    ┌────────────┐
           │ COMPLETED  │    │   FAILED   │
           └────────────┘    └────────────┘
```

Valid transitions:

```text
pending    -> processing
processing -> completed
processing -> failed
```

No public retry/cancel transitions are required by the source.

## 11. REST API

### POST `/tasks`

Request:

```http
POST /tasks
Content-Type: application/json
```

```json
{
  "duration": 10
}
```

Response:

```json
{
  "id": "abc123",
  "status": "pending"
}
```

Behavior:

1. Parse the request as untrusted input.
2. Validate and create a strongly typed input value.
3. Start the transaction-safe task-creation/queue-publication flow supported by the selected pg-boss version.
4. Persist the task as `pending`, progress `0`.
5. Enqueue a typed job payload containing the task ID.
6. Commit.
7. Return immediately without waiting for task completion.

Recommended response codes: `201` for success, `400` for validation errors, `500` for unexpected server errors.

### GET `/tasks/:id`

Reads the current task state from PostgreSQL.

Example:

```json
{
  "id": "abc123",
  "status": "processing",
  "progress": 50
}
```

Recommended response codes: `200` for success, `404` for unknown task.

### API documentation

The REST API is documented with OpenAPI 3.1:

1. The specification is generated from the same zod validation schemas used at runtime, so documentation and behavior cannot drift.
2. `GET /openapi.json` returns the specification; Swagger UI is served at `/docs`.
3. The specification covers `POST /tasks` and `GET /tasks/:id`, including request bodies, success responses, and error responses.
4. The WebSocket protocol is documented in the README because OpenAPI does not cover WebSocket protocols.
5. CI validates that the specification generates and is well-formed.

## 12. POST /tasks Reliability

There is a potential consistency problem if task creation and job enqueueing are implemented as separate independent actions:

```text
DB insert succeeds -> process crashes -> no queue job
```

The preferred architecture is to use the PostgreSQL/pg-boss transaction-aware capability supported by the exact pg-boss version so the task row and enqueue operation are coordinated.

Do not invent a pg-boss API. Verify the installed version's exact transaction/queue semantics before implementation.

## 13. Worker Design

The worker is a separate runtime/process.

Normal flow:

```text
pg-boss job
   ↓
worker receives taskId
   ↓
load task
   ↓
pending -> processing
   ↓
simulate duration
   ↓
periodically update progress
   ↓
processing -> completed
```

For an error:

```text
processing
   ↓
error
   ↓
failed
```

One task failure must not crash the entire worker process.

## 14. Progress Calculation

A recommended calculation is:

```text
progress = floor((elapsedSeconds / durationSeconds) * 100)
```

bounded to `0..100`.

For a 10-second task, approximately:

```text
0s  -> 0%
1s  -> 10%
2s  -> 20%
5s  -> 50%
9s  -> 90%
10s -> 100%
```

Timer accuracy should not be treated as exact; elapsed time is the reliable basis.

## 15. WebSocket API

Connect to:

```text
/ws
```

Subscribe:

```json
{
  "type": "subscribe",
  "taskId": "abc123"
}
```

### Required progress message

```json
{
  "type": "progress",
  "taskId": "abc123",
  "progress": 25
}
```

### Required completion message

```json
{
  "type": "completed",
  "taskId": "abc123"
}
```

### Recommended failure message

```json
{
  "type": "failed",
  "taskId": "abc123"
}
```

### Recommended state synchronization message

```json
{
  "type": "state",
  "taskId": "abc123",
  "status": "processing",
  "progress": 72
}
```

The source allows additional messages; `state` exists to make reconnect recovery deterministic.

## 16. WebSocket Subscription Architecture

In memory only:

```text
Map<TaskId, Set<Connection>>
```

Example:

```text
Task A
 ├── Client 1
 ├── Client 2
 └── Client 3
```

On disconnect, remove the connection from all relevant subscription sets.

Task processing must not depend on any socket being connected.

## 17. Reconnection Strategy

A WebSocket connection is not durable. A missed message must not imply a lost task state.

Recommended sequence:

```text
connect /ws
   ↓
subscribe(taskId)
   ↓
register subscription
   ↓
read current task from PostgreSQL
   ↓
send state message
   ↓
receive future progress/completion/failure updates
```

Examples:

```json
{
  "type": "state",
  "taskId": "abc123",
  "status": "processing",
  "progress": 82
}
```

or, if already finished:

```json
{
  "type": "state",
  "taskId": "abc123",
  "status": "completed",
  "progress": 100
}
```

No event-history/replay system is required by the source.

## 18. Update Propagation

Recommended conceptual flow:

```text
Worker
  ↓
update PostgreSQL
  ↓
state-change notification
  ↓
WebSocket gateway
  ↓
find subscribers for taskId
  ↓
broadcast update
```

The notification is only a trigger. PostgreSQL remains authoritative.

For a multi-instance API later, the database notification approach can inform each API instance that owns live sockets.

## 19. Concurrency

Multiple workers are allowed and are a bonus, but if enabled the same task must never be actively processed by two workers.

Use pg-boss's job ownership/delivery semantics instead of implementing a custom queue.

Add guarded state transitions so stale or duplicate execution attempts cannot arbitrarily move a task between states.

Example logical guards:

```text
pending -> processing only when current state is pending
processing -> completed only when current state is processing
processing -> failed only when current state is processing
```

## 20. Worker Crash Recovery

Critical requirement:

> A worker crash must not strand a task in `processing` forever.

The worker/pg-boss configuration must use pg-boss's actual retry/ownership/recovery mechanisms. The exact options must be verified for the chosen version.

Conceptually:

```text
Worker A receives Job
      ↓
Task = processing
      ↓
Worker A crashes
      ↓
pg-boss recovers/re-delivers according to its configured semantics
      ↓
Worker B processes the job
      ↓
completed or failed
```

Whether the recovered simulation resumes from last progress or starts again must be documented as an implementation decision.

## 21. Error Handling

### REST

- validation errors -> `4xx`
- missing task -> `404`
- unexpected server failure -> `500`

### Worker

- catch task exceptions as `unknown`
- normalize safely
- log error internally
- persist `failed`
- publish failure update
- continue serving other jobs

### WebSocket

Malformed protocol messages must not crash the process. Use structured protocol errors where appropriate.

## 22. Express + Prisma Module Structure

```text
src/
├── app/
│   ├── app setup
│   ├── server bootstrap
│   └── configuration
├── worker-entry (independent worker bootstrap)
├── modules/
│   ├── tasks/
│   │   ├── controller
│   │   ├── service
│   │   ├── repository
│   │   ├── types
│   │   └── validation
│   ├── websocket/
│   │   ├── gateway
│   │   ├── connection manager
│   │   ├── subscription manager
│   │   ├── protocol types
│   │   └── validation
│   └── openapi/
│       ├── spec builder
│       └── swagger mounting
├── queue/
│   ├── pg-boss configuration
│   ├── publisher
│   └── worker
├── database/
│   └── Prisma configuration
└── shared/
    ├── errors
    ├── logging
    └── utilities
```

## 23. Dependency Direction

```text
Express Controller
      ↓
Application Service
      ↓
Repository / Queue abstraction
      ↓
Prisma / pg-boss
```

Worker:

```text
pg-boss consumer
      ↓
Task Service
      ↓
Task Repository
      ↓
Prisma
```

WebSocket:

```text
WS Gateway
      ↓
Task Service / subscription layer
      ↓
Repository
      ↓
Prisma
```

Controllers and WebSocket handlers should not contain SQL.

## 24. Docker Compose

Required topology:

```text
┌──────────────────────────┐
│ postgres:18-alpine       │
│ named volume + healthcheck│
└───────────┬──────────────┘
            │ service_healthy
      ┌─────┴─────┐
      ▼           ▼
┌────────┐  ┌─────────┐
│  api   │  │  worker  │
└────────┘  └─────────┘
```

Rules:

- `postgres` is `postgres:18-alpine` with a named volume and a `pg_isready` healthcheck.
- `api` and `worker` are built from **one Dockerfile / one image** and differ only by command (`node dist/app/server.js` vs `node dist/worker-entry.js`).
- `api`/`worker` start only after `postgres` is healthy.
- The infrastructure gate requires `docker compose up` to bring up a connected stack **before feature code is implemented** (PRD-aligned with TASK-008 in TASKS.md).
- One command (`docker compose up`) brings up the local stack; `docker compose up --scale worker=2` demonstrates multi-worker operation.

## 25. GitHub Actions CI/CD

### CI

File:

`.github/workflows/ci.yml`

Triggers:

- pull requests
- push to main/default branch

Pipeline:

```text
checkout
→ setup pnpm 12 + Node.js 24 (pnpm store cache)
→ install dependencies (pnpm install --frozen-lockfile)
→ generate Prisma client
→ validate Prisma/migrations
→ typecheck
→ lint
→ unit tests
→ integration tests with PostgreSQL
→ OpenAPI specification check
→ build
```

The pipeline must fail on type errors, lint errors, test failures, migration/schema failures, OpenAPI specification failures, or build failures.

### CD

File:

`.github/workflows/cd.yml`

Flow:

```text
main branch
   ↓
CI gates
   ↓
build production Docker image (no push)
   ↓
smoke-run image + worker against PostgreSQL in the CI runner
   ↓
POST /tasks → poll GET /tasks/:id until completed / progress 100
```

The deployment-target decision is recorded in §5: there is **no hosted runtime**. CD exists to prove the production image builds and runs end to end. No image is pushed to any registry and no provider-specific steps exist.

Secrets: none beyond the workflow's default `GITHUB_TOKEN`. Secrets, if ever introduced, belong in GitHub Secrets/Environments, never in repository files.

## 26. Testing Strategy

### Unit tests

- duration validation
- state transition rules
- progress calculation
- error normalization
- WebSocket payload parsing
- connection manager
- subscription manager
- OpenAPI specification generation from zod schemas

### Integration tests

- POST /tasks
- GET /tasks/:id
- database persistence
- pg-boss job creation
- worker processing
- completion
- failure
- multiple subscribers
- reconnect state synchronization
- concurrent tasks
- worker restart/recovery
- `/docs` and `/openapi.json` serve a valid specification

### Manual demonstrations

1. Create a task and inspect pending state.
2. Observe worker transition to processing.
3. Observe progress.
4. Observe completion.
5. Connect multiple clients to one task.
6. Disconnect/reconnect and recover state.
7. Trigger failure.
8. Interrupt/restart worker during processing.
9. Run multiple tasks simultaneously.
10. Run multiple workers and demonstrate task ownership safety.

## 27. Observability

Structured logs should cover:

- API startup/shutdown
- worker startup/shutdown
- task creation/start/progress/completion/failure
- WebSocket connect/disconnect/subscribe
- protocol errors
- worker errors

Include `taskId` on task-related logs and worker context where useful.

## 28. ADR Set

Recommended ADRs:

```text
docs/adr/
├── 001-postgresql-source-of-truth.md
├── 002-pg-boss-background-processing.md
├── 003-express-prisma-stack.md
├── 004-websocket-reconnection-strategy.md
├── 005-worker-failure-and-recovery.md
├── 006-task-state-machine.md
└── 007-github-actions-ci-cd.md
```

Each ADR contains Context, Decision, Alternatives, and Consequences.

## 29. Submission Definition of Done

The repository is ready when a reviewer can clone it, follow the README, start PostgreSQL/API/worker, create a task, query it, subscribe through WebSocket, observe progress/completion/failure, disconnect/reconnect, restart components, and understand the concurrency/recovery decisions. The reviewer can also open `/docs` to explore the OpenAPI documentation, bring the whole stack up with a single `docker compose up`, and see the CD workflow build and smoke-test the production image without pushing it anywhere.

The final architecture should demonstrate:

```text
Correctness
Reliability
Concurrency
WebSocket behavior
Persistence
Failure recovery
Type-safe TypeScript
Maintainability
Reasoned engineering decisions
```
