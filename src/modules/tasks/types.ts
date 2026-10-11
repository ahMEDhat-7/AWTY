import type { z } from "zod";
import type { Prisma, Task } from "../../generated/prisma/client.ts";
import type { ValidationIssue } from "../../lib/validation.ts";
import type { createTaskBodySchema, taskQueuePayloadSchema } from "./dto.ts";
import type { createTaskRepository } from "./repository.ts";
import type { createTaskRunner } from "./runner.ts";

export const TASK_STATUSES = ["pending", "processing", "completed", "failed"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskState {
  id: string;
  duration: number;
  status: TaskStatus;
  progress: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
}

export interface CreateTaskResponse {
  id: string;
  status: TaskStatus;
}

/** GET /tasks/:id transport shape — current, DB-authoritative state. */
export interface TaskStateResponse {
  id: string;
  status: TaskStatus;
  progress: number;
}

export interface TaskResponse {
  id: string;
  duration: number;
  status: TaskStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
}

/** DTO: validated POST /tasks body. The schema is the single source of truth. */
export type CreateTaskBodyDto = z.infer<typeof createTaskBodySchema>;

/** DTO: validated queue job payload derived from its schema. */
export type TaskQueuePayloadDto = z.infer<typeof taskQueuePayloadSchema>;

/** The enforced transition pairs, as an input to the transition check. */
export interface StateTransitionInput {
  from: TaskStatus;
  to: TaskStatus;
}

export type StateTransitionResult =
  | { ok: true; from: TaskStatus; to: TaskStatus }
  | { ok: false; from: TaskStatus; to: TaskStatus; reason: string };

export type CreateTaskResult =
  | { ok: true; task: CreateTaskResponse }
  | { ok: false; kind: "validation"; issues: ValidationIssue[] }
  | { ok: false; kind: "unexpected"; cause: unknown };

export interface CreateTaskServiceDeps {
  runInTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
  publish(
    tx: Prisma.TransactionClient,
    payload: TaskQueuePayloadDto,
    options: { durationSeconds: number },
  ): Promise<void>;
}

export type GetTaskResult =
  | { ok: true; task: TaskStateResponse }
  | { ok: false; kind: "validation"; issues: ValidationIssue[] }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "unexpected"; cause: unknown };

export interface GetTaskServiceDeps {
  findById(id: string): Promise<Task | null>;
}

export type CreateTaskHandler = (body: unknown) => Promise<CreateTaskResult>;
export type GetTaskHandler = (id: string) => Promise<GetTaskResult>;

export type TaskRepository = ReturnType<typeof createTaskRepository>;

export interface TaskRunnerDeps
  extends Pick<
    TaskRepository,
    | "findById"
    | "markProcessing"
    | "restartProcessing"
    | "updateProgress"
    | "markCompleted"
    | "markFailed"
  > {
  /** Injectable timer — unit tests run instantly, the worker injects real timers. */
  sleep(ms: number): Promise<void>;
}

export type TaskRunner = ReturnType<typeof createTaskRunner>;
