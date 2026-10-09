import { z } from "zod";
import {
  uuidSchema,
  validationFailure,
  type ParseResult,
  type ValidationIssue,
} from "../../lib/validation.ts";

export const subscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  taskId: uuidSchema,
});

/** One discriminated-union member per client message type. */
export const inboundMessageSchema = z.discriminatedUnion("type", [
  subscribeMessageSchema,
]);

export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;
export type WsInboundMessage = z.infer<typeof inboundMessageSchema>;

type DecodeResult =
  | { ok: true; data: unknown }
  | { ok: false; issues: ValidationIssue[] };

function decodeJson(raw: unknown): DecodeResult {
  if (typeof raw !== "string") {
    return { ok: false, issues: [{ path: "", message: "expected a text frame" }] };
  }
  try {
    const value: unknown = JSON.parse(raw);
    return { ok: true, data: value };
  } catch {
    return { ok: false, issues: [{ path: "", message: "invalid JSON" }] };
  }
}

/**
 * TASK-019 pipeline: unknown frame data -> safe JSON parsing -> runtime schema
 * validation -> discriminated union -> handler. Never throws: malformed data
 * yields the failure branch, which the connection layer turns into a
 * structured protocol error without crashing the process.
 */
export function parseWsMessage(raw: unknown): ParseResult<WsInboundMessage> {
  const decoded = decodeJson(raw);
  if (!decoded.ok) {
    return { ok: false, issues: decoded.issues };
  }
  const parsed = inboundMessageSchema.safeParse(decoded.data);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  return validationFailure(parsed.error);
}
