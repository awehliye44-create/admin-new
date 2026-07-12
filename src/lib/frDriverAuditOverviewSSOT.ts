/**
 * FR Overview — aggregate per-driver audit statuses (counts only, no money math).
 * Mirrors aggregateFrDriverAuditOverview in supabase/_shared/frDriverReconciliationSSOT.ts
 */

export type FrDriverAuditOverviewCounts = {
  drivers_balanced_count: number;
  driver_wallet_mismatches_count: number;
  payout_mismatches_count: number;
  provider_balance_unavailable_count: number;
  pending_sync_count: number;
  drivers_audited_count: number;
  driver_audit_complete: boolean;
  overview_driver_audit_status:
    | 'BALANCED'
    | 'SETTLEMENT_BALANCED_DRIVER_AUDIT_PENDING'
    | 'PARTIAL'
    | 'DRIVER_AUDIT_MISMATCH';
};

export function aggregateFrDriverAuditOverview(
  rows: Array<{ reconciliation_status: string }>,
  args?: { settlementIdentityBalanced?: boolean },
): FrDriverAuditOverviewCounts {
  let balanced = 0;
  let walletMismatch = 0;
  let payoutMismatch = 0;
  let providerUnavailable = 0;
  let pendingSync = 0;

  for (const row of rows) {
    const s = row.reconciliation_status;
    if (s === 'BALANCED') balanced += 1;
    if (
      s === 'DRIVER_WALLET_MISMATCH'
      || s === 'DRIVER_AND_PAYOUT_MISMATCH'
      || s === 'MISSING_WALLET_EVIDENCE'
    ) {
      walletMismatch += 1;
    }
    if (s === 'PAYOUT_MISMATCH' || s === 'DRIVER_AND_PAYOUT_MISMATCH') {
      payoutMismatch += 1;
    }
    if (s === 'PROVIDER_BALANCE_UNAVAILABLE') providerUnavailable += 1;
    if (
      s === 'PENDING_SYNC'
      || s === 'MISSING_SETTLEMENT_EVIDENCE'
      || s === 'ACCOUNT_UNVERIFIED'
    ) {
      pendingSync += 1;
    }
  }

  const audited = rows.length;
  const mismatchAny = walletMismatch > 0 || payoutMismatch > 0;
  const incomplete = pendingSync > 0 || providerUnavailable > 0;
  const settlementOk = args?.settlementIdentityBalanced === true;

  let overview: FrDriverAuditOverviewCounts['overview_driver_audit_status'];
  if (audited === 0) {
    overview = 'SETTLEMENT_BALANCED_DRIVER_AUDIT_PENDING';
  } else if (mismatchAny) {
    overview = 'DRIVER_AUDIT_MISMATCH';
  } else if (incomplete) {
    overview = settlementOk ? 'SETTLEMENT_BALANCED_DRIVER_AUDIT_PENDING' : 'PARTIAL';
  } else if (balanced === audited) {
    overview = 'BALANCED';
  } else {
    overview = 'PARTIAL';
  }

  return {
    drivers_balanced_count: balanced,
    driver_wallet_mismatches_count: walletMismatch,
    payout_mismatches_count: payoutMismatch,
    provider_balance_unavailable_count: providerUnavailable,
    pending_sync_count: pendingSync,
    drivers_audited_count: audited,
    driver_audit_complete: audited > 0 && !incomplete && !mismatchAny,
    overview_driver_audit_status: overview,
  };
}
