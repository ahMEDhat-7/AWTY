import express, { type Express } from "express";
import type { Prisma } from "../generated/prisma/client.ts";
import { prisma } from "../lib/prisma.ts";
import { createTasksRouter } from "../modules/tasks/controller.ts";
import { createCreateTaskService } from "../modules/tasks/service.ts";
import { mountOpenApi } from "../modules/openapi/swagger.ts";
import { publishTaskJob } from "../queue/publisher.ts";
import { httpErrorHandler, notFoundHandler } from "../shared/errors.ts";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ok", db: "connected" });
    } catch {
      res.status(503).json({ status: "degraded", db: "disconnected" });
    }
  });

  mountOpenApi(app);

  const createTask = createCreateTaskService({
    runInTransaction: <T,>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction(fn),
    publish: publishTaskJob,
  });
  app.use("/tasks", createTasksRouter(createTask));

  app.use(notFoundHandler);
  app.use(httpErrorHandler);

  return app;
}
