/**
 * TASK-037 — progress calculation (PRD §14):
 *
 *   progress = floor(elapsed / duration * 100), clamped to 0..100
 *
 * Elapsed time is the reliable basis — never the tick count alone. Values
 * outside the range (negative elapsed, elapsed beyond the duration) are
 * clamped so persisted progress can never violate the database CHECK on
 * `Task.progress`.
 */
export function calculateProgress(
  elapsedMs: number,
  durationSeconds: number,
): number {
  const percent = Math.floor((elapsedMs / (durationSeconds * 1000)) * 100);
  return Math.min(100, Math.max(0, percent));
}

/** One progress evaluation per simulated second (PRD §14). */
export const PROGRESS_TICK_MS = 1000;
