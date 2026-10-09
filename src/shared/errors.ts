import type { NextFunction, Request, Response } from "express";
import type { ValidationIssue } from "../lib/validation.ts";

/** TASK-026 — HTTP error mapping. Bodies never expose stack traces. */

export function sendValidationError(
  res: Response,
  issues: ValidationIssue[],
): void {
  res.status(400).json({ error: "validation_failed", issues });
}

export function sendNotFound(res: Response): void {
  res.status(404).json({ error: "not_found" });
}

export function sendInternalError(res: Response): void {
  res.status(500).json({ error: "internal_error" });
}

/** JSON 404 for any route that did not match. */
export function notFoundHandler(_req: Request, res: Response): void {
  sendNotFound(res);
}

function readStatus(error: unknown): number {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { status?: unknown; statusCode?: unknown };
    if (typeof candidate.status === "number") {
      return candidate.status;
    }
    if (typeof candidate.statusCode === "number") {
      return candidate.statusCode;
    }
  }
  return 500;
}

function readType(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { type?: unknown };
    if (typeof candidate.type === "string") {
      return candidate.type;
    }
  }
  return "";
}

/**
 * Express error middleware (4 parameters are the contract). Maps body-parser
 * failures to 4xx, passes other 4xx through, and answers 500 with a generic
 * body — the cause is logged, never sent to the client.
 */
export function httpErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = readStatus(error);
  if (status === 400 && readType(error) === "entity.parse.failed") {
    sendValidationError(res, [{ path: "", message: "malformed JSON body" }]);
    return;
  }
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: "bad_request" });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`unhandled error: ${message}`);
  sendInternalError(res);
}
