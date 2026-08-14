/**
 * Payout Ledger — consume Payment Sessions net commission only.
 * Never recalculates gross/fees on the payout ledger page.
 * Uses the same trip-compare builder that feeds PS summary.net_onecab_commission_pence.
 */
// deno-lint-ignore no-explicit-any
type AnySupabase = any;

import { buildPaymentSessionsTripCompare } from "./adminPaymentSessionsTripCompareSSOT.ts";
import { PAYMENT_SESSIONS_NET_COMMISSION_SOURCE } from "../../../shared/payoutLedgerCompanyFundingSSOT.ts";

export async function loadPaymentSessionsNetCommissionPence(
  supabase: AnySupabase,
  args?: { service_area_id?: string | null },
): Promise<{
  net_onecab_commission_pence: number | null;
  source: string;
  gross_onecab_commission_pence: number | null;
  provider_fees_total_pence: number | null;
}> {
  // Same path as Payment Sessions overview/matching widgets
  // (buildPaymentSessionsTripCompare → buildPaymentSessionsCommissionWidgets).
  const bundle = await buildPaymentSessionsTripCompare(
    supabase,
    {
      limit: 200,
      service_area_id: args?.service_area_id ?? null,
    },
    [],
  );

  return {
    net_onecab_commission_pence: bundle.compare_summary.net_onecab_commission_pence,
    gross_onecab_commission_pence: bundle.compare_summary.gross_onecab_commission_pence,
    provider_fees_total_pence: bundle.compare_summary.provider_fees_total_pence,
    source: PAYMENT_SESSIONS_NET_COMMISSION_SOURCE,
  };
}
