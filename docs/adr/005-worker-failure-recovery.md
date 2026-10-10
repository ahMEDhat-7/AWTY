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

The crashed run's partial progress is **discarded, never resumed** — the simulation is deterministic, so restarting from 0% is correct and simpler than checkpointing.

## Consequences

- Verified behavior: SIGTERM mid-task → task completes before the worker exits; SIGKILL mid-task → frozen row is redelivered, reported as `restarting from 0%`, and completes (~47s after restart).
- A task can never be stranded in `processing`; every run ends `completed` or `failed`.
- Cost: a crash loses elapsed simulation time (progress restarts at 0), an explicit product decision (PRD §5).
