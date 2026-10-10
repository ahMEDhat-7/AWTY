import { openApiDocument } from "../src/modules/openapi/spec.ts";

/**
 * OpenAPI CI check: the document must be 3.1, must document POST /tasks,
 * and must cover every outcome the API implements.
 */

/**
 * Fails the check when a requirement does not hold.
 *
 * @param condition - the requirement to assert
 * @param message - the failure text printed to stderr
 * @returns nothing; exits the process with code 1 when the condition fails
 */
function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.error(`openapi:check failed — ${message}`);
    process.exit(1);
  }
}

const paths = openApiDocument.paths ?? {};
const post = paths["/tasks"]?.post;
const get = paths["/tasks/{id}"]?.get;

assert(openApiDocument.openapi === "3.1.0", "document must declare OpenAPI 3.1.0");
assert(openApiDocument.info.title.length > 0, "info.title is required");
assert(post !== undefined, "POST /tasks must be documented");
assert(post?.requestBody !== undefined, "POST /tasks must document its request body");
assert(post?.responses?.["201"] !== undefined, "201 response must be documented");
assert(post?.responses?.["400"] !== undefined, "400 response must be documented");
assert(post?.responses?.["500"] !== undefined, "500 response must be documented");
assert(get !== undefined, "GET /tasks/{id} must be documented");
assert(get?.responses?.["200"] !== undefined, "200 response must be documented for GET /tasks/{id}");
assert(get?.responses?.["400"] !== undefined, "400 response must be documented for GET /tasks/{id}");
assert(get?.responses?.["404"] !== undefined, "404 response must be documented for GET /tasks/{id}");

console.log("openapi:check passed — OpenAPI 3.1 document covers POST /tasks and GET /tasks/{id}");
