/**
 * Payment Sessions — additional authorisation when final fare exceeds hold (Slice 2).
 * Provider-confirmed amounts only. Replacement-hold semantics (not stacked concurrent holds).
 */

export const ADDITIONAL_AUTH_STATUS = {
  ADDITIONAL_AUTHORISATION_REQUIRED: "ADDITIONAL_AUTHORISATION_REQUIRED",
  ADDITIONAL_AUTHORISATION_PENDING: "ADDITIONAL_AUTHORISATION_PENDING",
  ADDITIONAL_AUTHORISATION_CONFIRMED: "ADDITIONAL_AUTHORISATION_CONFIRMED",
  CAPTURE_LIMIT_EXCEEDED: "CAPTURE_LIMIT_EXCEEDED",
  PARTIAL_CAPTURE_ONLY: "PARTIAL_CAPTURE_ONLY",
  PAYMENT_RECOVERY_REQUIRED: "PAYMENT_RECOVERY_REQUIRED",
  CAPTURE_CONFIRMED: "CAPTURE_CONFIRMED",
} as const;

export type AdditionalAuthStatus =
  typeof ADDITIONAL_AUTH_STATUS[keyof typeof ADDITIONAL_AUTH_STATUS];

export const ADDITIONAL_AUTH_SOURCE = {
  TRIP_COMPLETION_REHOLD: "trip_completion_rehold",
  TRIP_MOD_TOP_UP: "trip_mod_top_up",
  ADMIN_REFRESH: "admin_refresh",
} as const;

export type AdditionalAuthChildStatus =
  | "authorised"
  | "captured"
  | "released"
  | "superseded"
  | "failed";

/** Audit: whether final capture requires additional provider authorisation. */
export function classifyAdditionalAuthorisationNeed(args: {
  finalFarePence: number;
  authorisedHoldPence: number;
}): {
  required: boolean;
  shortfall_pence: number;
  status: AdditionalAuthStatus | "NOT_REQUIRED";
} {
  const finalFare = Math.max(0, Math.round(Number(args.finalFarePence ?? 0)));
  const hold = Math.max(0, Math.round(Number(args.authorisedHoldPence ?? 0)));
  if (finalFare <= hold) {
    return { required: false, shortfall_pence: 0, status: "NOT_REQUIRED" };
  }
  return {
    required: true,
    shortfall_pence: finalFare - hold,
    status: ADDITIONAL_AUTH_STATUS.ADDITIONAL_AUTHORISATION_REQUIRED,
  };
}

/**
 * Invariant: capture must not exceed total authorised unless provider explicitly supports it.
 * ONECAB does not support over-capture without a new authorisation.
 */
export function assertCaptureWithinTotalAuthorised(args: {
  totalAuthorisedPence: number;
  captureAmountPence: number;
}): { ok: true } | { ok: false; status: "CAPTURE_LIMIT_EXCEEDED"; excess_pence: number } {
  const total = Math.max(0, Math.round(Number(args.totalAuthorisedPence ?? 0)));
  const capture = Math.max(0, Math.round(Number(args.captureAmountPence ?? 0)));
  if (capture <= total) return { ok: true };
  return {
    ok: false,
    status: ADDITIONAL_AUTH_STATUS.CAPTURE_LIMIT_EXCEEDED,
    excess_pence: capture - total,
  };
}

/** Expected residual after capture — audit only; never store as confirmed release. */
export function expectedResidualAfterAdditionalAuth(args: {
  totalAuthorisedPence: number;
  capturedPence: number;
}): number {
  return Math.max(
    0,
    Math.round(Number(args.totalAuthorisedPence ?? 0)) - Math.round(Number(args.capturedPence ?? 0)),
  );
}

export function buildAdditionalAuthIdempotencyKey(args: {
  paymentSessionId: string;
  providerOrderId: string;
  phase: string;
}): string {
  return `addl_auth:${args.paymentSessionId}:${args.providerOrderId}:${args.phase}`;
}

/**
 * Replacement-hold parent total: use the new provider-confirmed hold amount only.
 * Do not SUM superseded/cancelled prior holds (would double-count).
 */
export function replacementTotalAuthorisedPence(args: {
  newProviderAuthorisedPence: number;
}): number {
  return Math.max(0, Math.round(Number(args.newProviderAuthorisedPence ?? 0)));
}

export function classifyPostAdditionalCapture(args: {
  totalAuthorisedPence: number;
  requiredCapturePence: number;
  actualCapturedPence: number;
}): AdditionalAuthStatus {
  const total = Math.max(0, Math.round(Number(args.totalAuthorisedPence ?? 0)));
  const required = Math.max(0, Math.round(Number(args.requiredCapturePence ?? 0)));
  const actual = Math.max(0, Math.round(Number(args.actualCapturedPence ?? 0)));

  if (actual <= 0) return ADDITIONAL_AUTH_STATUS.PAYMENT_RECOVERY_REQUIRED;
  if (actual < required) return ADDITIONAL_AUTH_STATUS.PARTIAL_CAPTURE_ONLY;
  if (actual > total) return ADDITIONAL_AUTH_STATUS.CAPTURE_LIMIT_EXCEEDED;
  return ADDITIONAL_AUTH_STATUS.CAPTURE_CONFIRMED;
}
