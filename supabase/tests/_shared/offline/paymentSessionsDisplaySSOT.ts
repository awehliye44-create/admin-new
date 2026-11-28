/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Payment Sessions (SSOT) display normalisation — user-facing labels + evidence rules.
 * Pure; no React money math. Amounts come from Phase 1A columns only.
 */

import { paymentResolutionUiLabel, type PaymentResolutionStatus, type PaymentResolutionType } from "../../../functions/_shared/finalFareAuthorisationSSOT.ts";

import { isValidConfirmedCapturePence } from "../../../functions/_shared/paymentCaptureEvidenceSSOT.ts";

import { isHealthyPostCaptureResidualRelease } from "../../../functions/_shared/paymentSessionsCaptureConfirmationSSOT.ts";

import {
  expectedResidualFromCoveragePence,
  resolveLocalConfirmedCoveragePence,
} from "../../../functions/_shared/authorisationProjectionSSOT.ts";
import { confirmedCapturedRevenuePence } from "../../../functions/_shared/paymentSessionsDisplaySSOT.ts";


/**
 * Captured column display.
 * - Confirmed amount → formatted money
 * - Authorised / pending (no capture yet) → "—" (never "Not recorded locally")
 * - Provider terminal capture without local amount → "Not recorded locally"
 */
export function formatCapturedAmountDisplay(args: {
  captured_amount_pence: number | null | undefined;
  currencyFormatter: (pence: number | null) => string;
  provider_state?: string | null;
  capture_classification?: string | null;
  session_status_display?: string | null;
}): string {
  const confirmed = confirmedCapturedRevenuePence({
    captured_amount_pence: args.captured_amount_pence,
  });
  if (confirmed != null) {
    return args.currencyFormatter(confirmed);
  }

  const provider = String(args.provider_state ?? "").trim().toUpperCase();
  const classification = String(args.capture_classification ?? "").trim().toUpperCase();
  const display = String(args.session_status_display ?? "").trim().toUpperCase();

  const authorisedOrPending =
    classification === "AUTHORISED_ACTIVE"
    || classification.includes("AUTHORISED")
    || provider === "AUTHORISED"
    || provider === "AUTHORIZED"
    || provider === "PENDING"
    || provider === "ACTIVE_AUTHORISED"
    || display === "AUTHORISED"
    || display === "CAPTURE_PENDING";

  if (authorisedOrPending) {
    return "—";
  }

  const providerSaysCaptured =
    provider === "CAPTURED"
    || provider === "COMPLETED"
    || classification.includes("CAPTURED")
    || classification.includes("CAPTURE_CONFIRMED")
    || display === "CAPTURED"
    || display === "CAPTURED_EVIDENCE_PENDING";

  if (providerSaysCaptured) {
    return "Not recorded locally";
  }

  return "—";
}

export * from "../../../functions/_shared/paymentSessionsDisplaySSOT.ts";
export * from "../../../../shared/edgePresentation/paymentSessionsDisplaySSOT.ts";
