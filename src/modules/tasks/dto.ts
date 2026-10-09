import { z } from "zod";
import {
  uuidSchema,
  validationFailure,
  type ParseResult,
} from "../../lib/validation.ts";

/**
 * Duration assumption (documented in PRD §9): the source requirement defines
 * duration only as "seconds", so we fix it to an integer in the range 1..300 —
 * the same bounds the database enforces via CHECK "Task_duration_range".
 */
export const createTaskBodySchema = z.object({
  duration: z.number().int().min(1).max(300),
  shouldFail: z.boolean().optional(),
});

/** DTO: validated POST /tasks body. The schema is the single source of truth. */
export type CreateTaskBodyDto = z.infer<typeof createTaskBodySchema>;

/** TASK-018: unknown request body -> validated, typed DTO. Never throws. */
export function parseCreateTaskBody(input: unknown): ParseResult<CreateTaskBodyDto> {
  const parsed = createTaskBodySchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  return validationFailure(parsed.error);
}

/**
 * pg-boss payloads are never trusted (TASK-020): the queue may hand us
 * arbitrary data, so every job body is re-validated before use. Unknown keys
 * are stripped; shouldFail lives only in the payload, never on the task row.
 */
export const taskQueuePayloadSchema = z.object({
  taskId: uuidSchema,
  shouldFail: z.boolean().optional(),
});

/** DTO: validated queue job payload derived from its schema. */
export type TaskQueuePayloadDto = z.infer<typeof taskQueuePayloadSchema>;

export function parseQueuePayload(input: unknown): ParseResult<TaskQueuePayloadDto> {
  const parsed = taskQueuePayloadSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  return validationFailure(parsed.error);
}
