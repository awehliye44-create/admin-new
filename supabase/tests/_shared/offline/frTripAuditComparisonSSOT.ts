/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Financial Reconciliation — canonical comparison classifiers (audit only).
 * Consumes Payment Sessions / trip settlement / wallet / payout evidence — never invents amounts.
 */

import { readPersistedCaptureBreakdown } from "../../../functions/_shared/paymentSessionsCaptureBreakdownSSOT.ts";

import {
  evaluateFrSettlementCaptureIdentity,
  isFrTripFullyBalanced,
  resolveFrTripAuditStatus,
  FR_TRIP_AUDIT_STATUS,
} from "../../../functions/_shared/frConsumeOnlySSOT.ts";
import { CaptureReconciliationStatus, WalletReconciliationStatus, TOLERANCE_PENCE, FrAuditOverviewKpis, isPsCaptureShortfall, isPsUnexplainedOvercapture, isMissingCaptureRow, isMissingReleaseRow, classifyReleaseReconciliation } from "../../../functions/_shared/frTripAuditComparisonSSOT.ts";


/** actual_capture - expected_capture (final customer fare). */
export function captureVariancePence(args: {
  captured_pence: number | null;
  final_customer_fare_pence: number | null;
}): number | null {
  if (args.captured_pence == null || args.final_customer_fare_pence == null) return null;
  return args.captured_pence - args.final_customer_fare_pence;
}


export function classifyCaptureReconciliation(args: {
  isCash: boolean;
  paymentEvidenceStatus?: string | null;
  captured_pence: number | null;
  final_customer_fare_pence: number | null;
  authorised_pence?: number | null;
  provider_verification_status?: "VERIFIED" | "STALE" | "UNKNOWN" | null;
  /** Completed-trip audit: missing capture is CAPTURE_MISSING not pending. */
  tripCompleted?: boolean;
}): CaptureReconciliationStatus {
  if (args.isCash) return "MATCHED";
  if (args.paymentEvidenceStatus === "PAYMENT_EVIDENCE_UNAVAILABLE") {
    return "PAYMENT_EVIDENCE_UNAVAILABLE";
  }
  if (args.paymentEvidenceStatus === "NO_PAYMENT_SESSION") {
    return "NO_PAYMENT_SESSION";
  }
  if (args.provider_verification_status === "STALE") {
    return "PROVIDER_VERIFICATION_PENDING";
  }
  if (args.captured_pence == null) {
    // Completed-trip audit: PS present but capture £0/unknown → RED mismatch (MK rule).
    if (args.paymentEvidenceStatus === "PAYMENT_SESSIONS") {
      return args.tripCompleted === false ? "CAPTURE_PENDING" : "PAYMENT_SESSION_CAPTURE_MISMATCH";
    }
    if (args.authorised_pence != null && args.authorised_pence > 0) {
      return args.tripCompleted === false ? "CAPTURE_PENDING" : "CAPTURE_MISSING";
    }
    return "CAPTURE_AMOUNT_UNKNOWN";
  }
  if (args.captured_pence <= 0) return "PAYMENT_SESSION_CAPTURE_MISMATCH";
  // Amount compare / OVERCAPTURE / SHORTFALL is owned by Payment Sessions capture_breakdown.
  // Without PS expected, FR must not invent variance from trip fare.
  if (args.final_customer_fare_pence == null) return "CAPTURE_AMOUNT_UNKNOWN";
  return "CAPTURE_AMOUNT_UNKNOWN";
}


export function classifyWalletReconciliation(args: {
  walletEvidenceAvailable: boolean;
  expected_driver_net_pence: number | null;
  actual_wallet_credit_pence: number | null;
  duplicate_wallet_credit?: boolean;
}): WalletReconciliationStatus {
  if (!args.walletEvidenceAvailable) return "WALLET_EVIDENCE_UNAVAILABLE";
  if (args.duplicate_wallet_credit) return "WALLET_DUPLICATE";
  if (args.actual_wallet_credit_pence == null) {
    if (args.expected_driver_net_pence != null && args.expected_driver_net_pence > 0) {
      return "WALLET_CREDIT_MISSING";
    }
    return "WALLET_PENDING";
  }
  if (args.expected_driver_net_pence == null) return "WALLET_PENDING";
  const variance = args.actual_wallet_credit_pence - args.expected_driver_net_pence;
  if (Math.abs(variance) <= TOLERANCE_PENCE) return "WALLET_MATCHED";
  if (variance > 0) return "WALLET_OVER_CREDITED";
  return "WALLET_UNDER_CREDITED";
}


