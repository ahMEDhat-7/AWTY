import { openApiDocument } from "../src/modules/openapi/spec.ts";

/**
 * CI check (TASK-029): the OpenAPI document must be 3.1, must document
 * POST /tasks, and must cover every outcome the API implements.
 */
function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.error(`openapi:check failed — ${message}`);
    process.exit(1);
  }
}

const paths = openApiDocument.paths ?? {};
const post = paths["/tasks"]?.post;

assert(openApiDocument.openapi === "3.1.0", "document must declare OpenAPI 3.1.0");
assert(openApiDocument.info.title.length > 0, "info.title is required");
assert(post !== undefined, "POST /tasks must be documented");
assert(post?.requestBody !== undefined, "POST /tasks must document its request body");
assert(post?.responses?.["201"] !== undefined, "201 response must be documented");
assert(post?.responses?.["400"] !== undefined, "400 response must be documented");
assert(post?.responses?.["500"] !== undefined, "500 response must be documented");

console.log("openapi:check passed — OpenAPI 3.1 document covers POST /tasks");
