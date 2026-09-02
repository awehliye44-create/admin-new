import { buildPaymentSessionsTripCompare } from "./adminPaymentSessionsTripCompareSSOT.ts";
import { PAYMENT_SESSIONS_NET_COMMISSION_SOURCE } from "../../../shared/payoutLedgerCompanyFundingSSOT.ts";

const COMMISSION_PAGE_SIZE = 200;

/**
 * Payout Ledger — consume Payment Sessions net commission only (paginated aggregate).
 * Never recalculates gross/fees on the payout ledger page.
 */
// deno-lint-ignore no-explicit-any
type AnySupabase = any;

export async function loadPaymentSessionsNetCommissionPence(
  supabase: AnySupabase,
  args?: { service_area_id?: string | null },
): Promise<{
  net_onecab_commission_pence: number | null;
  source: string;
  gross_onecab_commission_pence: number | null;
  provider_fees_total_pence: number | null;
  trip_pages_aggregated: number;
}> {
  let offset = 0;
  let grossTotal = 0;
  let netTotal = 0;
  let feesTotal = 0;
  let pages = 0;
  let hasRows = false;

  for (;;) {
    const bundle = await buildPaymentSessionsTripCompare(
      supabase,
      {
        limit: COMMISSION_PAGE_SIZE,
        offset,
        service_area_id: args?.service_area_id ?? null,
      },
      [],
    );
    pages += 1;
    const summary = bundle.compare_summary;
    const pageGross = Math.max(0, Number(summary.gross_onecab_commission_pence ?? 0));
    const pageNet = Math.max(0, Number(summary.net_onecab_commission_pence ?? 0));
    const pageFees = Math.max(0, Number(summary.provider_fees_total_pence ?? 0));
    if (pageGross > 0 || pageNet > 0 || pageFees > 0) {
      hasRows = true;
    }
    grossTotal += pageGross;
    netTotal += pageNet;
    feesTotal += pageFees;

    const rowCount = bundle.completed_trip_rows?.length ?? 0;
    if (rowCount < COMMISSION_PAGE_SIZE) break;
    offset += COMMISSION_PAGE_SIZE;
    if (pages >= 50) break;
  }

  return {
    net_onecab_commission_pence: hasRows || pages > 0 ? netTotal : null,
    gross_onecab_commission_pence: hasRows || pages > 0 ? grossTotal : null,
    provider_fees_total_pence: hasRows || pages > 0 ? feesTotal : null,
    source: `${PAYMENT_SESSIONS_NET_COMMISSION_SOURCE} · paginated aggregate`,
    trip_pages_aggregated: pages,
  };
}
