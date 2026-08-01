/** Best-effort hold lifecycle telemetry (no-op if sink unavailable). */
export async function emitHoldTelemetry(
  _supabase: unknown,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    console.log("[holdTelemetry]", event, JSON.stringify(payload));
  } catch {
    // never throw from telemetry
  }
}
