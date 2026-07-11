/**
 * Driver Wallet Ledger — settlement history display rows.
 * Consumes Payment Sessions capture + trip settlement snapshots + wallet ledger credit.
 * Never recalculates customer payment, provider fee, or commission formulas.
 */

export type DriverWalletSettlementHistoryInput = {
  settlement_id: string;
  trip_id: string | null;
  settlement_status: string | null;
  settled_at: string | null;
  wallet_credit_pence: number | null;
  trip: {
    trip_code?: string | null;
    completed_at?: string | null;
    passenger_name?: string | null;
    payment_provider?: string | null;
    payment_method?: string | null;
    provider_fee_pence?: number | null;
    platform_commission_amount?: number | null;
    driver_tier_commission_percent?: number | null;
    driver_net_pence?: number | null;
    payment_session_id?: string | null;
  } | null;
  /** Payment Sessions SSOT — customer paid + session identity. */
  payment_session: {
    id?: string | null;
    payment_provider?: string | null;
    payment_method?: string | null;
    captured_amount_pence?: number | null;
    provider_processing_fee_pence?: number | null;
  } | null;
};

export type DriverWalletSettlementHistoryRow = {
  settlement_id: string;
  trip_id: string | null;
  trip_code: string | null;
  completed_at: string | null;
  customer_name: string | null;
  payment_provider: string | null;
  payment_method: string | null;
  /** From Payment Sessions capture only (null for cash). */
  customer_paid_pence: number | null;
  /** Prefer PS fee when present; else trip.provider_fee_pence (stored). */
  provider_fee_pence: number | null;
  platform_commission_pence: number | null;
  driver_commission_percent: number | null;
  driver_net_pence: number | null;
  wallet_credit_pence: number | null;
  settlement_status: string | null;
  payment_session_id: string | null;
};

function isCashPaymentMethod(method: string | null | undefined): boolean {
  const m = String(method ?? "").trim().toLowerCase();
  return m === "cash" || m.includes("cash");
}

/** Build one settlement display row from already-canonical sources. */
export function buildDriverWalletSettlementHistoryRow(
  input: DriverWalletSettlementHistoryInput,
): DriverWalletSettlementHistoryRow {
  const trip = input.trip;
  const session = input.payment_session;
  const method = session?.payment_method ?? trip?.payment_method ?? null;
  const cash = isCashPaymentMethod(method);
  const sessionId = session?.id ?? trip?.payment_session_id ?? null;
  const captured = session?.captured_amount_pence == null
    ? null
    : Math.max(0, Number(session.captured_amount_pence));

  return {
    settlement_id: input.settlement_id,
    trip_id: input.trip_id,
    trip_code: trip?.trip_code ?? null,
    completed_at: trip?.completed_at ?? input.settled_at ?? null,
    customer_name: trip?.passenger_name ?? null,
    payment_provider: session?.payment_provider ?? trip?.payment_provider ?? null,
    payment_method: method,
    customer_paid_pence: cash ? null : captured,
    provider_fee_pence: session?.provider_processing_fee_pence != null
      ? Math.max(0, Number(session.provider_processing_fee_pence))
      : trip?.provider_fee_pence == null
      ? null
      : Math.max(0, Number(trip.provider_fee_pence)),
    platform_commission_pence: trip?.platform_commission_amount == null
      ? null
      : Math.max(0, Number(trip.platform_commission_amount)),
    driver_commission_percent: trip?.driver_tier_commission_percent == null
      ? null
      : Number(trip.driver_tier_commission_percent),
    driver_net_pence: trip?.driver_net_pence == null
      ? null
      : Math.max(0, Number(trip.driver_net_pence)),
    wallet_credit_pence: input.wallet_credit_pence == null
      ? null
      : Number(input.wallet_credit_pence),
    settlement_status: input.settlement_status,
    payment_session_id: sessionId,
  };
}

export function buildDriverWalletSettlementHistory(
  inputs: DriverWalletSettlementHistoryInput[],
): DriverWalletSettlementHistoryRow[] {
  return inputs
    .map(buildDriverWalletSettlementHistoryRow)
    .sort((a, b) => {
      const aTs = a.completed_at ? new Date(a.completed_at).getTime() : 0;
      const bTs = b.completed_at ? new Date(b.completed_at).getTime() : 0;
      return bTs - aTs;
    });
}
