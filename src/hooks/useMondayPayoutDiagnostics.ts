import { useQuery } from "@tanstack/react-query";
import type { ServiceAreaFinanceSelection } from "@/components/finance/ServiceAreaFinanceFilter";
import { fetchEdgeFunctionGet } from "@/lib/fetchEdgeFunctionGet";
import { supabase } from "@/integrations/supabase/client";

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
  driver_wallet_balance_pence: number | null;
  driver_debt_pence: number | null;
  gross_payable_pence: number;
  cash_commission_recovered_pence: number;
  net_driver_payout_pence: number;
  payout_status: string;
  settlement_status: MondayPayoutSettlementStatus | null;
  payout_evidence_type?: "local_only" | "stripe_transfer" | "stripe_payout";
  payout_evidence_label?: string;
  stripe_transfer_id?: string | null;
  stripe_payout_id?: string | null;
  retry_blocked_reason?: string | null;
  driver_paid_out_pence: number;
  failed_payout_amount_pence: number;
  driver_pending_pence: number;
  returned_to_wallet_pence: number;
  provider_status: string | null;
  provider_reference: string | null;
  failure_reason: string | null;
  failure_code?: string | null;
  failed_at: string | null;
  reconciliation_status: "BALANCED" | "RECONCILIATION_MISMATCH";
  reconciliation_detail: string | null;
  payout_policy_violation: boolean;
  payout_policy_violation_detail: string | null;
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

export type StripeConnectPayoutHistoryRow = {
  payout_id: string;
  connected_account_id: string;
  driver_id: string | null;
  driver_name: string | null;
  amount_pence: number;
  currency: string;
  status: string;
  initiated_at: string | null;
  arrival_date: string | null;
  bank_last4: string | null;
  failure_code: string | null;
  failure_message: string | null;
  balance_transaction_id: string | null;
  payout_method: string | null;
  statement_descriptor: string | null;
  last_synced_at: string | null;
};

export type MondayPayoutDiagnosticsResponse = {
  today_cards: MondayPayoutTodayCards;
  /** London period start ISO — scope for summary cards */
  today_period_start?: string;
  period_end?: string | null;
  platform_available_pence?: number | null;
  stripe_payout_sync?: { accounts_synced: number; payouts_synced: number } | null;
  stripe_connect_payouts?: StripeConnectPayoutHistoryRow[];
  payouts: MondayPayoutDiagnosticsRow[];
  failed_payouts: MondayPayoutDiagnosticsRow[];
  partial_settlements: MondayPayoutDiagnosticsRow[];
  reconciliation_mismatches: MondayPayoutDiagnosticsRow[];
};

export const PARTIAL_SETTLEMENT_MESSAGE =
  "ONECAB commission was recovered, but driver payout did not complete.";

function buildDiagnosticsQuery(
  filter: ServiceAreaFinanceSelection,
  opts?: {
    driverId?: string | null;
    today?: boolean;
    allKinds?: boolean;
    from?: string;
    to?: string;
  },
): string {
  const params = new URLSearchParams();
  if (filter.regionId) params.set("region_id", filter.regionId);
  else if (filter.serviceAreaId) params.set("service_area_id", filter.serviceAreaId);
  if (opts?.driverId) params.set("driver_id", opts.driverId);
  if (opts?.from) params.set("from", opts.from);
  if (opts?.to) params.set("to", opts.to);
  if (opts?.today === false) params.set("today", "false");
  if (opts?.allKinds) params.set("all_kinds", "true");
  return params.toString();
}

export function useMondayPayoutDiagnostics(
  filter: ServiceAreaFinanceSelection,
  opts?: {
    driverId?: string | null;
    today?: boolean;
    allKinds?: boolean;
    from?: string;
    to?: string;
    enabled?: boolean;
  },
) {
  return useQuery({
    queryKey: [
      "monday-payout-diagnostics",
      filter.regionId,
      filter.serviceAreaId,
      opts?.driverId,
      opts?.today,
      opts?.allKinds,
      opts?.from,
      opts?.to,
    ],
    enabled: opts?.enabled !== false,
    queryFn: async (): Promise<MondayPayoutDiagnosticsResponse> => {
      const qs = buildDiagnosticsQuery(filter, opts);
      const params = Object.fromEntries(new URLSearchParams(qs));
      return fetchEdgeFunctionGet<MondayPayoutDiagnosticsResponse>(
        "admin-monday-payout-diagnostics",
        params,
      );
    },
    staleTime: 30_000,
    retry: 1,
    meta: { suppressErrorToast: true },
  });
}

/** Retry a failed payout item — ledger sync vs full provider retry (no duplicate batch). */
export async function retryMondayPayoutItem(row: MondayPayoutDiagnosticsRow): Promise<void> {
  if (row.retry_blocked_reason) {
    throw new Error(row.retry_blocked_reason);
  }

  if (row.payout_status === "ledger_sync_failed") {
    const { data, error } = await supabase.functions.invoke("admin-driver-payout", {
      body: { payout_item_id: row.payout_item_id },
    });
    if (error) {
      const msg = (data as { error?: string } | null)?.error ?? error.message;
      throw new Error(msg);
    }
    if (!(data as { success?: boolean })?.success && !(data as { retry?: boolean })?.retry) {
      throw new Error((data as { error?: string })?.error ?? "Ledger sync retry failed");
    }
    return;
  }

  if (row.provider_reference || row.payout_status === "completed") {
    throw new Error("Payout already sent to provider — cannot retry full payout");
  }

  const { data, error } = await supabase.functions.invoke("admin-driver-payout", {
    body: {
      retry_payout_item_id: row.payout_item_id,
      confirm_payout: true,
    },
  });
  if (error) {
    const msg = (data as { error?: string; error_code?: string } | null)?.error ?? error.message;
    throw new Error(msg);
  }
  if (!(data as { success?: boolean })?.success) {
    throw new Error((data as { error?: string })?.error ?? "Payout retry failed");
  }
}

export function canRetryMondayPayoutItem(row: MondayPayoutDiagnosticsRow): boolean {
  if (row.retry_blocked_reason) return false;
  if (row.payout_status === "ledger_sync_failed") return true;
  if (row.payout_status === "failed" && !row.provider_reference) return true;
  return false;
}

export function retryBlockedTooltip(row: MondayPayoutDiagnosticsRow): string | null {
  if (row.retry_blocked_reason) return row.retry_blocked_reason;
  if (row.payout_status === "failed" && !row.provider_reference) {
    return null;
  }
  return null;
}
