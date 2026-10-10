/**
 * The connection port shared by both managers: the minimal surface they
 * rely on, so the managers stay testable with plain fakes and are never
 * coupled to the `ws` package.
 */
export interface WsPeer {
  send(data: string): void;
}

/**
 * Builds the in-memory subscription manager:
 *
 *   Map(TaskId, Set<Connection>)
 *
 * In-memory only and never load-bearing for processing: PostgreSQL owns
 * durable state; this map only routes live updates to live sockets.
 *
 * @returns the manager of subscribe/unsubscribe/getSubscribers/removeConnection
 */
export function createSubscriptionManager() {
  const subscriptions = new Map<string, Set<WsPeer>>();

  return {
    /**
     * Registers a peer for a task's updates.
     *
     * @param taskId - the task's UUID
     * @param peer - the subscriber socket (a duplicate subscribe is a no-op)
     * @returns nothing
     */
    subscribe(taskId: string, peer: WsPeer): void {
      let peers = subscriptions.get(taskId);
      if (peers === undefined) {
        peers = new Set();
        subscriptions.set(taskId, peers);
      }
      peers.add(peer);
    },

    /**
     * Drops one peer's registration for a task. Supported even though the
     * protocol barely needs it.
     *
     * @param taskId - the task's UUID
     * @param peer - the peer to unsubscribe
     * @returns nothing; empty subscription sets are deleted
     */
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

    /**
     * Reads the current subscribers of a task.
     *
     * @param taskId - the task's UUID
     * @returns a snapshot copy — callers can never corrupt the manager's state
     */
    getSubscribers(taskId: string): WsPeer[] {
      const peers = subscriptions.get(taskId);
      return peers === undefined ? [] : [...peers];
    },

    /**
     * Removes a dropped connection from every subscription set at once.
     *
     * @param peer - the connection that closed
     * @returns nothing
     */
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
