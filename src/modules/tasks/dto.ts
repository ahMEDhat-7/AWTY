import { z } from "zod";
import {
  uuidSchema,
  validationFailure,
  type ParseResult,
} from "../../lib/validation.ts";

/**
 * Duration assumption: the source requirement defines duration only as
 * "seconds", so we fix it to an integer in the range 1..300 — the same
 * bounds the database enforces via CHECK "Task_duration_range".
 */
export const durationSchema = z
  .number()
  .int()
  .min(1)
  .max(300)
  .meta({
    description:
      "Task duration in seconds. Integer within 1–300 — a documented assumption, enforced by runtime validation and a database CHECK.",
    example: 10,
  });

export const createTaskBodySchema = z
  .object({
    duration: durationSchema,
    shouldFail: z
      .boolean()
      .meta({
        description:
          "Fail the task mid-run to demonstrate failure handling. Carried only in the queue payload — never persisted on the task.",
      })
      .optional(),
  })
  .meta({
    id: "CreateTaskRequest",
    description: "Task to enqueue. Processing starts asynchronously.",
  });

/** DTO: validated POST /tasks body. The schema is the single source of truth. */
export type CreateTaskBodyDto = z.infer<typeof createTaskBodySchema>;

/**
 * Validates an unknown request body into a typed DTO.
 *
 * @param input - the raw request body (untrusted)
 * @returns a discriminated result: `{ ok: true, data }` or
 *          `{ ok: false, issues }`; never throws
 */
export function parseCreateTaskBody(input: unknown): ParseResult<CreateTaskBodyDto> {
  const parsed = createTaskBodySchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  return validationFailure(parsed.error);
}

/**
 * Queue job payload schema. pg-boss payloads are never trusted: the queue
 * may hand us arbitrary data, so every job body is re-validated before
 * use. Unknown keys are stripped; shouldFail lives only in the payload,
 * never on the task row.
 */
export const taskQueuePayloadSchema = z.object({
  taskId: uuidSchema,
  shouldFail: z.boolean().optional(),
});

/** DTO: validated queue job payload derived from its schema. */
export type TaskQueuePayloadDto = z.infer<typeof taskQueuePayloadSchema>;

/**
 * Validates an unknown queue job body into a typed DTO.
 *
 * @param input - the job's `data` payload (untrusted)
 * @returns a discriminated result: `{ ok: true, data }` or
 *          `{ ok: false, issues }`; never throws
 */
export function parseQueuePayload(input: unknown): ParseResult<TaskQueuePayloadDto> {
  const parsed = taskQueuePayloadSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  return validationFailure(parsed.error);
}
