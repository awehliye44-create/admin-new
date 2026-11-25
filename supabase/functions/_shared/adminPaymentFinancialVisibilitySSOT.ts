/**
 * P3 Admin financial visibility — requested / authorised / confirmed / outstanding / refunded / recovery.
 * Display only; does not mutate money.
 */

import { classifyCaptureConfirmation } from "./captureConfirmationClassificationSSOT.ts";

export type AdminPaymentFinancialVisibility = {
  capture_requested_pence: number | null;
  capture_confirmed_pence: number | null;
  /** Legacy projection — may lag; not authoritative alone. */
  session_captured_amount_pence: number | null;
  provider_authorised_pence: number | null;
  payable_pence: number | null;
  outstanding_pence: number;
  refunded_pence: number;
  overcapture_pence: number;
  capture_confirmation_state: string | null;
  capture_class: string;
  recovery_required: boolean;
  fully_captured: boolean;
  partially_captured: boolean;
};

export function resolveAdminPaymentFinancialVisibility(input: {
  captureRequestedPence?: number | null;
  captureConfirmedPence?: number | null;
  sessionCapturedAmountPence?: number | null;
  providerAuthorisedPence?: number | null;
  payablePence?: number | null;
  refundedPence?: number | null;
  captureConfirmationState?: string | null;
  recoveryRequired?: boolean | null;
  paymentStatus?: string | null;
  noPaymentRequired?: boolean;
}): AdminPaymentFinancialVisibility {
  const confirmed = input.captureConfirmedPence != null
    ? Math.round(Number(input.captureConfirmedPence))
    : null;
  const payable = input.payablePence != null
    ? Math.round(Number(input.payablePence))
    : null;
  const classification = classifyCaptureConfirmation({
    payablePence: payable ?? 0,
    confirmedCapturedPence: confirmed,
    noPaymentRequired: input.noPaymentRequired === true ||
      (payable != null && payable === 0),
  });

  const recovery =
    input.recoveryRequired === true ||
    String(input.paymentStatus ?? "").toLowerCase() === "recovery_required" ||
    String(input.captureConfirmationState ?? "").toUpperCase() === "RECOVERY_REQUIRED";

  return {
    capture_requested_pence: input.captureRequestedPence == null
      ? null
      : Math.round(Number(input.captureRequestedPence)),
    capture_confirmed_pence: confirmed,
    session_captured_amount_pence: input.sessionCapturedAmountPence == null
      ? null
      : Math.round(Number(input.sessionCapturedAmountPence)),
    provider_authorised_pence: input.providerAuthorisedPence == null
      ? null
      : Math.round(Number(input.providerAuthorisedPence)),
    payable_pence: payable,
    outstanding_pence: classification.outstandingPence,
    refunded_pence: Math.max(0, Math.round(Number(input.refundedPence) || 0)),
    overcapture_pence: classification.overcapturePence,
    capture_confirmation_state: input.captureConfirmationState ?? null,
    capture_class: classification.class,
    recovery_required: recovery,
    fully_captured: classification.isFullyCaptured,
    partially_captured: classification.isPartiallyCaptured,
  };
}
