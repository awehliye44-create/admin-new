/**
 * Reliable deferred Edge notify/broadcast after authoritative commit.
 * Uses EdgeRuntime.waitUntil (via scheduleEdgeBackground) — not bare fire-and-forget.
 * Retries with backoff; callers must keep tasks idempotent.
 */

import { scheduleEdgeBackground } from "./scheduleEdgeBackground.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function scheduleReliableEdgeNotify(
  label: string,
  task: () => Promise<unknown>,
  options?: { attempts?: number; baseDelayMs?: number },
): void {
  const attempts = Math.max(1, Math.min(5, options?.attempts ?? 3));
  const baseDelayMs = Math.max(50, options?.baseDelayMs ?? 200);

  scheduleEdgeBackground(async () => {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await task();
        if (attempt > 1) {
          console.log(`[edge-notify] ${label} succeeded on retry`, { attempt });
        }
        return;
      } catch (error) {
        lastError = error;
        console.warn(`[edge-notify] ${label} attempt ${attempt}/${attempts} failed:`, {
          message: error instanceof Error ? error.message : String(error),
        });
        if (attempt < attempts) {
          await sleep(baseDelayMs * 2 ** (attempt - 1));
        }
      }
    }
    console.error(`[edge-notify] ${label} exhausted retries`, {
      message: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }, label);
}
