import type { TaskStatus } from "./types.ts";

/**
 * The enforced state machine. `pending → failed` exists solely for
 * reconciliation: a job whose retries are exhausted is copied to the
 * dead-letter queue and never runs again, so a task still `pending` is
 * failed directly rather than stranded forever. Worker paths still claim
 * `pending → processing` first; nothing may reach a terminal state
 * without either a run or a dead job behind it.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["processing", "failed"],
  processing: ["completed", "failed"],
  completed: [],
  failed: [],
};

export interface StateTransitionInput {
  from: TaskStatus;
  to: TaskStatus;
}

export type StateTransitionResult =
  | { ok: true; from: TaskStatus; to: TaskStatus }
  | { ok: false; from: TaskStatus; to: TaskStatus; reason: string };

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function checkTransition(input: StateTransitionInput): StateTransitionResult {
  const { from, to } = input;
  if (canTransition(from, to)) {
    return { ok: true, from, to };
  }
  return { ok: false, from, to, reason: `invalid transition: ${from} -> ${to}` };
}
