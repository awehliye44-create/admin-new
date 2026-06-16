import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { ServiceAreaFinanceSelection } from "@/components/finance/ServiceAreaFinanceFilter";

export type MondayPayoutSettlementStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETE"
  | "FAILED"
  | "PARTIAL_SETTLEMENT";

export type MondayPayoutDiagnosticsRow = {
  payout_item_id: string;
  batch_id: string | null;
  batch_kind: string;
  driver_id: string;
  driver_name: string | null;
  gross_payable_pence: number;
  cash_commission_recovered_pence: number;
  net_driver_payout_pence: number;
  payout_status: string;
  settlement_status: MondayPayoutSettlementStatus | null;
  driver_paid_out_pence: number;
  failed_payout_amount_pence: number;
  driver_pending_pence: number;
  returned_to_wallet_pence: number;
  provider_status: string | null;
  provider_reference: string | null;
  failure_reason: string | null;
  failed_at: string | null;
  reconciliation_status: "BALANCED" | "RECONCILIATION_MISMATCH";
  reconciliation_detail: string | null;
  created_at: string;
  completed_at: string | null;
};

export type MondayPayoutTodayCards = {
  onecab_commission_recovered_pence: number;
  driver_payout_sent_pence: number;
  driver_payout_failed_pence: number;
  driver_payout_pending_pence: number;
  returned_to_wallet_pence: number;
};

export type MondayPayoutDiagnosticsResponse = {
  today_cards: MondayPayoutTodayCards;
  payouts: MondayPayoutDiagnosticsRow[];
  failed_payouts: MondayPayoutDiagnosticsRow[];
  partial_settlements: MondayPayoutDiagnosticsRow[];
  reconciliation_mismatches: MondayPayoutDiagnosticsRow[];
};

export const PARTIAL_SETTLEMENT_MESSAGE =
  "ONECAB commission was recovered, but driver payout did not complete.";

function buildDiagnosticsQuery(
  filter: ServiceAreaFinanceSelection,
  opts?: { driverId?: string | null; today?: boolean; allKinds?: boolean },
): string {
  const params = new URLSearchParams();
  if (filter.regionId) params.set("region_id", filter.regionId);
  else if (filter.serviceAreaId) params.set("service_area_id", filter.serviceAreaId);
  if (opts?.driverId) params.set("driver_id", opts.driverId);
  if (opts?.today === false) params.set("today", "false");
  if (opts?.allKinds) params.set("all_kinds", "true");
  return params.toString();
}

export function useMondayPayoutDiagnostics(
  filter: ServiceAreaFinanceSelection,
  opts?: { driverId?: string | null; today?: boolean; allKinds?: boolean; enabled?: boolean },
) {
  return useQuery({
    queryKey: [
      "monday-payout-diagnostics",
      filter.regionId,
      filter.serviceAreaId,
      opts?.driverId,
      opts?.today,
      opts?.allKinds,
    ],
    enabled: opts?.enabled !== false,
    queryFn: async (): Promise<MondayPayoutDiagnosticsResponse> => {
      // NOTE: supabase.functions.invoke() does not support query strings in the
      // function name — it URL-encodes the `?` and the gateway 401s. Use fetch.
      const qs = buildDiagnosticsQuery(filter, opts);
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
      const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? anonKey;
      const url = `${supabaseUrl}/functions/v1/admin-monday-payout-diagnostics${qs ? `?${qs}` : ""}`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: anonKey,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Edge function returned ${res.status}: ${text}`);
      }
      return (await res.json()) as MondayPayoutDiagnosticsResponse;
    },
    staleTime: 30_000,
  });
}

/** Retry a failed payout item — ledger sync vs full provider retry. */
export async function retryMondayPayoutItem(row: MondayPayoutDiagnosticsRow): Promise<void> {
  if (row.payout_status === "ledger_sync_failed") {
    const { data, error } = await supabase.functions.invoke("admin-driver-payout", {
      body: { payout_item_id: row.payout_item_id },
    });
    if (error) throw error;
    if (!(data as { success?: boolean })?.success && !(data as { retry?: boolean })?.retry) {
      throw new Error((data as { error?: string })?.error ?? "Ledger sync retry failed");
    }
    return;
  }

  await supabase.rpc("ops_retry_failed_payout_item", {
    p_payout_item_id: row.payout_item_id,
  });

  const { data, error } = await supabase.functions.invoke("admin-driver-payout", {
    body: {
      driver_id: row.driver_id,
      amount_pence: row.net_driver_payout_pence,
      kind: row.batch_kind === "WEEKLY_MONDAY" ? "WEEKLY_MONDAY" : "MANUAL_ADMIN",
    },
  });
  if (error) throw error;
  if (!(data as { success?: boolean })?.success) {
    throw new Error((data as { error?: string })?.error ?? "Payout retry failed");
  }
}
