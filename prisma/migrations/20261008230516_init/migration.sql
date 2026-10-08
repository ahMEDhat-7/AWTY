-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "duration" INTEGER NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraints (TASK-012: duration 1..300 seconds, progress 0..100)
ALTER TABLE "Task" ADD CONSTRAINT "Task_duration_range" CHECK ("duration" >= 1 AND "duration" <= 300);
ALTER TABLE "Task" ADD CONSTRAINT "Task_progress_range" CHECK ("progress" >= 0 AND "progress" <= 100);
