/**
 * A8B28F shared SSOT — effective payout capability + destination outcomes.
 * Pure. No I/O. Used by Stage B Edge/client and Stage C SQL parity tests.
 */

export const PAYOUT_DESTINATION_OUTCOME = {
  DESTINATION_SAVED_AND_VERIFIED: "DESTINATION_SAVED_AND_VERIFIED",
  DESTINATION_SAVED_VERIFICATION_PENDING: "DESTINATION_SAVED_VERIFICATION_PENDING",
  DESTINATION_SAVED_VERIFICATION_FAILED: "DESTINATION_SAVED_VERIFICATION_FAILED",
  DESTINATION_SAVE_FAILED: "DESTINATION_SAVE_FAILED",
  DESTINATION_ALREADY_VERIFIED: "DESTINATION_ALREADY_VERIFIED",
  RETRY_REQUIRED: "RETRY_REQUIRED",
} as const;

export type PayoutDestinationOutcome =
  (typeof PAYOUT_DESTINATION_OUTCOME)[keyof typeof PAYOUT_DESTINATION_OUTCOME];

export const PROVIDER_LINK_FAILURE_CLASS = {
  RETRYABLE_TRANSIENT: "RETRYABLE_TRANSIENT",
  RETRYABLE_IDEMPOTENT_LOOKUP_REQUIRED: "RETRYABLE_IDEMPOTENT_LOOKUP_REQUIRED",
  USER_INPUT_CORRECTION_REQUIRED: "USER_INPUT_CORRECTION_REQUIRED",
  PROVIDER_CONFIGURATION_REQUIRED: "PROVIDER_CONFIGURATION_REQUIRED",
  DUPLICATE_COUNTERPARTY_RECONCILIATION_REQUIRED: "DUPLICATE_COUNTERPARTY_RECONCILIATION_REQUIRED",
  NON_RETRYABLE: "NON_RETRYABLE",
  UNRESOLVED_PROVIDER_CALL_REQUIRED: "UNRESOLVED_PROVIDER_CALL_REQUIRED",
} as const;

export type ProviderLinkFailureClass =
  (typeof PROVIDER_LINK_FAILURE_CLASS)[keyof typeof PROVIDER_LINK_FAILURE_CLASS];

export function httpStatusForOutcome(outcome: PayoutDestinationOutcome): number {
  switch (outcome) {
    case PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_AND_VERIFIED:
    case PAYOUT_DESTINATION_OUTCOME.DESTINATION_ALREADY_VERIFIED:
      return 200;
    case PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_PENDING:
      return 202;
    case PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED:
    case PAYOUT_DESTINATION_OUTCOME.RETRY_REQUIRED:
      return 422;
    default:
      return 400;
  }
}

export function isClientSuccessOutcome(outcome: PayoutDestinationOutcome): boolean {
  return (
    outcome === PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_AND_VERIFIED ||
    outcome === PAYOUT_DESTINATION_OUTCOME.DESTINATION_ALREADY_VERIFIED
  );
}

export function classifyCounterpartyCreateFailure(input: {
  provider_error_code?: string | null;
  http_status?: number | null;
  mentions_auth?: boolean;
  mentions_duplicate?: boolean;
  mentions_invalid_input?: boolean;
  mentions_transient?: boolean;
  mentions_unsupported?: boolean;
  mentions_malformed?: boolean;
  access_token_missing?: boolean;
}): ProviderLinkFailureClass {
  if (input.access_token_missing || input.provider_error_code === "ACCESS_TOKEN_MISSING") {
    return PROVIDER_LINK_FAILURE_CLASS.PROVIDER_CONFIGURATION_REQUIRED;
  }
  if (input.mentions_auth || input.http_status === 401 || input.http_status === 403) {
    return PROVIDER_LINK_FAILURE_CLASS.PROVIDER_CONFIGURATION_REQUIRED;
  }
  if (input.mentions_duplicate || input.http_status === 409) {
    return PROVIDER_LINK_FAILURE_CLASS.DUPLICATE_COUNTERPARTY_RECONCILIATION_REQUIRED;
  }
  if (
    input.mentions_invalid_input ||
    input.mentions_malformed ||
    input.http_status === 400 ||
    input.http_status === 422
  ) {
    return PROVIDER_LINK_FAILURE_CLASS.USER_INPUT_CORRECTION_REQUIRED;
  }
  if (input.mentions_unsupported) return PROVIDER_LINK_FAILURE_CLASS.NON_RETRYABLE;
  if (
    input.mentions_transient ||
    input.http_status === 429 ||
    input.http_status === 500 ||
    input.http_status === 502 ||
    input.http_status === 503
  ) {
    return PROVIDER_LINK_FAILURE_CLASS.RETRYABLE_TRANSIENT;
  }
  if (input.provider_error_code === "COUNTERPARTY_CREATE_FAILED" && input.http_status == null) {
    return PROVIDER_LINK_FAILURE_CLASS.UNRESOLVED_PROVIDER_CALL_REQUIRED;
  }
  return PROVIDER_LINK_FAILURE_CLASS.UNRESOLVED_PROVIDER_CALL_REQUIRED;
}

