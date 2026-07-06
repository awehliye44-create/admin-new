// Stub — Provider payouts retired in Phase 3.
// TODO(Phase 3 UI purge): delete call sites and this file.

export type MondayPayoutTodayCardsData = {
  scheduled_pence: number;
  paid_pence: number;
  failed_pence: number;
  partial_pence: number;
};

export function MondayPayoutTodayCards(_props: {
  cards?: MondayPayoutTodayCardsData;
  todayPeriodStart?: string | null;
  [k: string]: unknown;
}) {
  return null;
}

export function PartialSettlementAlert(_props: Record<string, unknown>) {
  return null;
}
