/**
 * Protected Driver Liabilities — company-funds SSOT (pure).
 * Money owed to drivers must not be treated as ONECAB company funds.
 *
 * Per-driver envelope (fail-closed, no double-count):
 *   wallet_basis = max(live, available + pending_clearing)
 *   protected_driver = max(wallet_basis, reserved, inflight, terminal_fee_owed, unresolved)
 *   total = Σ protected_driver
 */

export type ProtectedDriverLiabilityDriverRow = {
  driver_id: string;
  /** Live unpaid driver wallet balance (DWL SSOT). */
  live_wallet_pence?: number | null;
  /** Available for payout now (eligibility SSOT). */
  available_pence?: number | null;
  /** Settlement-pending / clearing entitlement (eligibility SSOT). */
  pending_clearing_pence?: number | null;
  /** ACTIVE driver_payout_reservations (HOLD rows excluded from live). */
  active_reserved_pence?: number | null;
  /** Submitted/pending provider transfers not finalized locally. */
  inflight_provider_transfer_pence?: number | null;
  /** Terminal-fee compensation owed but not yet wallet-credited. */
  terminal_fee_owed_pence?: number | null;
  /** Other unresolved protected payout obligations. */
  unresolved_protected_obligation_pence?: number | null;
};

export type ProtectedDriverLiabilityBreakdown = {
  live_wallet_pence: number;
  pending_clearing_pence: number;
  active_reserved_pence: number;
  inflight_provider_transfer_pence: number;
  terminal_fee_owed_pence: number;
  unresolved_protected_obligation_pence: number;
  total_pence: number;
};

/** MK acceptance proof — Revolut £21.76, pending £23.20, payables £1.11 → before reserve £0. */
export const PROTECTED_LIABILITY_ACCEPTANCE_PROOF = {
  REVOLUT_SOURCE_PENCE: 2176,
  PENDING_CLEARING_PENCE: 2320,
  APPROVED_PAYABLES_PENCE: 111,
  EXPECTED_BEFORE_RESERVE_PENCE: 0,
} as const;

function nonNeg(n: unknown): number {
  const v = Math.round(Number(n ?? 0));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Per-driver protected envelope — never double-count wallet + reservation for the same pool. */
export function computeProtectedDriverLiabilityForDriver(
  row: ProtectedDriverLiabilityDriverRow,
): number {
  const live = nonNeg(row.live_wallet_pence);
  const available = nonNeg(row.available_pence);
  const pending = nonNeg(row.pending_clearing_pence);
  const reserved = nonNeg(row.active_reserved_pence);
  const inflight = nonNeg(row.inflight_provider_transfer_pence);
  const terminal = nonNeg(row.terminal_fee_owed_pence);
  const unresolved = nonNeg(row.unresolved_protected_obligation_pence);

  const walletBasis = Math.max(live, available + pending);
  return Math.max(walletBasis, reserved, inflight, terminal, unresolved);
}

/** Aggregate protected driver liabilities across platform-collected drivers. */
export function computeProtectedDriverLiabilitiesPence(
  drivers: ReadonlyArray<ProtectedDriverLiabilityDriverRow>,
): ProtectedDriverLiabilityBreakdown {
  let liveTotal = 0;
  let pendingTotal = 0;
  let reservedTotal = 0;
  let inflightTotal = 0;
  let terminalTotal = 0;
  let unresolvedTotal = 0;
  let total = 0;

  for (const row of drivers) {
    liveTotal += nonNeg(row.live_wallet_pence);
    pendingTotal += nonNeg(row.pending_clearing_pence);
    reservedTotal += nonNeg(row.active_reserved_pence);
    inflightTotal += nonNeg(row.inflight_provider_transfer_pence);
    terminalTotal += nonNeg(row.terminal_fee_owed_pence);
    unresolvedTotal += nonNeg(row.unresolved_protected_obligation_pence);
    total += computeProtectedDriverLiabilityForDriver(row);
  }

  return {
    live_wallet_pence: liveTotal,
    pending_clearing_pence: pendingTotal,
    active_reserved_pence: reservedTotal,
    inflight_provider_transfer_pence: inflightTotal,
    terminal_fee_owed_pence: terminalTotal,
    unresolved_protected_obligation_pence: unresolvedTotal,
    total_pence: total,
  };
}

/**
 * @deprecated Use computeProtectedDriverLiabilitiesPence — live-only sum retained for legacy callers.
 */
export function sumLiveDriverWalletLiabilitiesPence(
  liveByDriver: ReadonlyArray<{ driver_id: string; live_pence: number }>,
): number {
  let total = 0;
  for (const row of liveByDriver) {
    total += nonNeg(row.live_pence);
  }
  return total;
}
