/**
 * Shared Edge background scheduler for post-canonical P2 work.
 * Prefer EdgeRuntime.waitUntil so notify/audit finish after the Driver response.
 */

declare const EdgeRuntime:
  | { waitUntil?: (promise: Promise<unknown>) => void }
  | undefined;

/** Keep Edge isolate alive for P2 work after the Driver response is sent. */
export function scheduleEdgeBackground(
  task: () => Promise<unknown>,
  label: string,
): void {
  const run = () =>
    task().catch((error) => {
      console.warn(`[edge-background] ${label} failed:`, {
        message: error instanceof Error ? error.message : String(error),
      });
    });

  if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(run());
    return;
  }
  void run();
}
