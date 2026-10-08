import type { TaskStatus } from "./types.ts";

const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["processing"],
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