/**
 * Backend-only overview totals from audit rows.
 * Customer money fields are consumed from Payment Sessions evidence on each row —
 * FR never recalculates expected capture / overcapture / shortfall independently.
 */
export function buildFrAuditOverviewKpis(
  rows: Array<{
    ps_expected_capture_pence?: number | null;
    final_fare_pence?: number | null;
    final_customer_fare_pence?: number | null;
    settlement_total_pence?: number | null;
    captured_pence?: number | null;
    authorised_pence?: number | null;
    refunded_pence?: number | null;
    released_pence?: number | null;
    processing_fee_pence?: number | null;
    onecab_gross_commission_pence?: number | null;
    onecab_net_pence?: number | null;
    driver_net_pence?: number | null;
    wallet_credit_pence?: number | null;
    airport_charge_pence?: number | null;
    tip_pence?: number | null;
    tips_pence?: number | null;
    commissionable_fare_pence?: number | null;
    commission_after_promotion_pence?: number | null;
    confirmed_provider_fee_pence?: number | null;
    pickup_waiting_charge_pence?: number | null;
    stop_waiting_charge_pence?: number | null;
    capture_variance_pence?: number | null;
    capture_classification?: string | null;
    capture_reconciliation_status?: string | null;
    release_reconciliation_status?: string | null;
    wallet_reconciliation_status?: string | null;
    payout_reconciliation_status?: string | null;
    fee_status?: string | null;
    payout_amount_pence?: number | null;
    payment_method?: string | null;
    reconciliation_status?: { label?: string | null; tone?: string | null } | null;
    capture_mismatch?: boolean | null;
  }>,
): FrAuditOverviewKpis {
  let fare = 0;
  let captured = 0;
  let authorised = 0;
  let expectedReleased = 0;
  let refunded = 0;
  let released = 0;
  let fees = 0;
  let gross = 0;
  let netSum = 0;
  let netKnown = true;
  let driverNet = 0;
  let walletCredits = 0;
  let airportTotal = 0;
  let tipsTotal = 0;
  let waitingTotal = 0;
  let commissionableTotal = 0;
  let payoutsCompleted = 0;
  let shortfall = 0;
  let overcapture = 0;
  let missingCaptures = 0;
  let missingReleases = 0;
  let releaseUnconfirmed = 0;
  let missingWallet = 0;
  let payoutMismatch = 0;
  let walletMismatch = 0;
  let balanced = 0;
  let unresolved = 0;
  let identityVariance = 0;
  let identityEvaluableCount = 0;
  let identityPendingCount = 0;

  for (const row of rows) {
    if (row.ps_expected_capture_pence != null) {
      fare += Math.max(0, row.ps_expected_capture_pence);
    }
    if (row.captured_pence != null && row.captured_pence > 0) {
      captured += row.captured_pence;
    }
    if (row.authorised_pence != null && row.authorised_pence > 0) {
      authorised += row.authorised_pence;
    }
    if (row.authorised_pence != null && row.captured_pence != null) {
      expectedReleased += Math.max(0, row.authorised_pence - row.captured_pence);
    }
    if (row.refunded_pence != null) refunded += Math.max(0, row.refunded_pence);
    if (row.released_pence != null) released += Math.max(0, row.released_pence);
    if (row.confirmed_provider_fee_pence != null) {
      fees += Math.max(0, row.confirmed_provider_fee_pence);
    } else if (row.processing_fee_pence != null && (
      String(row.fee_status ?? "").toUpperCase() === "ACTUAL"
      || String(row.fee_status ?? "").toUpperCase() === "CONFIRMED"
    )) {
      fees += Math.max(0, row.processing_fee_pence);
    }
    if (row.onecab_gross_commission_pence != null) {
      gross += Math.max(0, row.onecab_gross_commission_pence);
    }
    if (row.onecab_net_pence == null) netKnown = false;
    else netSum += Math.max(0, row.onecab_net_pence);
    if (row.driver_net_pence != null) driverNet += Math.max(0, row.driver_net_pence);
    if (row.wallet_credit_pence != null) walletCredits += Math.max(0, row.wallet_credit_pence);
    if (row.airport_charge_pence != null) airportTotal += Math.max(0, row.airport_charge_pence);
    const tip = row.tips_pence ?? row.tip_pence;
    if (tip != null) tipsTotal += Math.max(0, tip);
    waitingTotal += Math.max(0, Number(row.pickup_waiting_charge_pence ?? 0))
      + Math.max(0, Number(row.stop_waiting_charge_pence ?? 0));
    if (row.commissionable_fare_pence != null) {
      commissionableTotal += Math.max(0, row.commissionable_fare_pence);
    } else if (row.driver_net_pence != null && row.onecab_gross_commission_pence != null) {
      commissionableTotal += Math.max(0, row.driver_net_pence + row.onecab_gross_commission_pence);
    }
    if (String(row.payout_reconciliation_status ?? "") === "PAYOUT_PAID") {
      payoutsCompleted += Math.max(0, Number(row.payout_amount_pence ?? 0));
    }
    const identity = evaluateFrSettlementCaptureIdentity({
      captured_pence: row.captured_pence,
      driver_net_pence: row.driver_net_pence,
      commission_pence: row.onecab_gross_commission_pence,
      commission_after_promotion_pence: row.commission_after_promotion_pence,
      airport_charge_pence: row.airport_charge_pence,
      tips_pence: tip,
    });
    if (identity.variance_pence == null) {
      identityPendingCount += 1;
    } else {
      identityEvaluableCount += 1;
      identityVariance += identity.variance_pence;
    }

    const cv = row.capture_variance_pence;
    if (isPsCaptureShortfall(row) && cv != null && cv < 0) shortfall += Math.abs(cv);
    if (isPsUnexplainedOvercapture(row) && cv != null && cv > 0) overcapture += cv;
    if (isMissingCaptureRow(row)) missingCaptures += 1;
    if (isMissingReleaseRow(row)) missingReleases += 1;
    if (row.release_reconciliation_status === "RELEASE_AMOUNT_UNCONFIRMED") {
      releaseUnconfirmed += 1;
    }
    if (row.wallet_reconciliation_status === "WALLET_CREDIT_MISSING") missingWallet += 1;
    if (
      row.wallet_reconciliation_status === "WALLET_CREDIT_MISSING"
      || row.wallet_reconciliation_status === "WALLET_OVER_CREDITED"
      || row.wallet_reconciliation_status === "WALLET_UNDER_CREDITED"
      || row.wallet_reconciliation_status === "WALLET_DUPLICATE"
      || row.wallet_reconciliation_status === "WALLET_OVER_CREDIT"
      || row.wallet_reconciliation_status === "WALLET_UNDER_CREDIT"
      || row.wallet_reconciliation_status === "DUPLICATE_WALLET_CREDIT"
    ) {
      walletMismatch += 1;
    }
    if (
      row.payout_reconciliation_status === "PAYOUT_MISMATCH"
      || row.payout_reconciliation_status === "PAYOUT_FAILED"
      || row.payout_reconciliation_status === "DUPLICATE_PAYOUT_RISK"
    ) {
      payoutMismatch += 1;
    }
    if (isFrTripFullyBalanced({
      ...row,
      settlement_identity_balanced: identity.balanced,
    })) {
      balanced += 1;
    } else if (
      row.capture_mismatch
      || row.capture_reconciliation_status === "CAPTURE_SHORTFALL"
      || row.capture_reconciliation_status === "OVERCAPTURE"
      || row.capture_reconciliation_status === "CAPTURE_MISSING"
      || row.capture_reconciliation_status === "PAYMENT_SESSION_CAPTURE_MISMATCH"
      || row.capture_reconciliation_status === "CAPTURE_MISMATCH"
      || row.capture_reconciliation_status === "NO_PAYMENT_SESSION"
      || row.release_reconciliation_status === "MISSING_RELEASE"
      || row.release_reconciliation_status === "RELEASE_AMOUNT_UNCONFIRMED"
      || row.wallet_reconciliation_status === "WALLET_CREDIT_MISSING"
      || row.wallet_reconciliation_status === "WALLET_OVER_CREDIT"
      || row.wallet_reconciliation_status === "WALLET_UNDER_CREDIT"
      || row.wallet_reconciliation_status === "DUPLICATE_WALLET_CREDIT"
      || row.payout_reconciliation_status === "PAYOUT_MISMATCH"
      || row.payout_reconciliation_status === "PAYOUT_FAILED"
      || row.payout_reconciliation_status === "DUPLICATE_PAYOUT_RISK"
      || identity.balanced === false
    ) {
      unresolved += 1;
    }
  }

  const identityBalanced = identityEvaluableCount > 0 && identityVariance === 0;

  return {
    completed_trip_fare_total_pence: fare,
    confirmed_provider_captured_total_pence: captured,
    total_authorised_pence: authorised,
    expected_released_pence: expectedReleased,
    released_total_pence: released,
    release_amount_unconfirmed_count: releaseUnconfirmed,
    refunded_total_pence: refunded,
    waiting_charges_total_pence: waitingTotal,
    provider_fee_total_pence: fees,
    onecab_gross_commission_pence: gross,
    onecab_net_commission_pence: netKnown ? netSum : null,
    driver_net_total_pence: driverNet,
    driver_fare_net_total_pence: driverNet,
    driver_tips_total_pence: tipsTotal,
    driver_entitlement_total_pence: driverNet + tipsTotal + airportTotal,
    wallet_credits_total_pence: walletCredits,
    payouts_completed_pence: payoutsCompleted,
    airport_charges_total_pence: airportTotal,
    commissionable_fare_total_pence: commissionableTotal,
    settlement_identity_variance_pence: identityEvaluableCount > 0 ? identityVariance : null,
    settlement_identity_balanced: identityBalanced,
    unallocated_pence: identityEvaluableCount > 0 ? identityVariance : null,
    capture_shortfall_pence: shortfall,
    overcapture_pence: overcapture,
    missing_captures_count: missingCaptures,
    missing_releases_count: missingReleases,
    missing_wallet_credits_count: missingWallet,
    payout_mismatches_count: payoutMismatch,
    wallet_mismatches_count: walletMismatch,
    balanced_trips_count: balanced,
    unresolved_mismatches_count: unresolved,
    trip_count: rows.length,
  };
}


