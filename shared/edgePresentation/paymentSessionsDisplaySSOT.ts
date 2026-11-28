/** Admin presentation-only helpers; not part of Edge uploads. */
/**
 * Payment Sessions (SSOT) display normalisation — user-facing labels + evidence rules.
 * Pure; no React money math. Amounts come from Phase 1A columns only.
 */

import { paymentResolutionUiLabel, type PaymentResolutionStatus, type PaymentResolutionType } from "../../supabase/functions/_shared/finalFareAuthorisationSSOT.ts";

import { isValidConfirmedCapturePence } from "../../supabase/functions/_shared/paymentCaptureEvidenceSSOT.ts";

import { isHealthyPostCaptureResidualRelease } from "../../supabase/functions/_shared/paymentSessionsCaptureConfirmationSSOT.ts";

import {
  expectedResidualFromCoveragePence,
  resolveLocalConfirmedCoveragePence,
} from "../../supabase/functions/_shared/authorisationProjectionSSOT.ts";
import { confirmedCapturedRevenuePence } from "../../supabase/functions/_shared/paymentSessionsDisplaySSOT.ts";


/**
 * Released column display.
 * Healthy post-capture residual (provider COMPLETED, capture confirmed, amount null)
 * must NOT show MANUAL_REVIEW_REQUIRED — that label is for real contradictions only.
 */
export function formatReleasedAmountDisplay(args: {
  released_amount_pence: number | null | undefined;
  released_at?: string | null;
  release_evidence_status?: string | null;
  currencyFormatter: (pence: number | null) => string;
  /** When true, residual null after capture is informational — not manual review. */
  captureConfirmed?: boolean;
  providerState?: string | null;
  capturedAmountPence?: number | null;
  expectedReleasePence?: number | null;
}): { primary: string; secondary: string | null } {
  const evidence = String(args.release_evidence_status ?? "").toUpperCase();
  const amountUnconfirmed =
    evidence === "AMOUNT_UNCONFIRMED"
    || Boolean(args.released_at && args.released_amount_pence == null);

  const healthyResidual = isHealthyPostCaptureResidualRelease({
    providerState: args.providerState,
    capturedAmountPence: args.capturedAmountPence,
    releasedAt: args.released_at,
    releasedAmountPence: args.released_amount_pence,
    releaseEvidenceStatus: args.release_evidence_status,
  }) || (
    args.captureConfirmed === true
    && args.released_amount_pence == null
    && (args.expectedReleasePence == null
      ? false
      : Math.round(Number(args.expectedReleasePence)) > 0)
    && (amountUnconfirmed || evidence === "" || evidence === "AMOUNT_UNCONFIRMED")
  );

  // Confirmed provider amount first.
  if (args.released_amount_pence != null && Number(args.released_amount_pence) > 0) {
    return {
      primary: args.currencyFormatter(Math.round(Number(args.released_amount_pence))),
      secondary: null,
    };
  }

  // Healthy post-capture residual (incl. missing evidence stamp) → show expected, not dash.
  if (healthyResidual || (amountUnconfirmed && args.captureConfirmed === true)) {
    const expected = args.expectedReleasePence == null
      ? null
      : Math.round(Number(args.expectedReleasePence));
    if (expected != null && expected > 0) {
      return {
        primary: args.currencyFormatter(expected),
        secondary: "Expected residual — amount not confirmed by provider",
      };
    }
    return {
      primary: "Auto-voided",
      secondary: "Local record reconciled — residual release amount not explicit from provider",
    };
  }

  if (amountUnconfirmed) {
    return {
      primary: "MANUAL_REVIEW_REQUIRED",
      secondary: "Unresolved release amount — provider evidence contradictory or missing",
    };
  }
  if (args.released_amount_pence == null) {
    return { primary: "—", secondary: null };
  }
  return {
    primary: args.currencyFormatter(Math.round(Number(args.released_amount_pence))),
    secondary: null,
  };
}


/** Row-level expected residual for Released column display. */
export function expectedResidualReleasePenceForRow(row: {
  authorised_amount_pence?: number | null;
  total_authorised_amount_pence?: number | null;
  captured_amount_pence?: number | null;
}): number | null {
  const cap = confirmedCapturedRevenuePence(row);
  return expectedResidualFromCoveragePence({
    coveragePence: resolveLocalConfirmedCoveragePence(row),
    capturedPence: cap,
  });
}

export * from "../../supabase/functions/_shared/paymentSessionsDisplaySSOT.ts";
