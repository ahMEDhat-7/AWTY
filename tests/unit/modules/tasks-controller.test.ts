import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTasksRouter,
  type CreateTaskHandler,
} from "../../../src/modules/tasks/controller.ts";
import type { CreateTaskResult } from "../../../src/modules/tasks/service.ts";
import { httpErrorHandler, notFoundHandler } from "../../../src/shared/errors.ts";

const TASK_ID = "0b7f8f3e-1c2d-4a5b-9e8f-112233445566";

function resolved(result: CreateTaskResult): CreateTaskHandler {
  return () => Promise.resolve(result);
}

let currentHandler: CreateTaskHandler = () =>
  Promise.reject(new Error("no handler set"));
let server: Server;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/tasks", createTasksRouter((body) => currentHandler(body)));
  app.use(notFoundHandler);
  app.use(httpErrorHandler);

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("POST /tasks controller (TASK-025)", () => {
  it("answers 201 with { id, status } immediately", async () => {
    currentHandler = resolved({
      ok: true,
      task: { id: "abc123", status: "pending" },
    });
    const response = await fetch(`${url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ duration: 10 }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "abc123", status: "pending" });
  });

  it("hands the raw body to the service untouched (DTO lives there)", async () => {
    let received: unknown;
    currentHandler = (body) => {
      received = body;
      return Promise.resolve({ ok: false, kind: "validation", issues: [] });
    };
    await fetch(`${url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ duration: 2, junk: "x" }),
    });
    expect(received).toEqual({ duration: 2, junk: "x" });
  });
});

describe("HTTP error mapping (TASK-026)", () => {
  it("maps validation failures to 400 with issues", async () => {
    currentHandler = resolved({
      ok: false,
      kind: "validation",
      issues: [{ path: "duration", message: "too big" }],
    });
    const response = await fetch(`${url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ duration: 9999 }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "validation_failed",
      issues: [{ path: "duration", message: "too big" }],
    });
  });

  it("maps malformed JSON to 400 without crashing", async () => {
    const response = await fetch(`${url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{duration: ",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      issues: { message: string }[];
    };
    expect(body.error).toBe("validation_failed");
    expect(body.issues[0]?.message).toBe("malformed JSON body");
  });

  it("maps unexpected failures to 500 without leaking internals", async () => {
    currentHandler = resolved({
      ok: false,
      kind: "unexpected",
      cause: new Error("secret db credentials in message"),
    });
    const response = await fetch(`${url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ duration: 10 }),
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "internal_error" });
    expect(text).not.toContain("secret");
    expect(text).not.toContain("stack");
  });

  it("answers 404 as JSON for unmatched routes", async () => {
    const response = await fetch(`${url}/tasks/${TASK_ID}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
