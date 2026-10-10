# ADR-007: GitHub Actions CI/CD

**Status:** Accepted

## Context

The submission needs automated proof that every change still type-checks, lints (zero-`any`), passes unit and integration tests against a real PostgreSQL, and produces a runnable production image. PRD §5 additionally decides there is **no hosted deployment target**, so "delivery" cannot mean deploying anywhere.

## Decision

Two workflows in `.github/workflows/`:

**CI (`ci.yml`)** — on pull requests and pushes to `main`:

```text
pnpm 12 (cached store) + Node 24 → frozen install → prisma generate/validate
→ typecheck → lint → build → migrations from a clean state → unit tests
→ integration tests (PostgreSQL service) → OpenAPI check
```

- A `postgres:18-alpine` **service** with a `pg_isready` health gate backs integration tests; migrations are applied with `prisma migrate deploy` from an empty database (TASK-099).
- `pnpm lint` carries the zero-`any` rule and `pnpm typecheck` the strict compiler — CI rejects both classes of failure (TASK-100).
- **Build runs before the tests**, not last: the stack E2E suite spawns `dist/worker-entry.js` and would otherwise self-skip. (Order synced into PRD §25 / TASKS §25.)
- The only cache is the pnpm store — it speeds installs without extra machinery (TASK-101).

**CD (`cd.yml`)** — `workflow_run` after CI succeeds on `main`:

```text
docker build (no push) → fresh PostgreSQL → migrate deploy
→ api + worker containers (one image, two commands)
→ POST /tasks → poll GET /tasks/:id until completed / progress 100
```

The image is the deployable artifact; nothing is pushed to any registry and no provider-specific step exists.

**Secrets/environment management:** none beyond the default `GITHUB_TOKEN`. The only runtime configuration is `DATABASE_URL` (dev-only `awty/awty` credentials in compose/CI). If a secret were ever needed it would go in GitHub Environments/Secrets — never in the repository (TASK-104).

## Consequences

- Every push proves the full stack end to end: gates run against a real database, not mocks, and the smoke test proves the production image boots, migrates, and completes a task.
- No registry, no infrastructure, no secrets to manage — delivery is fully reproducible from the repository alone.
- CI owns quality, CD owns artifact confidence; a red CI blocks CD by construction.
