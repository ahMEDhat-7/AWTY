import { describe, expect, it } from "vitest";
import { createConnectionManager } from "../../../src/modules/websocket/connections.ts";
import { createSubscriptionManager } from "../../../src/modules/websocket/subscriptions.ts";

function makePeer() {
  return { send: (): void => undefined };
}

describe("connection manager (TASK-045)", () => {
  it("tracks live connections", () => {
    const manager = createConnectionManager(createSubscriptionManager());

    manager.add(makePeer());
    manager.add(makePeer());

    expect(manager.count()).toBe(2);
  });

  it("removes a connection on close and scrubs its subscriptions", () => {
    const subscriptions = createSubscriptionManager();
    const manager = createConnectionManager(subscriptions);
    const peer = makePeer();
    subscriptions.subscribe("task-a", peer);
    manager.add(peer);

    manager.remove(peer);

    expect(manager.count()).toBe(0);
    expect(subscriptions.getSubscribers("task-a")).toEqual([]);
  });

  it("ignores removal of an unknown connection", () => {
    const manager = createConnectionManager(createSubscriptionManager());

    expect(() => manager.remove(makePeer())).not.toThrow();
    expect(manager.count()).toBe(0);
  });
});
