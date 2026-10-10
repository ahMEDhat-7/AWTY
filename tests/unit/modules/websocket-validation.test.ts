import { describe, expect, it } from "vitest";
import { parseWsMessage } from "../../../src/modules/websocket/dto.ts";

const TASK_ID = "0b7f8f3e-1c2d-4a5b-9e8f-112233445566";

describe("websocket inbound validation", () => {
  it("parses a valid subscribe message into the typed protocol union", () => {
    const frame = JSON.stringify({ type: "subscribe", taskId: TASK_ID });
    expect(parseWsMessage(frame)).toEqual({
      ok: true,
      data: { type: "subscribe", taskId: TASK_ID },
    });
  });

  it("never throws on malformed or unexpected frame data", () => {
    const garbage: unknown[] = [
      "not json",
      "{",
      "",
      "null",
      "42",
      '"subscribe"',
      "{\"type\":\"subscribe\",",
      { type: "subscribe", taskId: TASK_ID },
      undefined,
      null,
      42,
      Buffer.from("{not json}"),
    ];
    for (const raw of garbage) {
      const label = typeof raw === "string" ? JSON.stringify(raw) : typeof raw;
      expect(() => parseWsMessage(raw), label).not.toThrow();
      expect(parseWsMessage(raw).ok, label).toBe(false);
    }
  });

  it("rejects structurally invalid subscribe messages", () => {
    const invalid = [
      JSON.stringify({ type: "subscribe" }),
      JSON.stringify({ type: "subscribe", taskId: "not-a-uuid" }),
      JSON.stringify({ type: "subscribe", taskId: "" }),
      JSON.stringify({ type: "unsubscribe", taskId: TASK_ID }),
      JSON.stringify({ type: "state", taskId: TASK_ID }),
      JSON.stringify({ taskId: TASK_ID }),
      JSON.stringify(["subscribe", TASK_ID]),
    ];
    for (const frame of invalid) {
      expect(parseWsMessage(frame).ok, frame).toBe(false);
    }
  });

  it("rejects values of the wrong JSON type", () => {
    const wrongTypes = [
      JSON.stringify({ type: 42, taskId: TASK_ID }),
      JSON.stringify({ type: "subscribe", taskId: 42 }),
      JSON.stringify({ type: "subscribe", taskId: true }),
      JSON.stringify({ type: "subscribe", taskId: { id: TASK_ID } }),
      JSON.stringify({ type: ["subscribe"], taskId: TASK_ID }),
    ];
    for (const frame of wrongTypes) {
      expect(parseWsMessage(frame).ok, frame).toBe(false);
    }
  });

  it("strips unknown fields from otherwise valid messages", () => {
    const frame = JSON.stringify({
      type: "subscribe",
      taskId: TASK_ID,
      junk: true,
    });
    expect(parseWsMessage(frame)).toEqual({
      ok: true,
      data: { type: "subscribe", taskId: TASK_ID },
    });
  });

  it("reports the failing path so the connection layer can reply", () => {
    const result = parseWsMessage(
      JSON.stringify({ type: "subscribe", taskId: "nope" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a validation failure");
    }
    expect(result.issues[0]?.path).toBe("taskId");
    expect(result.issues[0]?.message.length).toBeGreaterThan(0);
  });

  it("flags invalid JSON with a root-level issue", () => {
    const result = parseWsMessage("{broken");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a validation failure");
    }
    expect(result.issues[0]?.path).toBe("");
    expect(result.issues[0]?.message).toBe("invalid JSON");
  });
});
