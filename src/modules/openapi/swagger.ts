import type { Express } from "express";
import swaggerUi from "swagger-ui-express";
import { openApiDocument } from "./spec.ts";

/** TASK-028 — Swagger UI at /docs, raw specification at /openapi.json. */
export function mountOpenApi(app: Express): void {
  app.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
}
