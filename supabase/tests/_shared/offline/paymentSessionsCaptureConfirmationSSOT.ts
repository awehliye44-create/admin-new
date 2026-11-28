/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Payment Sessions (SSOT) — capture confirmation vs canonical payable.
 * Provider evidence wins over stale/null local projections.
 * MANUAL_REVIEW only for real unresolved contradictions.
 */

import {
  confirmedPositiveCapturePence,
  isValidConfirmedCapturePence,
} from "../../../functions/_shared/paymentCaptureEvidenceSSOT.ts";
import { PaymentSessionCaptureClassificationStatus, PAYMENT_SESSION_CAPTURE_CLASSIFICATION } from "../../../functions/_shared/paymentSessionsCaptureConfirmationSSOT.ts";


/**
 * CAPTURED_CONFIRMED ≠ SETTLED_CONFIRMED.
 * Early withdrawal eligibility must use finance-cleared / settled earnings — never capture alone.
 */
export function earlyCashOutRequiresSettledNotMerelyCaptured(args: {
  captureClassification: PaymentSessionCaptureClassificationStatus;
  financeClearedPence?: number | null;
  settledConfirmed?: boolean;
}): {
  capture_confirmed: boolean;
  settled_confirmed: boolean;
  early_cash_out_may_use_capture_alone: false;
  early_cash_out_eligible_from_settlement: boolean;
} {
  const captureConfirmed =
    args.captureClassification === PAYMENT_SESSION_CAPTURE_CLASSIFICATION.CAPTURED_CONFIRMED
    || args.captureClassification === PAYMENT_SESSION_CAPTURE_CLASSIFICATION.PARTIALLY_CAPTURED_CONFIRMED;
  const settled = args.settledConfirmed === true
    || (confirmedPositiveCapturePence(args.financeClearedPence) != null);
  return {
    capture_confirmed: captureConfirmed,
    settled_confirmed: settled,
    early_cash_out_may_use_capture_alone: false,
    early_cash_out_eligible_from_settlement: settled,
  };
}

export * from "../../../functions/_shared/paymentSessionsCaptureConfirmationSSOT.ts";
export * from "../../../../shared/edgePresentation/paymentSessionsCaptureConfirmationSSOT.ts";
