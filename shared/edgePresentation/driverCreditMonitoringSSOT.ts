/** Admin presentation-only helpers; not part of Edge uploads. */
/**
 * Driver-earning credit monitoring SSOT (read-only, PLATFORM_COLLECTED only).
 * Consumes trip settlement stamps, Payment Sessions evidence, and Driver Wallet Ledger —
 * never writes wallet entries, never repairs money, never includes Commission Wallet.
 */

import { DEFAULT_PAYOUT_CLEARING_DELAY_HOURS } from "../../supabase/functions/_shared/driverPayoutEligibilitySSOT.ts";

import { evaluateFrSettlementCaptureIdentity } from "../../supabase/functions/_shared/frConsumeOnlySSOT.ts";
import { DriverCreditRecommendedOwner, DRIVER_CREDIT_RECOMMENDED_OWNER, DriverWalletCreditAuditInputRow, DriverWalletCreditAuditRow, DriverWalletCreditAuditSummary, buildDriverWalletCreditAuditRow, buildDriverWalletCreditAuditSummary } from "../../supabase/functions/_shared/driverCreditMonitoringSSOT.ts";


export const DRIVER_CREDIT_RECOMMENDED_OWNER_LABELS: Record<DriverCreditRecommendedOwner, string> = {
  [DRIVER_CREDIT_RECOMMENDED_OWNER.SETTLEMENT_REPAIR]: "Settlement repair",
  [DRIVER_CREDIT_RECOMMENDED_OWNER.WALLET_ADJUSTMENT]: "Wallet adjustment (approved only)",
  [DRIVER_CREDIT_RECOMMENDED_OWNER.IGNORE_HISTORICAL]: "Ignore historical",
  [DRIVER_CREDIT_RECOMMENDED_OWNER.INVESTIGATE]: "Investigate",
};


export function buildDriverWalletCreditAuditFromSettlementRows(
  rows: ReadonlyArray<DriverWalletCreditAuditInputRow>,
  args?: { now_ms?: number },
): {
  rows: DriverWalletCreditAuditRow[];
  summary: DriverWalletCreditAuditSummary;
} {
  const auditRows: DriverWalletCreditAuditRow[] = [];
  for (const row of rows) {
    const built = buildDriverWalletCreditAuditRow({ ...row, now_ms: args?.now_ms });
    if (built) auditRows.push(built);
  }
  return {
    rows: auditRows,
    summary: buildDriverWalletCreditAuditSummary(auditRows),
  };
}

export * from "../../supabase/functions/_shared/driverCreditMonitoringSSOT.ts";
