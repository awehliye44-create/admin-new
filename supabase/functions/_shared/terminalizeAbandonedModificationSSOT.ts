/**
 * #92G — Bound abandoned trip-modification payment_pending after completion.
 *
 * Never applies the modification. Preserves rejection_reason / payment evidence.
 * Used when capture/completion runs with an unapplied fare-increase TCR still pending.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

const ABANDONABLE = new Set([
  "payment_pending",
  "payment_required",
]);

export async function terminalizeAbandonedTripChangeRequests(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    reason?: string;
    nowIso?: string;
  },
): Promise<{ terminalized: number }> {
  const tripId = String(args.tripId).trim();
  if (!tripId) return { terminalized: 0 };
  const nowIso = args.nowIso ?? new Date().toISOString();
  const reason = args.reason ?? "abandoned_unapplied_at_trip_completion";

  const { data: rows } = await supabase
    .from("trip_change_requests")
    .select("id, status, rejection_reason, payment_status")
    .eq("trip_id", tripId)
    .in("status", [...ABANDONABLE]);

  let terminalized = 0;
  for (const row of rows ?? []) {
    const priorReason = String(row.rejection_reason ?? "").trim();
    const { error } = await supabase
      .from("trip_change_requests")
      .update({
        status: "expired",
        payment_status: "failed",
        rejection_reason: priorReason || reason,
        responded_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", row.id)
      .in("status", [...ABANDONABLE]);
    if (!error) terminalized += 1;
  }
  return { terminalized };
}
