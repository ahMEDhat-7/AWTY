import { Router } from "express";
import { sendInternalError, sendValidationError } from "../../shared/errors.ts";
import type { CreateTaskResult } from "./service.ts";

export type CreateTaskHandler = (body: unknown) => Promise<CreateTaskResult>;

/**
 * TASK-025/026 — POST /tasks controller. Validates nothing itself: the raw
 * body goes to the service (DTO at the boundary), and every outcome maps to
 * a status code: 201, 400 (validation), 500 (generic, no internals).
 */
export function createTasksRouter(createTask: CreateTaskHandler): Router {
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

  return router;
}
