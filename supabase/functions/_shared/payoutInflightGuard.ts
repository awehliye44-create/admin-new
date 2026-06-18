import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const IN_FLIGHT_STATUSES = new Set(["pending", "processing", "ledger_sync_failed"]);

/** Blocks duplicate manual/weekly payouts while an item is still in flight. */
export async function findInFlightPayoutItem(
  supabase: SupabaseClient,
  driverId: string,
  excludeItemId?: string,
): Promise<{ id: string; status: string; amount_pence: number } | null> {
  let query = supabase
    .from("payout_items")
    .select("id, status, amount_pence, settlement_status, stripe_transfer_id")
    .eq("driver_id", driverId)
    .in("status", [...IN_FLIGHT_STATUSES])
    .order("created_at", { ascending: false })
    .limit(5);

  if (excludeItemId) {
    query = query.neq("id", excludeItemId);
  }

  const { data: rows } = await query;
  for (const row of rows ?? []) {
    if (row.status === "ledger_sync_failed") {
      return row;
    }
    const settlement = String(row.settlement_status ?? "").toUpperCase();
    if (settlement !== "COMPLETE" && settlement !== "FAILED" && !row.stripe_transfer_id) {
      return row;
    }
  }
  return null;
}
