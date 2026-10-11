import { uuidSchema, validationFailure } from "../../lib/validation.ts";
import { parseCreateTaskBody } from "./dto.ts";
import { createTaskRepository } from "./repository.ts";
import type {
  CreateTaskResult,
  CreateTaskServiceDeps,
  GetTaskResult,
  GetTaskServiceDeps,
} from "./types.ts";

/**
 * Builds the create-task application service.
 *
 * validate → create pending task → enqueue job → return task ID.
 * The insert and the queue publication share one transaction, so the task
 * row and its pg-boss job commit atomically (or not at all).
 *
 * @param deps - the transaction runner and the queue publisher to use
 * @returns an async executor that turns a raw request body into a
 *          `CreateTaskResult`
 */
export function createCreateTaskService(deps: CreateTaskServiceDeps) {
  return async function execute(body: unknown): Promise<CreateTaskResult> {
    const parsed = parseCreateTaskBody(body);
    if (!parsed.ok) {
      return { ok: false, kind: "validation", issues: parsed.issues };
    }
    try {
      const task = await deps.runInTransaction(async (tx) => {
        const created = await createTaskRepository(tx).create({
          duration: parsed.data.duration,
        });
        await deps.publish(
          tx,
          {
            taskId: created.id,
            shouldFail: parsed.data.shouldFail ?? false,
          },
          // The job's expiry is sized to this task's duration.
          { durationSeconds: parsed.data.duration },
        );
        return created;
      });
      return { ok: true, task: { id: task.id, status: task.status } };
    } catch (cause) {
      return { ok: false, kind: "unexpected", cause };
    }
  };
}

/**
 * Builds the get-task application service. PostgreSQL is always
 * authoritative: this reads back exactly what the worker's guarded writes
 * persisted. The path id is untrusted input — a malformed UUID is a
 * validation error (400); a well-formed but unknown UUID is not_found (404).
 *
 * @param deps - the repository lookup the service reads through
 * @returns an async executor that turns a raw path id into a `GetTaskResult`
 */
export function createGetTaskService(deps: GetTaskServiceDeps) {
  return async function execute(id: string): Promise<GetTaskResult> {
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      return {
        ok: false,
        kind: "validation",
        issues: validationFailure(parsed.error).issues,
      };
    }
    try {
      const task = await deps.findById(parsed.data);
      if (task === null) {
        return { ok: false, kind: "not_found" };
      }
      return {
        ok: true,
        task: { id: task.id, status: task.status, progress: task.progress },
      };
    } catch (cause) {
      return { ok: false, kind: "unexpected", cause };
    }
  };
}
