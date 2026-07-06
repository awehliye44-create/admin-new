// Stub after Phase 3 Provider payout removal.
// The Monday-Provider-payout diagnostics hook is retired; UI shells that still
// import it receive an empty, permanently-idle response so pages compile.
// TODO(Phase 3 UI purge): delete every remaining call site and remove this file.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

export type MondayPayoutDiagnosticsRow = Record<string, unknown>;

export type PayoutRetryRecord = {
  payoutItemId?: string;
  status?: string;
  stripeTransferId?: string | null;
  stripePayoutId?: string | null;
  [k: string]: unknown;
};

export type MondayPayoutTodayCards = {
  scheduled_pence: number;
  paid_pence: number;
  failed_pence: number;
  partial_pence: number;
};

export type MondayPayoutDiagnosticsResponse = {
  today_cards: MondayPayoutTodayCards;
  today_period_start: string | null;
  payouts: MondayPayoutDiagnosticsRow[];
  failed_payouts: MondayPayoutDiagnosticsRow[];
  partial_settlements: MondayPayoutDiagnosticsRow[];
  reconciliation_mismatches: MondayPayoutDiagnosticsRow[];
};

const EMPTY: MondayPayoutDiagnosticsResponse = {
  today_cards: { scheduled_pence: 0, paid_pence: 0, failed_pence: 0, partial_pence: 0 },
  today_period_start: null,
  payouts: [],
  failed_payouts: [],
  partial_settlements: [],
  reconciliation_mismatches: [],
};

export function useMondayPayoutDiagnostics(
  _serviceFilter?: unknown,
  _opts?: unknown,
): UseQueryResult<MondayPayoutDiagnosticsResponse> {
  return useQuery({
    queryKey: ["monday-payout-diagnostics-removed"],
    queryFn: async () => EMPTY,
    staleTime: Infinity,
  });
}

export async function retryMondayPayoutItem(_row: MondayPayoutDiagnosticsRow): Promise<void> {
  throw new Error("Provider Monday payouts have been removed. Use Revolut payouts.");
}

export function canRetryMondayPayoutItem(_row: MondayPayoutDiagnosticsRow): boolean {
  return false;
}

export function retryBlockedTooltip(_row: MondayPayoutDiagnosticsRow): string {
  return "Provider payouts retired — driver payouts move to Revolut Business /pay.";
}

// Legacy aliases retained for call sites still on the old naming.
export function canRetryPayoutItemRecord(_record: PayoutRetryRecord | MondayPayoutDiagnosticsRow): boolean {
  return false;
}
export async function retryPayoutItemFromRecord(_record: PayoutRetryRecord | MondayPayoutDiagnosticsRow): Promise<void> {
  throw new Error("Provider Monday payouts have been removed. Use Revolut payouts.");
}
