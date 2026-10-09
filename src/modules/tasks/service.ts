import type { Prisma } from "../../generated/prisma/client.ts";
import type { ValidationIssue } from "../../lib/validation.ts";
import { parseCreateTaskBody, type TaskQueuePayloadDto } from "./dto.ts";
import { createTaskRepository } from "./repository.ts";
import type { CreateTaskResponse } from "./types.ts";

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
