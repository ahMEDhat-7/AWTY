import type { SubscriptionManager, WsPeer } from "./subscriptions.ts";

/**
 * Builds the in-memory connection manager.
 *
 * Tracks every live socket and owns the disconnect invariant: removing a
 * connection also removes it from all subscription sets, so no orphan
 * entries survive and nothing ever sends to a dead socket. Close/error
 * events are wired onto this by the gateway.
 *
 * @param subscriptions - the subscription manager scrubbed on removal
 * @returns the manager of add/remove/count
 */
export function createConnectionManager(subscriptions: SubscriptionManager) {
  const connections = new Set<WsPeer>();

  return {
    add(peer: WsPeer): void {
      connections.add(peer);
    },

    remove(peer: WsPeer): void {
      connections.delete(peer);
      subscriptions.removeConnection(peer);
    },

    count(): number {
      return connections.size;
    },
  };
}

export type ConnectionManager = ReturnType<typeof createConnectionManager>;
