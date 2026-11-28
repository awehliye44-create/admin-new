/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Driver-earning credit monitoring SSOT (read-only, PLATFORM_COLLECTED only).
 * Consumes trip settlement stamps, Payment Sessions evidence, and Driver Wallet Ledger —
 * never writes wallet entries, never repairs money, never includes Commission Wallet.
 */

import { DEFAULT_PAYOUT_CLEARING_DELAY_HOURS } from "../../../functions/_shared/driverPayoutEligibilitySSOT.ts";

import { evaluateFrSettlementCaptureIdentity } from "../../../functions/_shared/frConsumeOnlySSOT.ts";
import { DriverCreditHealth, DriverCreditHistoricalAuditReport, DRIVER_CREDIT_HEALTH } from "../../../functions/_shared/driverCreditMonitoringSSOT.ts";


export function runDriverCreditHistoricalAudit(
  rows: Array<{
    trip_code?: string | null;
    financial_model?: string | null;
    driver_credit_health?: DriverCreditHealth | string | null;
    credit_difference_pence?: number | null;
  }>,
): DriverCreditHistoricalAuditReport {
  const report: DriverCreditHistoricalAuditReport = {
    eligible_trips: 0,
    correctly_credited_trips: 0,
    missing_count: 0,
    under_credited_count: 0,
    over_credited_count: 0,
    duplicate_count: 0,
    wrong_driver_count: 0,
    pending_count: 0,
    not_applicable_count: 0,
    total_difference_pence: 0,
    affected_trip_codes: [],
  };

  for (const row of rows) {
    const model = String(row.financial_model ?? "").trim().toUpperCase();
    const health = String(row.driver_credit_health ?? "") as DriverCreditHealth;

    if (model.includes("DRIVER_COLLECTED") || health === DRIVER_CREDIT_HEALTH.NOT_APPLICABLE) {
      report.not_applicable_count += 1;
      continue;
    }
    if (health === DRIVER_CREDIT_HEALTH.PENDING) {
      report.pending_count += 1;
      continue;
    }

    report.eligible_trips += 1;

    if (health === DRIVER_CREDIT_HEALTH.OK) {
      report.correctly_credited_trips += 1;
      continue;
    }

    const code = row.trip_code?.trim();
    if (code) report.affected_trip_codes.push(code);

    const diff = Math.abs(Math.round(Number(row.credit_difference_pence ?? 0)));
    report.total_difference_pence += diff;

    switch (health) {
      case DRIVER_CREDIT_HEALTH.MISSING:
        report.missing_count += 1;
        break;
      case DRIVER_CREDIT_HEALTH.UNDER_CREDITED:
        report.under_credited_count += 1;
        break;
      case DRIVER_CREDIT_HEALTH.OVER_CREDITED:
        report.over_credited_count += 1;
        break;
      case DRIVER_CREDIT_HEALTH.DUPLICATE:
        report.duplicate_count += 1;
        break;
      case DRIVER_CREDIT_HEALTH.WRONG_DRIVER:
        report.wrong_driver_count += 1;
        break;
      default:
        break;
    }
  }

  return report;
}


/** Promotion reconciliation — platform subsidy clears identity mismatch without reducing driver credit. */
export function evaluatePromotionReconciliationIdentity(args: {
  captured_pence: number | null;
  driver_net_pence: number | null;
  commission_pence: number | null;
  airport_fee_pence?: number | null;
  tip_pence?: number | null;
  platform_promotion_subsidy_pence?: number | null;
}): ReturnType<typeof evaluateFrSettlementCaptureIdentity> {
  return evaluateFrSettlementCaptureIdentity({
    captured_pence: args.captured_pence,
    driver_net_pence: args.driver_net_pence,
    commission_pence: args.commission_pence,
    platform_promotion_subsidy_pence: args.platform_promotion_subsidy_pence,
    airport_charge_pence: args.airport_fee_pence,
    tips_pence: args.tip_pence,
  });
}

export * from "../../../functions/_shared/driverCreditMonitoringSSOT.ts";
export * from "../../../../shared/edgePresentation/driverCreditMonitoringSSOT.ts";
