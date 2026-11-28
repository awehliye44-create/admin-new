/** Admin presentation-only helpers; not part of Edge uploads. */
/**
 * Payment Sessions (SSOT) — capture confirmation vs canonical payable.
 * Provider evidence wins over stale/null local projections.
 * MANUAL_REVIEW only for real unresolved contradictions.
 */

import {
  confirmedPositiveCapturePence,
  isValidConfirmedCapturePence,
} from "../../supabase/functions/_shared/paymentCaptureEvidenceSSOT.ts";


export function collectOutstandingActionLabel(outstandingPence: number): string {
  const major = (Math.round(outstandingPence) / 100).toFixed(2);
  return `Collect Outstanding £${major}`;
}


export function sendPaymentLinkActionLabel(outstandingPence: number): string {
  const major = (Math.round(outstandingPence) / 100).toFixed(2);
  return `Send Payment Link £${major}`;
}

export * from "../../supabase/functions/_shared/paymentSessionsCaptureConfirmationSSOT.ts";
