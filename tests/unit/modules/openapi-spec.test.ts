import { describe, expect, it } from "vitest";
import { openApiDocument } from "../../../src/modules/openapi/spec.ts";

describe("OpenAPI specification", () => {
  it("is a well-formed OpenAPI 3.1 document", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(openApiDocument.info.title).toBe("AWTY API");
    expect(openApiDocument.info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("documents POST /tasks with its request body and every outcome", () => {
    expect(openApiDocument).toMatchObject({
      paths: {
        "/tasks": {
          post: {
            operationId: "createTask",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateTaskRequest" },
                },
              },
            },
            responses: {
              "201": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/CreateTaskResponse" },
                  },
                },
              },
              "400": {
                content: {
                  "application/json": {
                    schema: {
                      $ref: "#/components/schemas/ValidationErrorResponse",
                    },
                  },
                },
              },
              "500": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/ErrorResponse" },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it("keeps the documented request schema identical to runtime validation", () => {
    // CreateTaskRequest is generated from createTaskBodySchema — the bounds
    // must stay in lockstep with what POST /tasks actually enforces.
    expect(openApiDocument).toMatchObject({
      components: {
        schemas: {
          CreateTaskRequest: {
            type: "object",
            properties: {
              duration: { type: "integer", minimum: 1, maximum: 300 },
              shouldFail: { type: "boolean" },
            },
            required: ["duration"],
          },
        },
      },
    });
  });

  it("documents the validation-error shape the API really returns", () => {
    expect(openApiDocument).toMatchObject({
      components: {
        schemas: {
          ValidationErrorResponse: {
            type: "object",
            properties: {
              issues: {
                type: "array",
                items: { $ref: "#/components/schemas/ValidationIssue" },
              },
            },
            required: ["error", "issues"],
          },
          ErrorResponse: {
            type: "object",
            properties: { error: { type: "string" } },
            required: ["error"],
          },
        },
      },
    });
  });

  it("documents GET /tasks/{id} with its path parameter and every outcome", () => {
    expect(openApiDocument).toMatchObject({
      paths: {
        "/tasks/{id}": {
          get: {
            operationId: "getTask",
            parameters: [
              {
                in: "path",
                name: "id",
                required: true,
                schema: { type: "string", format: "uuid" },
              },
            ],
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/TaskStateResponse" },
                  },
                },
              },
              "400": {
                content: {
                  "application/json": {
                    schema: {
                      $ref: "#/components/schemas/ValidationErrorResponse",
                    },
                  },
                },
              },
              "404": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/NotFoundResponse" },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it("keeps the documented task-state schema aligned with runtime bounds", () => {
    expect(openApiDocument).toMatchObject({
      components: {
        schemas: {
          TaskStateResponse: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              status: {
                type: "string",
                enum: ["pending", "processing", "completed", "failed"],
              },
              progress: { type: "integer", minimum: 0, maximum: 100 },
            },
            required: ["id", "status", "progress"],
          },
          NotFoundResponse: {
            type: "object",
            properties: { error: { const: "not_found" } },
            required: ["error"],
          },
        },
      },
    });
  });
});
