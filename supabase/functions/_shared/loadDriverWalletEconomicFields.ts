/**
 * Load backend-resolved economic date fields via SQL RPC.
 * Does not join payment_sessions in TypeScript.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { BackendEconomicFields } from "./economicEarnedAtSSOT.ts";

export async function loadDriverWalletEconomicFields(
  supabase: SupabaseClient,
  driverId: string,
): Promise<Map<string, BackendEconomicFields>> {
  const map = new Map<string, BackendEconomicFields>();
  if (!driverId) return map;

  const { data, error } = await supabase.rpc("driver_wallet_ledger_economic_fields", {
    p_driver_id: driverId,
  });
  if (error || !Array.isArray(data)) return map;

  for (const raw of data) {
    const row = raw as Record<string, unknown>;
    const id = typeof row.ledger_entry_id === "string" ? row.ledger_entry_id : "";
    if (!id) continue;
    const status = typeof row.economic_date_status === "string" ? row.economic_date_status : null;
    map.set(id, {
      ledger_entry_id: id,
      related_trip_id: typeof row.related_trip_id === "string" ? row.related_trip_id : null,
      amount_pence: Number(row.amount_pence ?? 0),
      type: typeof row.type === "string" ? row.type : null,
      posting_created_at: typeof row.posting_created_at === "string" ? row.posting_created_at : null,
      economic_earned_at: typeof row.economic_earned_at === "string" ? row.economic_earned_at : null,
      economic_date_status: status,
      captured_at: status === "RESOLVED" && typeof row.captured_at === "string" ? row.captured_at : null,
      eligible_at: typeof row.eligible_at === "string" ? row.eligible_at : null,
      clearing_status: typeof row.clearing_status === "string" ? row.clearing_status : null,
    });
  }
  return map;
}

export function economicFieldsByLedgerOrTrip(
  fields: Map<string, BackendEconomicFields>,
  ledgerId: string | null | undefined,
  tripId: string | null | undefined,
): BackendEconomicFields | undefined {
  if (ledgerId && fields.has(ledgerId)) return fields.get(ledgerId);
  if (!tripId) return undefined;
  for (const row of fields.values()) {
    if (row.related_trip_id === tripId && String(row.type ?? "").toUpperCase() === "TRIP_EARNING_NET") {
      return row;
    }
  }
  return undefined;
}
