import { z } from "zod";
import { createDocument } from "zod-openapi";
import { uuidSchema } from "../../lib/validation.ts";
import { createTaskBodySchema } from "../tasks/dto.ts";
import { TASK_STATUSES } from "../tasks/types.ts";

/**
 * TASK-027/029 — OpenAPI 3.1 document generated from the SAME zod schemas
 * used for runtime validation. This module never re-describes validation
 * rules; it only registers paths and response shapes.
 */

const createTaskResponseSchema = z
  .object({
    id: uuidSchema,
    status: z.enum(TASK_STATUSES),
  })
  .meta({
    id: "CreateTaskResponse",
    description: "The freshly created task. Processing starts asynchronously.",
    example: {
      id: "0b7f8f3e-1c2d-4a5b-9e8f-112233445566",
      status: "pending",
    },
  });

const validationIssueSchema = z
  .object({
    path: z
      .string()
      .meta({ description: "Field path that failed; empty for body-level errors." }),
    message: z.string().meta({ description: "Human-readable validation message." }),
  })
  .meta({ id: "ValidationIssue" });

const validationErrorResponseSchema = z
  .object({
    error: z.literal("validation_failed"),
    issues: z.array(validationIssueSchema),
  })
  .meta({
    id: "ValidationErrorResponse",
    description: "Returned for every 400 response.",
  });

const errorResponseSchema = z
  .object({
    error: z
      .string()
      .meta({ description: "Stable error code, e.g. internal_error or not_found." }),
  })
  .meta({
    id: "ErrorResponse",
    description:
      "Generic error envelope. Internal details and stack traces are never included.",
  });

export const openApiDocument = createDocument({
  openapi: "3.1.0",
  info: {
    title: "AWTY API",
    version: "0.1.0",
    description:
      "Real-time asynchronous task-processing API. Create a task, then follow its progress via GET /tasks/:id or the WebSocket endpoint at /ws.",
  },
  paths: {
    "/tasks": {
      post: {
        operationId: "createTask",
        summary: "Create a task",
        description:
          "Validates the request, persists a pending task and enqueues its job in one transaction. Returns immediately — it never waits for processing.",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: createTaskBodySchema },
          },
        },
        responses: {
          "201": {
            description: "Task created and queued.",
            content: {
              "application/json": { schema: createTaskResponseSchema },
            },
          },
          "400": {
            description:
              "Validation error — the issues array lists the failing fields. Malformed JSON is reported the same way.",
            content: {
              "application/json": { schema: validationErrorResponseSchema },
            },
          },
          "500": {
            description:
              "Unexpected server error. No internal details are exposed.",
            content: {
              "application/json": { schema: errorResponseSchema },
            },
          },
        },
      },
    },
  },
});