/**
 * Customer-money overview widgets consumed directly from Payment Sessions rows.
 * FR must use this for Completed Trips Paid / Captured / Fees / Refunded / Released /
 * Shortfall / Overcapture / Missing Captures / Missing Releases — never trip-fare invent.
 */
export function buildFrCustomerMoneyKpisFromPaymentSessions(
  sessions: Array<{
    captured_amount_pence?: number | null;
    authorised_amount_pence?: number | null;
    total_authorised_amount_pence?: number | null;
    released_amount_pence?: number | null;
    refunded_amount_pence?: number | null;
    provider_processing_fee_pence?: number | null;
    fee_status?: string | null;
    provider_state?: string | null;
    release_evidence_status?: string | null;
    metadata?: Record<string, unknown> | null;
  }>,
): Pick<
  FrAuditOverviewKpis,
  | "completed_trip_fare_total_pence"
  | "confirmed_provider_captured_total_pence"
  | "refunded_total_pence"
  | "released_total_pence"
  | "provider_fee_total_pence"
  | "capture_shortfall_pence"
  | "overcapture_pence"
  | "missing_captures_count"
  | "missing_releases_count"
  | "airport_charges_total_pence"
  | "driver_tips_total_pence"
> {
  let fare = 0;
  let captured = 0;
  let refunded = 0;
  let released = 0;
  let fees = 0;
  let shortfall = 0;
  let overcapture = 0;
  let missingCaptures = 0;
  let missingReleases = 0;
  let airportTotal = 0;
  let tipsTotal = 0;

  for (const s of sessions) {
    const capRaw = s.captured_amount_pence;
    const cap = capRaw != null && Number(capRaw) > 0 ? Math.round(Number(capRaw)) : null;
    if (cap != null) captured += cap;

    if (s.refunded_amount_pence != null && Number(s.refunded_amount_pence) >= 0) {
      refunded += Math.round(Number(s.refunded_amount_pence));
    }
    if (s.released_amount_pence != null && Number(s.released_amount_pence) >= 0) {
      released += Math.round(Number(s.released_amount_pence));
    }

    const authRaw = s.total_authorised_amount_pence ?? s.authorised_amount_pence;
    const authorised = authRaw != null && Number.isFinite(Number(authRaw)) && Number(authRaw) >= 0
      ? Math.round(Number(authRaw))
      : null;
    const releasedAmt = s.released_amount_pence != null && Number.isFinite(Number(s.released_amount_pence))
      ? Math.round(Number(s.released_amount_pence))
      : null;
    const providerState = String(s.provider_state ?? "").toUpperCase();

    // Missing capture ← Payment Sessions evidence only (completed-trip session scope).
    if (cap == null) {
      if (
        providerState === "CAPTURED"
        || providerState === "COMPLETED"
        || (authorised != null && authorised > 0)
      ) {
        missingCaptures += 1;
      }
    }

    // Missing release ← actionable residual without confirmed amount (Slice 5).
    // AMOUNT_UNCONFIRMED is evidence-pending amount, not missing release action.
    const releaseStatus = classifyReleaseReconciliation({
      authorised_pence: authorised,
      captured_pence: cap,
      released_pence: releasedAmt,
      release_evidence_status: s.release_evidence_status != null
        ? String(s.release_evidence_status)
        : null,
      provider_state: providerState,
    });
    if (
      (
        releaseStatus === "MISSING_RELEASE"
        || releaseStatus === "RELEASE_PENDING"
        || releaseStatus === "RELEASE_SHORTFALL"
        || releaseStatus === "RELEASE_AMOUNT_UNKNOWN"
      )
      && authorised != null
      && cap != null
      && authorised > cap
    ) {
      missingReleases += 1;
    }

    const feeStatus = String(s.fee_status ?? "").toUpperCase();
    if (
      s.provider_processing_fee_pence != null
      && Number(s.provider_processing_fee_pence) >= 0
      && (feeStatus === "ACTUAL" || feeStatus === "CONFIRMED")
    ) {
      fees += Math.round(Number(s.provider_processing_fee_pence));
    }

    const breakdown = readPersistedCaptureBreakdown(s.metadata ?? null);
    if (breakdown?.expected_capture_pence != null) {
      fare += Math.max(0, breakdown.expected_capture_pence);
    }
    if (breakdown?.airport_charge_pence != null) {
      airportTotal += Math.max(0, breakdown.airport_charge_pence);
    }
    if (breakdown?.tip_pence != null) {
      tipsTotal += Math.max(0, breakdown.tip_pence);
    }
    if (
      breakdown?.capture_classification === "CAPTURE_SHORTFALL"
      || breakdown?.capture_classification === "UNEXPLAINED_SHORTFALL"
    ) {
      if (breakdown.variance_pence != null && breakdown.variance_pence < 0) {
        shortfall += Math.abs(breakdown.variance_pence);
      }
    }
    if (breakdown?.capture_classification === "UNEXPLAINED_OVERCAPTURE") {
      if (breakdown.variance_pence != null && breakdown.variance_pence > 0) {
        overcapture += breakdown.variance_pence;
      }
    }
  }

  return {
    completed_trip_fare_total_pence: fare,
    confirmed_provider_captured_total_pence: captured,
    refunded_total_pence: refunded,
    released_total_pence: released,
    provider_fee_total_pence: fees,
    capture_shortfall_pence: shortfall,
    overcapture_pence: overcapture,
    missing_captures_count: missingCaptures,
    missing_releases_count: missingReleases,
    airport_charges_total_pence: airportTotal,
    driver_tips_total_pence: tipsTotal,
  };
}

export * from "../../../functions/_shared/frTripAuditComparisonSSOT.ts";
