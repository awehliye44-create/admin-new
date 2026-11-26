/**
 * #108 — repair trips.payment_status from provider-confirmed capture evidence
 * already stored on the trip and its RIDE_BOOKING payment session.
 * No capture, increment, refund, or other provider call.
 */
import type { AnySupabaseClient } from "./supabaseClientTypes.ts";

export type ConfirmedCapturePaymentStatusReconcile = {
  updated: number;
  trip_ids: string[];
  dry_run: boolean;
};

export async function reconcileConfirmedCapturePaymentStatus(
  supabase: AnySupabaseClient,
  args: { limit: number; dryRun: boolean },
): Promise<ConfirmedCapturePaymentStatusReconcile> {
  const limit = Math.min(100, Math.max(1, Math.round(args.limit)));
  const { data, error } = await supabase.rpc("reconcile_confirmed_capture_payment_status", {
    p_limit: limit,
    p_dry_run: args.dryRun === true,
  });
  if (error) {
    throw new Error(error.message);
  }
  const row = (data ?? {}) as { updated?: number; trip_ids?: string[]; dry_run?: boolean };
  return {
    updated: Number(row.updated ?? 0),
    trip_ids: Array.isArray(row.trip_ids) ? row.trip_ids.map(String) : [],
    dry_run: row.dry_run === true || args.dryRun === true,
  };
}