export function resolveSyncUkRevolutOutcome(args: {
  saveOk: boolean;
  linkStatus: string | null | undefined;
  verificationStatus: string | null | undefined;
  hasCounterpartyRef: boolean;
  hasRecipientRef: boolean;
}): PayoutDestinationOutcome {
  if (!args.saveOk) return PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVE_FAILED;
  const link = String(args.linkStatus ?? "").toUpperCase();
  const ver = String(args.verificationStatus ?? "").toUpperCase();
  if (
    link === "PROVIDER_VERIFIED" &&
    (ver === "PROVIDER_VERIFIED" || ver === "VERIFIED") &&
    args.hasCounterpartyRef &&
    args.hasRecipientRef
  ) {
    return PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_AND_VERIFIED;
  }
  if (link === "FAILED" || ver === "REJECTED") {
    return PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED;
  }
  if (link === "PROVIDER_VERIFIED" && args.hasCounterpartyRef && !args.hasRecipientRef) {
    return PAYOUT_DESTINATION_OUTCOME.RETRY_REQUIRED;
  }
  return PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_PENDING;
}

export function driverFacingMessageForOutcome(outcome: PayoutDestinationOutcome): string {
  switch (outcome) {
    case PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_AND_VERIFIED:
    case PAYOUT_DESTINATION_OUTCOME.DESTINATION_ALREADY_VERIFIED:
      return "Payout account verified. Withdrawals can use this account once funds are available.";
    case PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_PENDING:
      return "Payout account saved. Verification is still in progress.";
    case PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED:
      return "We saved your details but could not verify the payout account. Check the details and try again.";
    case PAYOUT_DESTINATION_OUTCOME.RETRY_REQUIRED:
      return "Verification could not be completed. Please try again in a moment.";
    default:
      return "We could not save your payout account. Check the details and try again.";
  }
}

/**
 * Authoritative effective withdraw permission (Option B).
 * Does NOT mutate legacy payouts_enabled.
 */
export function effectivePayoutAllowed(input: {
  global_payouts_enabled: boolean;
  provider_verified_active_destination: boolean;
  payout_operational_paused: boolean;
  driver_approved: boolean;
  driver_suspended: boolean;
}): {
  effective_payout_allowed: boolean;
  block_reason:
    | "NONE"
    | "FEATURE_DISABLED"
    | "ACCOUNT_UNVERIFIED"
    | "ADMIN_HOLD"
    | "DRIVER_SUSPENDED"
    | "DRIVER_NOT_APPROVED";
} {
  if (input.driver_suspended) {
    return { effective_payout_allowed: false, block_reason: "DRIVER_SUSPENDED" };
  }
  if (!input.driver_approved) {
    return { effective_payout_allowed: false, block_reason: "DRIVER_NOT_APPROVED" };
  }
  if (!input.global_payouts_enabled) {
    return { effective_payout_allowed: false, block_reason: "FEATURE_DISABLED" };
  }
  if (input.payout_operational_paused) {
    return { effective_payout_allowed: false, block_reason: "ADMIN_HOLD" };
  }
  if (!input.provider_verified_active_destination) {
    return { effective_payout_allowed: false, block_reason: "ACCOUNT_UNVERIFIED" };
  }
  return { effective_payout_allowed: true, block_reason: "NONE" };
}

/**
 * Balance presentation matrix cell (Stage C target semantics).
 * Available = cleared unpaid when NOT operationally paused (verification does not zero Available).
 * Withdrawable = Available>0 AND effective_payout_allowed AND >= minimum.
 * Pending = uncleared clearing only.
 */
export function balancePresentation(input: {
  cleared_pence: number;
  uncleared_pending_pence: number;
  payout_operational_paused: boolean;
  effective_payout_allowed: boolean;
  minimum_pence: number;
  block_reason: string;
}): {
  available_pence: number;
  pending_pence: number;
  withdrawable_pence: number;
  ui_reason: string;
} {
  if (input.payout_operational_paused) {
    return {
      available_pence: 0,
      pending_pence: Math.max(0, input.cleared_pence + input.uncleared_pending_pence),
      withdrawable_pence: 0,
      ui_reason: "Payouts temporarily paused",
    };
  }
  const available = Math.max(0, input.cleared_pence);
  const pending = Math.max(0, input.uncleared_pending_pence);
  const withdrawable =
    input.effective_payout_allowed && available >= Math.max(0, input.minimum_pence)
      ? available
      : 0;
  let ui_reason = "Ready";
  if (!input.effective_payout_allowed) {
    if (input.block_reason === "ACCOUNT_UNVERIFIED") {
      ui_reason = available > 0
        ? "Funds cleared — payout account verification required"
        : "Payout account verification required";
    } else if (input.block_reason === "FEATURE_DISABLED") {
      ui_reason = "Withdrawals not available";
    } else if (input.block_reason === "DRIVER_SUSPENDED" || input.block_reason === "DRIVER_NOT_APPROVED") {
      ui_reason = "Account restricted";
    } else {
      ui_reason = "Withdrawals not available";
    }
  } else if (available > 0 && available < Math.max(0, input.minimum_pence)) {
    ui_reason = "Funds cleared but below withdrawal minimum";
  } else if (available <= 0 && pending > 0) {
    ui_reason = "Funds clearing";
  } else if (available > 0) {
    ui_reason = "Available to withdraw";
  } else {
    ui_reason = "No funds available to withdraw";
  }
  return { available_pence: available, pending_pence: pending, withdrawable_pence: withdrawable, ui_reason };
}
