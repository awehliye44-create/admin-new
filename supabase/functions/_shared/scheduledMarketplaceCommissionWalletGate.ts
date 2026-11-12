/**
 * Scheduled marketplace — commission wallet gate (parity with instant dispatch).
 *
 * Instant: rideOfferDriverEligibility.ts → driver_passes_commission_wallet_dispatch_gate(driver, trip).
 * Scheduled marketplace (get_available + accept) and Admin assign_now must use the SAME RPC.
 *
 * - Trip-scoped: only DRIVER_COLLECTED_COMMISSION_WALLET trips are gated; other models return true.
 * - Fail closed on RPC error (never list / accept when the gate cannot be evaluated).
 * - SQL backstop: accept_scheduled_ride (migration 20270218120000) re-checks the same RPC.
 */

export const SCHEDULED_COMMISSION_WALLET_ERROR = "INSUFFICIENT_COMMISSION_WALLET_BALANCE";
export const SCHEDULED_COMMISSION_WALLET_MESSAGE =
  "Your commission wallet balance is too low to take this booking. Top up your wallet and try again.";

export type ScheduledCommissionWalletGateResult =
  | { ok: true }
  | { ok: false; reason: "wallet_ineligible" | "wallet_gate_error"; detail?: string };

export async function checkScheduledCommissionWalletGate(
  supabase: any,
  driverId: string,
  tripId: string,
): Promise<ScheduledCommissionWalletGateResult> {
  const { data, error } = await supabase.rpc(
    "driver_passes_commission_wallet_dispatch_gate",
    { p_driver_id: driverId, p_trip_id: tripId },
  );
  if (error) {
    return { ok: false, reason: "wallet_gate_error", detail: String(error.message ?? error) };
  }
  if (data !== true) {
    return { ok: false, reason: "wallet_ineligible" };
  }
  return { ok: true };
}

/** Marketplace listing filter — keeps only trips the driver's wallet may cover. */
export async function filterTripsByScheduledCommissionWalletGate<T extends { id: string }>(
  supabase: any,
  driverId: string,
  trips: T[],
): Promise<{ allowed: T[]; blockedTripIds: string[] }> {
  const allowed: T[] = [];
  const blockedTripIds: string[] = [];
  const results = await Promise.all(
    trips.map(async (trip) => ({
      trip,
      gate: await checkScheduledCommissionWalletGate(supabase, driverId, trip.id),
    })),
  );
  for (const { trip, gate } of results) {
    if (gate.ok) allowed.push(trip);
    else blockedTripIds.push(trip.id);
  }
  return { allowed, blockedTripIds };
}
