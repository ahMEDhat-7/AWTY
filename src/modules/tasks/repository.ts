import type { PrismaClient, Task } from "../../generated/prisma/client.ts";

/**
 * Builds the task repository over a Prisma task delegate.
 *
 * Every mutating method except `create` is guarded by the current status:
 * the UPDATE only matches rows still in the expected source state, so
 * stale or duplicate worker executions cannot perform arbitrary
 * transitions — the guard lives in the database, not only in the domain
 * layer.
 *
 * @param db - the task delegate owner: accepts both the root client and
 *             `Prisma.TransactionClient`, so services/tests choose the wiring
 * @returns the repository of guarded task queries; no singleton is imported
 */
export function createTaskRepository(db: Pick<PrismaClient, "task">) {
  return {
    /**
     * Inserts a new task.
     *
     * @param input - `{ duration }` in seconds
     * @returns the created task; schema defaults give `pending`/0%
     */
    async create(input: { duration: number }): Promise<Task> {
      return db.task.create({ data: { duration: input.duration } });
    },

    /**
     * Reads one task by id.
     *
     * @param id - the task's UUID
     * @returns the task, or `null` when no row matches
     */
    async findById(id: string): Promise<Task | null> {
      return db.task.findUnique({ where: { id } });
    },

    /**
     * Performs the guarded `pending → processing` claim.
     *
     * @param id - the task's UUID
     * @returns the claimed task, or `null` when the task is not pending
     */
    async markProcessing(id: string): Promise<Task | null> {
      const result = await db.task.updateMany({
        where: { id, status: "pending" },
        data: { status: "processing", startedAt: new Date() },
      });
      return result.count > 0 ? db.task.findUnique({ where: { id } }) : null;
    },

    /**
     * Performs the guarded crash-recovery restart: a redelivered job whose
     * task is still `processing` belongs to an attempt whose worker died
     * mid-run (pg-boss only redelivers after the owning worker's heartbeat
     * has died). Restarts the simulation from 0% rather than stranding the
     * task. The guard requires `status = processing`, so a terminal task is
     * never resurrected and a concurrent duplicate finds the same
     * single-shot UPDATE.
     *
     * @param id - the task's UUID
     * @returns the restarted task, or `null` when it is not `processing`
     */
    async restartProcessing(id: string): Promise<Task | null> {
      const result = await db.task.updateMany({
        where: { id, status: "processing" },
        data: { progress: 0, startedAt: new Date() },
      });
      return result.count > 0 ? db.task.findUnique({ where: { id } }) : null;
    },

    /**
     * Persists progress through the guarded `processing` write, which the
     * database trigger turns into a `task_updates` notification.
     *
     * @param id - the task's UUID
     * @param progress - the new percentage
     * @returns the updated task, or `null` when it is not `processing`
     */
    async updateProgress(id: string, progress: number): Promise<Task | null> {
      const result = await db.task.updateMany({
        where: { id, status: "processing" },
        data: { progress },
      });
      return result.count > 0 ? db.task.findUnique({ where: { id } }) : null;
    },

    /**
     * Performs the guarded `processing → completed` transition.
     *
     * @param id - the task's UUID
     * @returns the updated task, or `null` when it is not `processing`
     */
    async markCompleted(id: string): Promise<Task | null> {
      const result = await db.task.updateMany({
        where: { id, status: "processing" },
        data: { status: "completed", progress: 100, completedAt: new Date() },
      });
      return result.count > 0 ? db.task.findUnique({ where: { id } }) : null;
    },

    /**
     * Performs the guarded `processing → failed` transition; the progress
     * reached at failure time is preserved.
     *
     * @param id - the task's UUID
     * @returns the updated task, or `null` when it is not `processing`
     */
    async markFailed(id: string): Promise<Task | null> {
      const result = await db.task.updateMany({
        where: { id, status: "processing" },
        data: { status: "failed", failedAt: new Date() },
      });
      return result.count > 0 ? db.task.findUnique({ where: { id } }) : null;
    },
  };
}

export type TaskRepository = ReturnType<typeof createTaskRepository>;
