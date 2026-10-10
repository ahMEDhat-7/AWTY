import { describe, expect, it } from "vitest";
import {
  createSubscriptionManager,
  type WsPeer,
} from "../../../src/modules/websocket/subscriptions.ts";

function makePeer(): { peer: WsPeer; sent: string[] } {
  const sent: string[] = [];
  return { peer: { send: (data) => void sent.push(data) }, sent };
}

describe("subscription manager", () => {
  it("registers subscribers per task", () => {
    const manager = createSubscriptionManager();
    const { peer } = makePeer();

    manager.subscribe("task-a", peer);

    expect(manager.getSubscribers("task-a")).toEqual([peer]);
  });

  it("deduplicates repeated subscribes and tracks tasks independently", () => {
    const manager = createSubscriptionManager();
    const { peer: one } = makePeer();
    const { peer: two } = makePeer();

    manager.subscribe("task-a", one);
    manager.subscribe("task-a", one);
    manager.subscribe("task-a", two);
    manager.subscribe("task-b", one);

    expect(manager.getSubscribers("task-a")).toHaveLength(2);
    expect(manager.getSubscribers("task-b")).toEqual([one]);
  });

  it("unsubscribes and drops empty task sets", () => {
    const manager = createSubscriptionManager();
    const { peer } = makePeer();

    manager.subscribe("task-a", peer);
    manager.unsubscribe("task-a", peer);

    expect(manager.getSubscribers("task-a")).toEqual([]);
  });

  it("ignores unsubscribes for unknown tasks or peers", () => {
    const manager = createSubscriptionManager();
    const { peer } = makePeer();

    expect(() => manager.unsubscribe("missing", peer)).not.toThrow();
    manager.subscribe("task-a", makePeer().peer);
    expect(() => manager.unsubscribe("task-a", peer)).not.toThrow();
  });

  it("returns a snapshot copy callers cannot corrupt", () => {
    const manager = createSubscriptionManager();
    const { peer } = makePeer();
    manager.subscribe("task-a", peer);

    manager.getSubscribers("task-a").length = 0;

    expect(manager.getSubscribers("task-a")).toEqual([peer]);
  });

  it("returns no subscribers for a task nobody is watching", () => {
    const manager = createSubscriptionManager();
    const { peer } = makePeer();
    manager.subscribe("task-a", peer);

    expect(manager.getSubscribers("never-seen")).toEqual([]);
    expect(manager.getSubscribers("task-b")).toEqual([]);
  });

  it("removes a connection from every task set at once (disconnect cleanup)", () => {
    const manager = createSubscriptionManager();
    const { peer: leaving } = makePeer();
    const { peer: staying } = makePeer();
    manager.subscribe("task-a", leaving);
    manager.subscribe("task-b", leaving);
    manager.subscribe("task-a", staying);

    manager.removeConnection(leaving);

    expect(manager.getSubscribers("task-a")).toEqual([staying]);
    expect(manager.getSubscribers("task-b")).toEqual([]);
  });
});
