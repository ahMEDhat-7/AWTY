import type { NextFunction, Request, Response } from "express";
import type { ValidationIssue } from "../lib/validation.ts";

/** HTTP error mapping. Bodies never expose stack traces. */

/**
 * Sends a validation-failure response.
 *
 * @param res - the Express response to write
 * @param issues - the field-level validation problems to report
 * @returns nothing; responds with 400 `{ error: "validation_failed", issues }`
 */
export function sendValidationError(
  res: Response,
  issues: ValidationIssue[],
): void {
  res.status(400).json({ error: "validation_failed", issues });
}

/**
 * Sends a not-found response.
 *
 * @param res - the Express response to write
 * @returns nothing; responds with 404 `{ error: "not_found" }`
 */
export function sendNotFound(res: Response): void {
  res.status(404).json({ error: "not_found" });
}

/**
 * Sends a generic internal-error response.
 *
 * @param res - the Express response to write
 * @returns nothing; responds with 500 `{ error: "internal_error" }`
 */
export function sendInternalError(res: Response): void {
  res.status(500).json({ error: "internal_error" });
}

/**
 * Express middleware that answers any route that did not match.
 *
 * @param _req - the unmatched request (unused)
 * @param res - the Express response to write
 * @returns nothing; sends a JSON 404
 */
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
 * Express error middleware (4 parameters are the contract).
 *
 * Maps body-parser failures to 4xx, passes other 4xx through, and answers
 * 500 with a generic body — the cause is logged, never sent to the client.
 *
 * @param error - the caught error (untrusted shape)
 * @param _req - the request that failed (unused)
 * @param res - the Express response to write
 * @param next - forwards the error when headers were already sent
 * @returns nothing; sends the mapped error body
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
