# ADR-003: Express + Prisma

**Status:** Accepted

## Context

The assignment needs an HTTP API, a WebSocket endpoint, and PostgreSQL persistence, with freedom to choose the framework/ORM. The stack must be TypeScript-strict with no `any`, and local development should run without a heavyweight build step.

## Decision

- **Express 5** for the HTTP layer: mature middleware model, first-class async error handling, small surface. Routes are thin; controllers/services are plain factories wired in `createApp()` (composition over module-level singletons).
- **Prisma ORM 7** with `@prisma/client` and the **`@prisma/adapter-pg` driver adapter** (the `pg` driver): required for Prisma 7's driver-adapter architecture, ESM-compatible, and the same `pg` driver is available to pg-boss via `fromPrisma(tx)`.
- **TypeScript integration**: the client is generated into `src/generated/prisma` and compiled with the app; `erasableSyntaxOnly` and strict mode keep emitted `dist/` clean.
- **zod 4** validates every boundary and drives the OpenAPI 3.1 document (`zod-openapi`), so documentation cannot drift from validation.

## Consequences

- Type-safe queries end to end; schema changes are explicit migrations under `prisma/migrations`.
- One shared DB driver between application code, Prisma, and the queue transaction path.
- Scope fit: everything needed for the assignment (REST + WS + Postgres + tests) with no infrastructure beyond Node and PostgreSQL.
