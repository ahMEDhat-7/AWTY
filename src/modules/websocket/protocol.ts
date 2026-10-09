import type { ValidationIssue } from "../../lib/validation.ts";
import type { TaskStatus } from "../tasks/types.ts";

/**
 * TASK-052 — structured protocol errors: the WebSocket mirror of the REST
 * error contract (`validation_failed` + issues / `not_found` /
 * `internal_error`). Malformed input is a value here, never an exception.
 */
export type WsProtocolError =
  | { type: "error"; error: "validation_failed"; issues: ValidationIssue[] }
  | { type: "error"; error: "not_found" }
  | { type: "error"; error: "internal_error" };

export type WsOutboundMessage =
  | { type: "progress"; taskId: string; progress: number }
  | { type: "completed"; taskId: string }
  | { type: "failed"; taskId: string }
  | { type: "state"; taskId: string; status: TaskStatus; progress: number }
  | WsProtocolError;

/**
 * Broadcastable updates: every outbound message addressed to a task's
 * subscribers (TASK-049/050/051). Protocol errors are per-socket replies
 * and are deliberately excluded.
 */
export type WsTaskUpdate = Extract<WsOutboundMessage, { taskId: string }>;
