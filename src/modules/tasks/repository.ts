import type { PrismaClient, Task } from "../../generated/prisma/client.ts";

/**
 * Task repository (TASK-021/022).
 *
 * Every mutating method except `create` is guarded by the current status: the
 * UPDATE only matches rows still in the expected source state, so stale or
 * duplicate worker executions cannot perform arbitrary transitions — the
 * guard lives in the database, not only in the domain layer.
 *
 * The factory takes the client as an argument so services/tests choose the
 * wiring; no singleton is imported here (composition happens in the app).
 */
export function createTaskRepository(db: PrismaClient) {
  return {
    /** Insert a new task; schema defaults give pending/0%. */
    async create(input: { duration: number }): Promise<Task> {
      return db.task.create({ data: { duration: input.duration } });
    },

    async findById(id: string): Promise<Task | null> {
      return db.task.findUnique({ where: { id } });
    },

    /** pending -> processing. Null when the task is not pending. */
    async markProcessing(id: string): Promise<Task | null> {
      const result = await db.task.updateMany({
        where: { id, status: "pending" },
        data: { status: "processing", startedAt: new Date() },
      });
      return result.count > 0 ? db.task.findUnique({ where: { id } }) : null;
    },

    /** Progress is only persisted while processing. Null otherwise. */
    async updateProgress(id: string, progress: number): Promise<Task | null> {
      const result = await db.task.updateMany({
        where: { id, status: "processing" },
        data: { progress },
      });
      return result.count > 0 ? db.task.findUnique({ where: { id } }) : null;
    },

    /** processing -> completed; forces progress to 100 (domain invariant). */
    async markCompleted(id: string): Promise<Task | null> {
      const result = await db.task.updateMany({
        where: { id, status: "processing" },
        data: { status: "completed", progress: 100, completedAt: new Date() },
      });
      return result.count > 0 ? db.task.findUnique({ where: { id } }) : null;
    },

    /** processing -> failed; failed progress is preserved (PRD decision). */
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
