import { z } from "zod";

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; issues: ValidationIssue[] };

/** Shared UUID schema for task ids appearing in WS messages and queue payloads. */
export const uuidSchema = z.uuid();

/**
 * Maps a zod failure onto the shared failure branch.
 *
 * @param error - the zod error to convert
 * @returns `{ ok: false, issues }` with dotted paths; never throws
 */
export function validationFailure(error: z.ZodError): {
  ok: false;
  issues: ValidationIssue[];
} {
  return {
    ok: false,
    issues: error.issues.map((issue) => ({
      path: (issue.path ?? []).map(String).join("."),
      message: issue.message,
    })),
  };
}
