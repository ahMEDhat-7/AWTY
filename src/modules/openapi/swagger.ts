import type { Express } from "express";
import swaggerUi from "swagger-ui-express";
import { openApiDocument } from "./spec.ts";

/**
 * Mounts the API documentation endpoints on the app.
 *
 * @param app - the Express app to mount onto
 * @returns nothing; registers `GET /openapi.json` and the UI at `/docs`
 */
export function mountOpenApi(app: Express): void {
  app.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
}
