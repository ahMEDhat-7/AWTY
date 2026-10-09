/**
 * TASK-046 — the connection port shared by both managers: the minimal
 * surface they rely on, so the managers stay testable with plain fakes and
 * are never coupled to the `ws` package.
 */
export interface WsPeer {
  send(data: string): void;
}

/**
 * TASK-046 — in-memory subscription manager (PRD §16):
 *
 *   Map(TaskId, Set<Connection>)
 *
 * In-memory only and never load-bearing for processing: PostgreSQL owns
 * durable state; this map only routes live updates to live sockets.
 */
export function createSubscriptionManager() {
  const subscriptions = new Map<string, Set<WsPeer>>();

  return {
    subscribe(taskId: string, peer: WsPeer): void {
      let peers = subscriptions.get(taskId);
      if (peers === undefined) {
        peers = new Set();
        subscriptions.set(taskId, peers);
      }
      peers.add(peer); // Set: a duplicate subscribe is a no-op
    },

    /** TASK-046: unsubscribe is supported even though the protocol barely needs it. */
    unsubscribe(taskId: string, peer: WsPeer): void {
      const peers = subscriptions.get(taskId);
      if (peers === undefined) {
        return;
      }
      peers.delete(peer);
      if (peers.size === 0) {
        subscriptions.delete(taskId); // no empty sets linger
      }
    },

    /** Snapshot copy — callers can never corrupt the manager's state. */
    getSubscribers(taskId: string): WsPeer[] {
      const peers = subscriptions.get(taskId);
      return peers === undefined ? [] : [...peers];
    },

    /** TASK-045: a dropped connection leaves every subscription set at once. */
    removeConnection(peer: WsPeer): void {
      for (const [taskId, peers] of subscriptions) {
        peers.delete(peer);
        if (peers.size === 0) {
          subscriptions.delete(taskId);
        }
      }
    },
  };
}

export type SubscriptionManager = ReturnType<typeof createSubscriptionManager>;
