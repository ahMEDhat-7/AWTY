import { describe, expect, it } from "vitest";
import {
  createMessageHandler,
  type FindTaskSnapshot,
} from "../../../src/modules/websocket/handler.ts";
import { createSubscriptionManager } from "../../../src/modules/websocket/subscriptions.ts";

const KNOWN = "11111111-1111-4111-8111-111111111111";
const MISSING = "22222222-2222-4222-8222-222222222222";

function makePeer(): { peer: { send(data: string): void }; sent: string[] } {
  const sent: string[] = [];
  return { peer: { send: (data) => void sent.push(data) }, sent };
}

function parseSent(sent: string[]): Record<string, unknown>[] {
  return sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

function setup(findTask?: FindTaskSnapshot) {
  const subscriptions = createSubscriptionManager();
  const handler = createMessageHandler({
    subscriptions,
    findTask:
      findTask ??
      (() => Promise.resolve({ id: KNOWN, status: "processing", progress: 40 })),
  });
  return { subscriptions, handler };
}

describe("websocket message handler", () => {
  it("registers the subscription and answers subscribe with a state sync message", async () => {
    const { subscriptions, handler } = setup();
    const { peer, sent } = makePeer();

    await handler(peer, JSON.stringify({ type: "subscribe", taskId: KNOWN }));

    expect(subscriptions.getSubscribers(KNOWN)).toEqual([peer]);
    expect(parseSent(sent)).toEqual([
      { type: "state", taskId: KNOWN, status: "processing", progress: 40 },
    ]);
  });

  it("registers before reading, so a subscribe never misses a concurrent update", async () => {
    let subscribersDuringRead = -1;
    const subscriptions = createSubscriptionManager();
    const handler = createMessageHandler({
      subscriptions,
      findTask: () => {
        subscribersDuringRead = subscriptions.getSubscribers(KNOWN).length;
        return Promise.resolve({ id: KNOWN, status: "pending", progress: 0 });
      },
    });

    await handler(makePeer().peer, JSON.stringify({ type: "subscribe", taskId: KNOWN }));

    expect(subscribersDuringRead).toBe(1);
  });

  it("answers an unknown task with not_found and does not keep the registration", async () => {
    const { subscriptions, handler } = setup((taskId) =>
      Promise.resolve(taskId === MISSING ? null : { id: KNOWN, status: "processing", progress: 40 }),
    );
    const { peer, sent } = makePeer();

    await handler(peer, JSON.stringify({ type: "subscribe", taskId: MISSING }));

    expect(parseSent(sent)).toEqual([{ type: "error", error: "not_found" }]);
    expect(subscriptions.getSubscribers(MISSING)).toEqual([]);
  });

  it("answers malformed JSON with a validation_failed protocol error", async () => {
    const { handler } = setup();
    const { peer, sent } = makePeer();

    await handler(peer, "{broken json");

    const [message] = parseSent(sent);
    expect(message?.["type"]).toBe("error");
    expect(message?.["error"]).toBe("validation_failed");
    expect(message?.["issues"]).toEqual([{ path: "", message: "invalid JSON" }]);
  });

  it("answers schema violations with a validation_failed protocol error", async () => {
    const { subscriptions, handler } = setup();
    const { peer, sent } = makePeer();

    await handler(peer, JSON.stringify({ type: "subscribe", taskId: "not-a-uuid" }));

    const [message] = parseSent(sent);
    expect(message?.["error"]).toBe("validation_failed");
    expect(Array.isArray(message?.["issues"])).toBe(true);
    expect(subscriptions.getSubscribers("not-a-uuid")).toEqual([]);
  });

  it("answers unknown message types with a validation_failed protocol error", async () => {
    const { handler } = setup();
    const { peer, sent } = makePeer();

    await handler(peer, JSON.stringify({ type: "unsubscribe-everything" }));

    const [message] = parseSent(sent);
    expect(message?.["error"]).toBe("validation_failed");
  });

  it("answers a snapshot read failure with internal_error and unsubscribes", async () => {
    const { subscriptions, handler } = setup(() =>
      Promise.reject(new Error("database gone")),
    );
    const { peer, sent } = makePeer();

    // Must resolve, not reject: a failing read is a reply, never a crash.
    await handler(peer, JSON.stringify({ type: "subscribe", taskId: KNOWN }));

    expect(parseSent(sent)).toEqual([{ type: "error", error: "internal_error" }]);
    expect(subscriptions.getSubscribers(KNOWN)).toEqual([]);
  });

  it("never rejects on arbitrary garbage frames", async () => {
    const { handler } = setup();
    const { peer } = makePeer();

    for (const frame of ["", "null", "[]", '"text"', '{"type":123}', "{}"]) {
      await expect(handler(peer, frame)).resolves.toBeUndefined();
    }
  });
});
