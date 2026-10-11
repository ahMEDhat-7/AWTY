import { z } from "zod";
import { createDocument } from "zod-openapi";
import { uuidSchema } from "../../lib/validation.ts";
import { createTaskBodySchema } from "../tasks/dto.ts";
import { TASK_STATUSES } from "../tasks/types.ts";
import { subscribeMessageSchema } from "../websocket/dto.ts";

/**
 * OpenAPI 3.1 document generated from the SAME zod schemas used for
 * runtime validation. This module never re-describes validation rules;
 * it only registers paths and response shapes.
 *
 * OpenAPI cannot describe a WebSocket as an executable operation, so
 * `/ws` is registered as documentation only: the protocol, its frames,
 * and their schemas. The inbound `subscribe` frame reuses the runtime
 * schema; the outbound frame schemas mirror the TypeScript union the
 * gateway sends (frames are built by the server, never validated).
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

const notFoundResponseSchema = z
  .object({ error: z.literal("not_found") })
  .meta({
    id: "NotFoundResponse",
    description: "No task exists with the requested id.",
  });

const taskStateResponseSchema = z
  .object({
    id: uuidSchema,
    status: z.enum(TASK_STATUSES),
    progress: z.number().int().min(0).max(100),
  })
  .meta({
    id: "TaskStateResponse",
    description:
      "Current task state. PostgreSQL is authoritative — poll until status is completed (progress 100) or failed.",
    example: {
      id: "0b7f8f3e-1c2d-4a5b-9e8f-112233445566",
      status: "processing",
      progress: 50,
    },
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

/**
 * WebSocket frame schemas: documentation mirrors of the protocol the
 * gateway speaks. `SubscribeMessage` is the runtime validation schema
 * itself; the outbound frames mirror the `WsOutboundMessage` union —
 * the server builds them, so nothing validates them at runtime.
 */

const subscribeFrameSchema = subscribeMessageSchema.meta({
  id: "SubscribeMessage",
  description:
    "Client → server frame: register this socket for one task's updates. Exactly one subscribe per socket is meaningful; a duplicate is a no-op.",
  example: {
    type: "subscribe",
    taskId: "0b7f8f3e-1c2d-4a5b-9e8f-112233445566",
  },
});

const taskUpdateFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    taskId: uuidSchema,
    progress: z.number().int().min(0).max(100),
  }),
  z.object({ type: z.literal("completed"), taskId: uuidSchema }),
  z.object({ type: z.literal("failed"), taskId: uuidSchema }),
  z.object({
    type: z.literal("state"),
    taskId: uuidSchema,
    status: z.enum(TASK_STATUSES),
    progress: z.number().int().min(0).max(100),
  }),
]).meta({
  id: "TaskUpdate",
  description:
    "Server → client task-addressed frames. `state` is the synchronization frame sent in reply to a subscribe; `progress` follows while the task runs; exactly one terminal frame (`completed` or `failed`) ends the sequence. After a terminal frame no further updates are sent for that task.",
  example: { type: "progress", taskId: "0b7f8f3e-1c2d-4a5b-9e8f-112233445566", progress: 40 },
});

const protocolErrorFrameSchema = z.discriminatedUnion("error", [
  z.object({
    type: z.literal("error"),
    error: z.literal("validation_failed"),
    issues: z.array(validationIssueSchema),
  }),
  z.object({ type: z.literal("error"), error: z.literal("not_found") }),
  z.object({ type: z.literal("error"), error: z.literal("internal_error") }),
]).meta({
  id: "ProtocolError",
  description:
    "Server → client error frames (always with `type: \"error\"`). Malformed input is answered as a value, never by closing the socket: `validation_failed` for an unparseable frame, `not_found` for a subscribe to an unknown task, `internal_error` for a failed state read. Mirrors the REST error contract.",
  example: { type: "error", error: "not_found" },
});

/**
 * Every frame exchanged over the socket, in either direction. Unnamed on
 * purpose: it inlines as a `oneOf` referencing the three id'd schemas, so
 * Swagger UI lists exactly `SubscribeMessage`, `TaskUpdate`, and
 * `ProtocolError` in components.
 */
const wsFramesSchema = z.union([
  subscribeFrameSchema,
  taskUpdateFrameSchema,
  protocolErrorFrameSchema,
]);

export const openApiDocument = createDocument({
  openapi: "3.1.0",
  info: {
    title: "AWTY API",
    version: "0.1.0",
    description:
      "Real-time asynchronous task-processing API. Create a task, then follow its progress via GET /tasks/:id or the WebSocket endpoint at /ws.",
  },
  paths: {
    "/ws": {
      get: {
        operationId: "subscribeToTaskUpdates",
        summary: "Subscribe to task updates (WebSocket)",
        description: [
          "WebSocket endpoint. Connect to `ws://<host>/ws` with a WebSocket client — **not** the Swagger UI \"Try it out\" button, which issues a plain HTTP GET and receives a 404 (only an upgrade handshake speaks this protocol).",
          "",
          "**Protocol.** The server never sends unsolicited data. After connecting, send one text frame:",
          "",
          "`{\"type\":\"subscribe\",\"taskId\":\"<uuid>\"}` (schema: `SubscribeMessage`; the id comes from `POST /tasks`).",
          "",
          "The server then replies with:",
          "",
          "1. one `state` frame — the DB-authoritative synchronization snapshot (schema: `TaskUpdate`),",
          "2. zero or more `progress` frames while the task runs,",
          "3. exactly one terminal frame — `completed` or `failed` (also in `TaskUpdate`).",
          "",
          "After the terminal frame no further updates are sent for that task.",
          "",
          "**Errors** arrive as frames, never as disconnects (schema: `ProtocolError`): `validation_failed` for a malformed subscribe, `not_found` for an unknown task id, `internal_error` for a failed state read.",
          "",
          "**Multiple subscribers:** every socket subscribed to the same task receives all of its updates.",
          "",
          "**Reconnection:** processing continues whether or not any client is connected (worker-side). After reconnecting, send `subscribe` again — the fresh `state` frame is the current truth, so a client can never be stuck on a stale state.",
        ].join("\n"),
        responses: {
          "101": {
            description:
              "Switching Protocols — the connection continues as a WebSocket speaking the frames documented above.",
            content: {
              "application/json": { schema: wsFramesSchema },
            },
          },
          "404": {
            description:
              "A plain HTTP GET (no upgrade handshake) reaches the API's not-found handler.",
            content: {
              "application/json": { schema: notFoundResponseSchema },
            },
          },
        },
      },
    },
    "/tasks/{id}": {
      get: {
        operationId: "getTask",
        summary: "Read a task",
        description:
          "Reads the current task state from PostgreSQL. Poll until status is completed (progress 100) or failed.",
        requestParams: {
          path: z.object({
            id: uuidSchema.meta({
              description: "Task id (UUID) returned by POST /tasks.",
              example: "0b7f8f3e-1c2d-4a5b-9e8f-112233445566",
            }),
          }),
        },
        responses: {
          "200": {
            description: "Current task state.",
            content: {
              "application/json": { schema: taskStateResponseSchema },
            },
          },
          "400": {
            description: "Malformed task id — reported as a validation error.",
            content: {
              "application/json": { schema: validationErrorResponseSchema },
            },
          },
          "404": {
            description: "No task with this id.",
            content: {
              "application/json": { schema: notFoundResponseSchema },
            },
          },
        },
      },
    },
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
