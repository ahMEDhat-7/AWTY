# ADR-005: Worker failure and recovery

**Status:** Accepted (decision recorded in `docs/PRD.md` §5)

## Context

A worker can die at any moment — SIGTERM mid-task, SIGKILL, OOM, host reboot. If the task row says `processing` and nobody resumes it, the task is stranded forever: `GET` shows a frozen progress value and subscribers wait for a completion that never comes.

## Decision

**Two-stage guarded claim with a restart-from-0% policy**, riding on pg-boss recovery semantics:

1. **pg-boss owns delivery.** Instance heartbeats + the monitor (default 60s pass) re-deliver jobs from a dead worker; the per-job `expireInSeconds = duration + 60` is a second safety net. A worker that receives its own job back is not allowed to assume anything — the database decides.
2. **Stage one — `markProcessing`** claims `pending → processing` (guarded transition, ADR-006). Only a job whose task is still `pending` or already `processing` proceeds.
3. **Stage two — `restartProcessing`** handles redelivery into `processing`: it resets `progress` to `0` and stamps a fresh `startedAt`, then reruns the simulation from the beginning.
4. **Graceful shutdown**: SIGTERM drains in-flight handlers (`boss.stop()`), so a normal deploy lets the running task finish.
5. **Guarded transitions** make concurrent claims impossible: job ownership plus the state machine (ADR-006) mean two workers can never actively process one task.
6. **Dead-letter reconciliation for retry exhaustion.** Redelivery only helps while pg-boss keeps retrying. When a job exhausts `retryLimit`, pg-boss 12.37.0 copies its payload to the queue's dead-letter queue (`awty-tasks-dead` — there is no failed-job event in this version, the DLQ is the native hook). The worker consumes that queue and fails the task the payload names through the guarded `pending|processing → failed` update (`markFailedIfOpen`). An invalid dead-letter payload is logged and settled — redelivery could never fix it; a reconciliation error is thrown so pg-boss redelivers the DLQ job. This closes the last stranding path: pre-claim failures (e.g. the database unreachable through every retry) can no longer leave a task `pending` forever.

The crashed run's partial progress is **discarded, never resumed** — the simulation is deterministic, so restarting from 0% is correct and simpler than checkpointing. A task that fails through reconciliation preserves its last durable progress, like every other failure.

## Consequences

- Verified behavior: SIGTERM mid-task → task completes before the worker exits; SIGKILL mid-task → frozen row is redelivered, reported as `restarting from 0%`, and completes (~47s after restart); a dead-lettered job naming an open task → the reconciler fails it (covered in the stack E2E suite, alongside the idempotency case where a late dead letter leaves a terminal task untouched).
- A task can never be stranded in `pending` or `processing`: a run, a crash-restart, or a dead-lettered job always ends it `completed` or `failed`.
- Cost: a crash loses elapsed simulation time (progress restarts at 0), an explicit product decision (PRD §5).
