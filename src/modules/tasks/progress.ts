/**
 * Computes task progress from elapsed time:
 *
 *   progress = floor(elapsed / duration * 100), clamped to 0..100
 *
 * Elapsed time is the reliable basis — never the tick count alone. Values
 * outside the range (negative elapsed, elapsed beyond the duration) are
 * clamped so persisted progress can never violate the database CHECK on
 * `Task.progress`.
 *
 * @param elapsedMs - milliseconds elapsed since the run started
 * @param durationSeconds - the task's declared duration in seconds
 * @returns the progress percentage, always within 0..100
 */
export function calculateProgress(
  elapsedMs: number,
  durationSeconds: number,
): number {
  const percent = Math.floor((elapsedMs / (durationSeconds * 1000)) * 100);
  return Math.min(100, Math.max(0, percent));
}

/** One progress evaluation per simulated second. */
export const PROGRESS_TICK_MS = 1000;
