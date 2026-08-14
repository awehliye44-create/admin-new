/**
 * Company-balance composition inputs for transfer funding gates.
 * Matches admin-payout-ledger company_list loaders — never invent £0 on query failure.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export async function loadProtectedDriverLiabilityPence(
  supabase: SupabaseClient,
  service_area_id?: string | null,
): Promise<{ amount_pence: number | null; error_code: string | null }> {
  try {
    let driverQuery = supabase
      .from("drivers")
      .select("id")
      .limit(500);
    if (service_area_id) {
      const { data: links, error: linkErr } = await supabase
        .from("driver_service_areas")
        .select("driver_id")
        .eq("service_area_id", service_area_id);
      if (linkErr) {
        return { amount_pence: null, error_code: "DRIVER_LIABILITY_QUERY_FAILED" };
      }
      const ids = [...new Set((links ?? []).map((r) => String(r.driver_id)).filter(Boolean))];
      if (ids.length === 0) return { amount_pence: 0, error_code: null };
      driverQuery = driverQuery.in("id", ids);
    }
    const { data: drivers, error } = await driverQuery;
    if (error) {
      return { amount_pence: null, error_code: "DRIVER_LIABILITY_QUERY_FAILED" };
    }
    const driverIds = (drivers ?? []).map((d) => String(d.id)).filter(Boolean);
    if (driverIds.length === 0) return { amount_pence: 0, error_code: null };

    const { data: ledgerRows, error: ledgerErr } = await supabase
      .from("driver_wallet_ledger")
      .select("driver_id, type, amount_pence")
      .in("driver_id", driverIds);
    if (ledgerErr) {
      return { amount_pence: null, error_code: "DRIVER_LIABILITY_QUERY_FAILED" };
    }

    const { computeLedgerWalletBalancePence } = await import("./onecabFinanceLedger.ts");
    const byDriver = new Map<string, Array<{ type?: string | null; amount_pence?: number | null }>>();
    for (const row of ledgerRows ?? []) {
      const id = String(row.driver_id ?? "");
      if (!id) continue;
      const list = byDriver.get(id) ?? [];
      list.push(row);
      byDriver.set(id, list);
    }
    let liveTotal = 0;
    for (const id of driverIds) {
      liveTotal += Math.max(0, computeLedgerWalletBalancePence(byDriver.get(id) ?? []));
    }
    return { amount_pence: liveTotal, error_code: null };
  } catch {
    return { amount_pence: null, error_code: "DRIVER_LIABILITY_QUERY_FAILED" };
  }
}

export async function loadReservedDriverPayoutPence(
  supabase: SupabaseClient,
  service_area_id?: string | null,
): Promise<{ amount_pence: number | null; error_code: string | null }> {
  try {
    let query = supabase
      .from("driver_payout_reservations")
      .select("driver_id, amount_pence")
      .eq("status", "ACTIVE");
    const { data: rows, error } = await query.limit(5000);
    if (error) {
      return { amount_pence: null, error_code: "RESERVED_DRIVER_PAYOUTS_QUERY_FAILED" };
    }
    let reservedRows = rows ?? [];
    if (service_area_id && reservedRows.length > 0) {
      const ids = [...new Set(reservedRows.map((r) => String(r.driver_id)).filter(Boolean))];
      const { data: links } = await supabase
        .from("driver_service_areas")
        .select("driver_id")
        .eq("service_area_id", service_area_id)
        .in("driver_id", ids);
      const allowed = new Set((links ?? []).map((r) => String(r.driver_id)));
      reservedRows = reservedRows.filter((r) => allowed.has(String(r.driver_id)));
    }
    let reserved = 0;
    for (const r of reservedRows) {
      reserved += Math.max(0, Number(r.amount_pence ?? 0));
    }
    return { amount_pence: reserved, error_code: null };
  } catch {
    return { amount_pence: null, error_code: "RESERVED_DRIVER_PAYOUTS_QUERY_FAILED" };
  }
}
