import type { Prisma, Task } from "../../generated/prisma/client.ts";
import { uuidSchema, validationFailure, type ValidationIssue } from "../../lib/validation.ts";
import { parseCreateTaskBody, type TaskQueuePayloadDto } from "./dto.ts";
import { createTaskRepository } from "./repository.ts";
import type { CreateTaskResponse, TaskStateResponse } from "./types.ts";

export type CreateTaskResult =
  | { ok: true; task: CreateTaskResponse }
  | { ok: false; kind: "validation"; issues: ValidationIssue[] }
  | { ok: false; kind: "unexpected"; cause: unknown };

export interface CreateTaskServiceDeps {
  runInTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
  publish(tx: Prisma.TransactionClient, payload: TaskQueuePayloadDto): Promise<void>;
}

/**
 * TASK-023/024 — create-task application service.
 *
 * validate → create pending task → enqueue job → return task ID.
 * The insert and the queue publication share one transaction, so the task
 * row and its pg-boss job commit atomically (or not at all).
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
        await deps.publish(tx, {
          taskId: created.id,
          shouldFail: parsed.data.shouldFail ?? false,
        });
        return created;
      });
      return { ok: true, task: { id: task.id, status: task.status } };
    } catch (cause) {
      return { ok: false, kind: "unexpected", cause };
    }
  };
}

export type GetTaskResult =
  | { ok: true; task: TaskStateResponse }
  | { ok: false; kind: "validation"; issues: ValidationIssue[] }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "unexpected"; cause: unknown };

export interface GetTaskServiceDeps {
  findById(id: string): Promise<Task | null>;
}

/**
 * TASK-041 — get-task application service. PostgreSQL is always
 * authoritative: this reads back exactly what the worker's guarded writes
 * persisted. The path id is untrusted input — a malformed UUID is a
 * validation error (400); a well-formed but unknown UUID is not_found (404).
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
