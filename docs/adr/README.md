# Architecture Decision Records

Significant technical choices made during AWTY's implementation, one per task in `docs/TASKS.md` §28.

| ADR                                                     | Decision                              |
| ------------------------------------------------------- | ------------------------------------- |
| [001](001-postgresql-source-of-truth.md)                | PostgreSQL as the source of truth     |
| [002](002-pg-boss-queue.md)                             | pg-boss for background processing     |
| [003](003-express-and-prisma.md)                        | Express + Prisma (driver adapters)    |
| [004](004-websocket-architecture.md)                    | WebSocket connection/subscription design |
| [005](005-worker-failure-recovery.md)                   | Worker crash recovery, restart from 0% |
| [006](006-task-state-machine.md)                        | Task state machine                    |
| [007](007-github-actions-ci-cd.md)                      | GitHub Actions CI/CD, no hosted target |
