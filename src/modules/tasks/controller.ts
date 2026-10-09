import { Router } from "express";
import { sendInternalError, sendNotFound, sendValidationError } from "../../shared/errors.ts";
import type { CreateTaskResult, GetTaskResult } from "./service.ts";

export type CreateTaskHandler = (body: unknown) => Promise<CreateTaskResult>;
export type GetTaskHandler = (id: string) => Promise<GetTaskResult>;

/**
 * TASK-025/026/042 — task controllers. They validate nothing themselves:
 * raw input goes to the service (DTO at the boundary), and every outcome
 * maps to a status code — POST: 201/400/500; GET: 200/400/404/500.
 */
export function createTasksRouter(
  createTask: CreateTaskHandler,
  getTask: GetTaskHandler,
): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const result = await createTask(req.body as unknown);
    if (result.ok) {
      res.status(201).json(result.task);
      return;
    }
    if (result.kind === "validation") {
      sendValidationError(res, result.issues);
      return;
    }
    const message =
      result.cause instanceof Error ? result.cause.message : String(result.cause);
    console.error(`task creation failed: ${message}`);
    sendInternalError(res);
  });

  router.get("/:id", async (req, res) => {
    const result = await getTask(req.params.id);
    if (result.ok) {
      res.status(200).json(result.task);
      return;
    }
    if (result.kind === "validation") {
      sendValidationError(res, result.issues);
      return;
    }
    if (result.kind === "not_found") {
      sendNotFound(res);
      return;
    }
    const message =
      result.cause instanceof Error ? result.cause.message : String(result.cause);
    console.error(`task read failed: ${message}`);
    sendInternalError(res);
  });

  return router;
}
