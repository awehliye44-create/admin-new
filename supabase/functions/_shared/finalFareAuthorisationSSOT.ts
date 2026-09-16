/**
 * P0 — Final fare vs authorisation SSOT.
 *
 * The original customer authorisation stays active until a canonical financial
 * outcome. Never release/cancel the hold merely because final fare changed.
 */

export const PAYMENT_RESOLUTION_TYPE = {
  FULL_CAPTURE: "FULL_CAPTURE",
  PARTIAL_CAPTURE_RELEASE_REMAINDER: "PARTIAL_CAPTURE_RELEASE_REMAINDER",
  ADDITIONAL_AUTHORISATION: "ADDITIONAL_AUTHORISATION",
  PAYMENT_RECOVERY: "PAYMENT_RECOVERY",
  NO_SHOW_FEE_CAPTURE: "NO_SHOW_FEE_CAPTURE",
  CANCELLATION_FEE_CAPTURE: "CANCELLATION_FEE_CAPTURE",
  FULL_RELEASE_ZERO_CHARGE: "FULL_RELEASE_ZERO_CHARGE",
} as const;

export type PaymentResolutionType =
  typeof PAYMENT_RESOLUTION_TYPE[keyof typeof PAYMENT_RESOLUTION_TYPE];

export const PAYMENT_RESOLUTION_STATUS = {
  ORIGINAL_AUTHORISATION_ACTIVE: "ORIGINAL_AUTHORISATION_ACTIVE",
  FINAL_FARE_CALCULATED: "FINAL_FARE_CALCULATED",
  AUTHORISATION_SUFFICIENCY_CHECK: "AUTHORISATION_SUFFICIENCY_CHECK",
  CAPTURE_PENDING: "CAPTURE_PENDING",
  ADDITIONAL_AUTHORISATION_PENDING: "ADDITIONAL_AUTHORISATION_PENDING",
  PAYMENT_RECOVERY_REQUIRED: "PAYMENT_RECOVERY_REQUIRED",
  PARTIALLY_CAPTURED: "PARTIALLY_CAPTURED",
  REMAINDER_RELEASED: "REMAINDER_RELEASED",
  FINANCIAL_COMPLETION: "FINANCIAL_COMPLETION",
} as const;

export type PaymentResolutionStatus =
  typeof PAYMENT_RESOLUTION_STATUS[keyof typeof PAYMENT_RESOLUTION_STATUS];

/** Sweep / release must not free a hold while money is still owed. */
export const HOLD_RELEASE_BLOCKED_PAYMENT_UNRESOLVED =
  "HOLD_RELEASE_BLOCKED_PAYMENT_UNRESOLVED" as const;

export type FinalFareAuthorisationMoney = {
  original_authorised_pence: number;
  additional_authorised_pence: number;
  total_authorised_pence: number;
  final_charge_pence: number;
  captured_pence: number;
  released_pence: number;
  shortfall_pence: number;
  no_show_fee_pence: number;
  cancellation_fee_pence: number;
};

export type FinalFareAuthorisationPlan = {
  payment_resolution_type: PaymentResolutionType;
  payment_resolution_status: PaymentResolutionStatus;
  recovery_required: boolean;
  /** Keep original provider hold — never cancel before capture/fee/recovery. */
  keep_original_hold: boolean;
  capture_from_original_pence: number;
  /** Second auth amount when final > original (shortfall only). */
  additional_authorisation_pence: number;
  release_remainder_pence: number;
  money: FinalFareAuthorisationMoney;
  ui_label: string;
};

function pence(n: number | null | undefined): number {
  return Math.max(0, Math.round(Number(n ?? 0)));
}

export function paymentResolutionUiLabel(
  type: PaymentResolutionType,
  status?: PaymentResolutionStatus | null,
): string {
  if (status === PAYMENT_RESOLUTION_STATUS.PAYMENT_RECOVERY_REQUIRED) {
    return "Payment recovery required";
  }
  if (status === PAYMENT_RESOLUTION_STATUS.ADDITIONAL_AUTHORISATION_PENDING) {
    return "Additional authorisation required";
  }
  switch (type) {
    case PAYMENT_RESOLUTION_TYPE.FULL_CAPTURE:
      return "Authorised";
    case PAYMENT_RESOLUTION_TYPE.PARTIAL_CAPTURE_RELEASE_REMAINDER:
      return "Partially captured — remainder released";
    case PAYMENT_RESOLUTION_TYPE.ADDITIONAL_AUTHORISATION:
      return "Additional authorisation required";
    case PAYMENT_RESOLUTION_TYPE.PAYMENT_RECOVERY:
      return "Payment recovery required";
    case PAYMENT_RESOLUTION_TYPE.NO_SHOW_FEE_CAPTURE:
      return "No-show fee captured";
    case PAYMENT_RESOLUTION_TYPE.CANCELLATION_FEE_CAPTURE:
      return "Cancellation fee captured";
    case PAYMENT_RESOLUTION_TYPE.FULL_RELEASE_ZERO_CHARGE:
      return "Fully released — no charge";
    default:
      return "Authorised";
  }
}

/**
 * Completion planner (A/B/C):
 * - equal → full capture
 * - lower → partial capture + release remainder (keep hold until capture)
 * - higher → keep original + additional auth for shortfall only (never cancel original first)
 */
export function planFinalFareAgainstAuthorisation(args: {
  originalAuthorisedPence: number;
  finalChargePence: number;
}): FinalFareAuthorisationPlan {
  const original = pence(args.originalAuthorisedPence);
  const finalCharge = pence(args.finalChargePence);

  if (finalCharge <= 0) {
    return {
      payment_resolution_type: PAYMENT_RESOLUTION_TYPE.FULL_RELEASE_ZERO_CHARGE,
      payment_resolution_status: PAYMENT_RESOLUTION_STATUS.FINANCIAL_COMPLETION,
      recovery_required: false,
      keep_original_hold: true,
      capture_from_original_pence: 0,
      additional_authorisation_pence: 0,
      release_remainder_pence: original,
      money: {
        original_authorised_pence: original,
        additional_authorised_pence: 0,
        total_authorised_pence: original,
        final_charge_pence: 0,
        captured_pence: 0,
        released_pence: original,
        shortfall_pence: 0,
        no_show_fee_pence: 0,
        cancellation_fee_pence: 0,
      },
      ui_label: paymentResolutionUiLabel(PAYMENT_RESOLUTION_TYPE.FULL_RELEASE_ZERO_CHARGE),
    };
  }

  if (finalCharge === original) {
    return {
      payment_resolution_type: PAYMENT_RESOLUTION_TYPE.FULL_CAPTURE,
      payment_resolution_status: PAYMENT_RESOLUTION_STATUS.FINANCIAL_COMPLETION,
      recovery_required: false,
      keep_original_hold: true,
      capture_from_original_pence: finalCharge,
      additional_authorisation_pence: 0,
      release_remainder_pence: 0,
      money: {
        original_authorised_pence: original,
        additional_authorised_pence: 0,
        total_authorised_pence: original,
        final_charge_pence: finalCharge,
        captured_pence: finalCharge,
        released_pence: 0,
        shortfall_pence: 0,
        no_show_fee_pence: 0,
        cancellation_fee_pence: 0,
      },
      ui_label: "Authorised",
    };
  }

  if (finalCharge < original) {
    const released = original - finalCharge;
    return {
      payment_resolution_type: PAYMENT_RESOLUTION_TYPE.PARTIAL_CAPTURE_RELEASE_REMAINDER,
      payment_resolution_status: PAYMENT_RESOLUTION_STATUS.FINANCIAL_COMPLETION,
      recovery_required: false,
      keep_original_hold: true,
      capture_from_original_pence: finalCharge,
      additional_authorisation_pence: 0,
      release_remainder_pence: released,
      money: {
        original_authorised_pence: original,
        additional_authorised_pence: 0,
        total_authorised_pence: original,
        final_charge_pence: finalCharge,
        captured_pence: finalCharge,
        released_pence: released,
        shortfall_pence: 0,
        no_show_fee_pence: 0,
        cancellation_fee_pence: 0,
      },
      ui_label: paymentResolutionUiLabel(
        PAYMENT_RESOLUTION_TYPE.PARTIAL_CAPTURE_RELEASE_REMAINDER,
      ),
    };
  }

  const shortfall = finalCharge - original;
  return {
    payment_resolution_type: PAYMENT_RESOLUTION_TYPE.ADDITIONAL_AUTHORISATION,
    payment_resolution_status: PAYMENT_RESOLUTION_STATUS.ADDITIONAL_AUTHORISATION_PENDING,
    recovery_required: false,
    keep_original_hold: true,
    capture_from_original_pence: original,
    additional_authorisation_pence: shortfall,
    release_remainder_pence: 0,
    money: {
      original_authorised_pence: original,
      additional_authorised_pence: shortfall,
      total_authorised_pence: original + shortfall,
      final_charge_pence: finalCharge,
      captured_pence: 0,
      released_pence: 0,
      shortfall_pence: shortfall,
      no_show_fee_pence: 0,
      cancellation_fee_pence: 0,
    },
    ui_label: paymentResolutionUiLabel(PAYMENT_RESOLUTION_TYPE.ADDITIONAL_AUTHORISATION),
  };
}

/** D — no-show fee from existing hold, then release remainder. */
export function planNoShowFeeAgainstAuthorisation(args: {
  originalAuthorisedPence: number;
  noShowFeePence: number;
}): FinalFareAuthorisationPlan {
  const original = pence(args.originalAuthorisedPence);
  const fee = pence(args.noShowFeePence);
  if (fee <= 0) {
    return planFinalFareAgainstAuthorisation({
      originalAuthorisedPence: original,
      finalChargePence: 0,
    });
  }
  if (fee > original) {
    const shortfall = fee - original;
    return {
      payment_resolution_type: PAYMENT_RESOLUTION_TYPE.ADDITIONAL_AUTHORISATION,
      payment_resolution_status: PAYMENT_RESOLUTION_STATUS.ADDITIONAL_AUTHORISATION_PENDING,
      recovery_required: false,
      keep_original_hold: true,
      capture_from_original_pence: original,
      additional_authorisation_pence: shortfall,
      release_remainder_pence: 0,
      money: {
        original_authorised_pence: original,
        additional_authorised_pence: shortfall,
        total_authorised_pence: original + shortfall,
        final_charge_pence: fee,
        captured_pence: 0,
        released_pence: 0,
        shortfall_pence: shortfall,
        no_show_fee_pence: fee,
        cancellation_fee_pence: 0,
      },
      ui_label: paymentResolutionUiLabel(PAYMENT_RESOLUTION_TYPE.ADDITIONAL_AUTHORISATION),
    };
  }
  const released = original - fee;
  return {
    payment_resolution_type: PAYMENT_RESOLUTION_TYPE.NO_SHOW_FEE_CAPTURE,
    payment_resolution_status: PAYMENT_RESOLUTION_STATUS.FINANCIAL_COMPLETION,
    recovery_required: false,
    keep_original_hold: true,
    capture_from_original_pence: fee,
    additional_authorisation_pence: 0,
    release_remainder_pence: released,
    money: {
      original_authorised_pence: original,
      additional_authorised_pence: 0,
      total_authorised_pence: original,
      final_charge_pence: fee,
      captured_pence: fee,
      released_pence: released,
      shortfall_pence: 0,
      no_show_fee_pence: fee,
      cancellation_fee_pence: 0,
    },
    ui_label: paymentResolutionUiLabel(PAYMENT_RESOLUTION_TYPE.NO_SHOW_FEE_CAPTURE),
  };
}

/** E — customer cancellation fee from existing hold. */
export function planCancellationFeeAgainstAuthorisation(args: {
  originalAuthorisedPence: number;
  cancellationFeePence: number;
}): FinalFareAuthorisationPlan {
  const plan = planNoShowFeeAgainstAuthorisation({
    originalAuthorisedPence: args.originalAuthorisedPence,
    noShowFeePence: args.cancellationFeePence,
  });
  if (plan.payment_resolution_type === PAYMENT_RESOLUTION_TYPE.NO_SHOW_FEE_CAPTURE) {
    return {
      ...plan,
      payment_resolution_type: PAYMENT_RESOLUTION_TYPE.CANCELLATION_FEE_CAPTURE,
      money: {
        ...plan.money,
        no_show_fee_pence: 0,
        cancellation_fee_pence: plan.money.final_charge_pence,
      },
      ui_label: paymentResolutionUiLabel(PAYMENT_RESOLUTION_TYPE.CANCELLATION_FEE_CAPTURE),
    };
  }
  if (plan.payment_resolution_type === PAYMENT_RESOLUTION_TYPE.FULL_RELEASE_ZERO_CHARGE) {
    return plan;
  }
  return {
    ...plan,
    money: {
      ...plan.money,
      no_show_fee_pence: 0,
      cancellation_fee_pence: pence(args.cancellationFeePence),
    },
  };
}

/** When additional auth needs SCA / remains pending / fails — keep original hold. */
export function markAdditionalAuthPendingOrRecovery(
  plan: FinalFareAuthorisationPlan,
  _outcome: "pending_sca" | "failed",
): FinalFareAuthorisationPlan {
  // Product rule C: SCA/pending and hard failure both require recovery; never cancel original.
  return {
    ...plan,
    payment_resolution_type: PAYMENT_RESOLUTION_TYPE.PAYMENT_RECOVERY,
    payment_resolution_status: PAYMENT_RESOLUTION_STATUS.PAYMENT_RECOVERY_REQUIRED,
    recovery_required: true,
    keep_original_hold: true,
    ui_label: paymentResolutionUiLabel(
      PAYMENT_RESOLUTION_TYPE.PAYMENT_RECOVERY,
      PAYMENT_RESOLUTION_STATUS.PAYMENT_RECOVERY_REQUIRED,
    ),
  };
}

export type SweepHoldReleaseGateInput = {
  tripStatus?: string | null;
  paymentHoldStatus?: string | null;
  paymentStatus?: string | null;
  paymentSessionStatus?: string | null;
  finalFarePence?: number | null;
  captureAmountPence?: number | null;
  capturedAmountPence?: number | null;
  authorisedAmountPence?: number | null;
  outstandingBalancePence?: number | null;
  noShowFeePence?: number | null;
  cancellationFeePence?: number | null;
  recoveryRequired?: boolean | null;
  additionalAuthStatus?: string | null;
  forceOrphanNoTrip?: boolean;
};

export type SweepHoldReleaseGateResult =
  | { allow: true }
  | {
      allow: false;
      code: typeof HOLD_RELEASE_BLOCKED_PAYMENT_UNRESOLVED;
      reason: string;
    };

/**
 * H — Sweep guard: block release when any amount remains payable / unresolved.
 */
export function gateHoldReleaseForUnresolvedPayment(
  input: SweepHoldReleaseGateInput,
): SweepHoldReleaseGateResult {
  if (input.forceOrphanNoTrip) return { allow: true };

  const tripStatus = String(input.tripStatus ?? "").toLowerCase();
  const sessionStatus = String(input.paymentSessionStatus ?? "").toLowerCase();
  const paymentStatus = String(input.paymentStatus ?? "").toLowerCase();
  const holdStatus = String(input.paymentHoldStatus ?? "").toLowerCase();
  const additional = String(input.additionalAuthStatus ?? "").toUpperCase();

  if (input.recoveryRequired === true) {
    return {
      allow: false,
      code: HOLD_RELEASE_BLOCKED_PAYMENT_UNRESOLVED,
      reason: "recovery_required",
    };
  }

  if (
    additional.includes("PAYMENT_RECOVERY")
    || additional.includes("ADDITIONAL_AUTHORISATION_REQUIRED")
    || additional.includes("ADDITIONAL_AUTHORISATION_PENDING")
    || sessionStatus.includes("payment_recovery")
    || sessionStatus.includes("additional_authorisation")
    || holdStatus === "payment_shortfall"
    || paymentStatus === "payment_shortfall"
  ) {
    return {
      allow: false,
      code: HOLD_RELEASE_BLOCKED_PAYMENT_UNRESOLVED,
      reason: "additional_auth_or_recovery_pending",
    };
  }

  const outstanding = pence(input.outstandingBalancePence);
  if (outstanding > 0) {
    return {
      allow: false,
      code: HOLD_RELEASE_BLOCKED_PAYMENT_UNRESOLVED,
      reason: "outstanding_balance",
    };
  }

  const finalFare = pence(input.finalFarePence);
  const noShowFee = pence(input.noShowFeePence);
  const cancelFee = pence(input.cancellationFeePence);
  const owed = Math.max(finalFare, noShowFee, cancelFee, pence(input.captureAmountPence));
  const captured = Math.max(
    pence(input.capturedAmountPence),
    paymentStatus === "captured" || holdStatus === "captured" ? owed : 0,
  );

  const completedLike =
    tripStatus === "completed"
    || tripStatus === "no_show"
    || tripStatus.includes("cancel");

  if (completedLike && owed > 0 && captured < owed) {
    return {
      allow: false,
      code: HOLD_RELEASE_BLOCKED_PAYMENT_UNRESOLVED,
      reason: "completed_trip_unresolved_capture",
    };
  }

  return { allow: true };
}

/**
 * Display rule: intentional hold release must not show Cancelled.
 * Provider CANCELLED without capture + with released_at / release amount → RELEASED.
 */
export function isGenuinePaymentCancellation(args: {
  rawSessionStatus?: string | null;
  providerState?: string | null;
  capturedAmountPence?: number | null;
  releasedAmountPence?: number | null;
  releasedAt?: string | null;
  holdTerminalReason?: string | null;
  paymentResolutionType?: string | null;
}): boolean {
  const resolution = String(args.paymentResolutionType ?? "").toUpperCase();
  if (
    resolution === PAYMENT_RESOLUTION_TYPE.FULL_RELEASE_ZERO_CHARGE
    || resolution === PAYMENT_RESOLUTION_TYPE.PARTIAL_CAPTURE_RELEASE_REMAINDER
    || resolution === PAYMENT_RESOLUTION_TYPE.NO_SHOW_FEE_CAPTURE
    || resolution === PAYMENT_RESOLUTION_TYPE.CANCELLATION_FEE_CAPTURE
    || resolution === PAYMENT_RESOLUTION_TYPE.FULL_CAPTURE
  ) {
    return false;
  }

  if (args.releasedAt || pence(args.releasedAmountPence) > 0) {
    // Intentional release path — not a payment cancellation.
    if (pence(args.capturedAmountPence) > 0) return false;
    const reason = String(args.holdTerminalReason ?? "").toUpperCase();
    if (
      reason.includes("ZERO_CHARGE")
      || reason.includes("SWEEP")
      || reason.includes("CANCEL_FEE")
      || reason.includes("NO_SHOW")
      || reason.includes("RELEASE")
      || reason.includes("EXPIRED_SEARCH")
    ) {
      return false;
    }
  }

  const raw = String(args.rawSessionStatus ?? "").toLowerCase();
  const provider = String(args.providerState ?? "").toUpperCase();
  // Genuine cancel: provider cancelled with no release evidence and no capture.
  return (
    (raw === "cancelled" || provider === "CANCELLED" || provider === "CANCELED")
    && !args.releasedAt
    && pence(args.releasedAmountPence) === 0
    && pence(args.capturedAmountPence) === 0
  );
}

/** Patch for persisting FinalFareAuthorisationPlan money + resolution fields. */
export function buildPaymentResolutionPersistPatch(
  plan: FinalFareAuthorisationPlan,
  extras?: {
    provider_state?: string | null;
    captured_pence_override?: number | null;
    released_pence_override?: number | null;
  },
): Record<string, unknown> {
  const captured =
    extras?.captured_pence_override != null
      ? pence(extras.captured_pence_override)
      : plan.money.captured_pence;
  const released =
    extras?.released_pence_override != null
      ? pence(extras.released_pence_override)
      : plan.money.released_pence;

  const patch: Record<string, unknown> = {
    original_authorised_pence: plan.money.original_authorised_pence,
    additional_authorised_pence: plan.money.additional_authorised_pence,
    total_authorised_amount_pence: plan.money.total_authorised_pence,
    authorised_amount_pence: plan.money.original_authorised_pence,
    final_charge_pence: plan.money.final_charge_pence,
    shortfall_pence: plan.money.shortfall_pence,
    no_show_fee_pence: plan.money.no_show_fee_pence,
    cancellation_fee_pence: plan.money.cancellation_fee_pence,
    recovery_required: plan.recovery_required,
    payment_resolution_type: plan.payment_resolution_type,
    payment_resolution_status: plan.payment_resolution_status,
  };
  if (captured > 0) {
    patch.captured_amount_pence = captured;
  }
  if (
    released > 0
    || plan.payment_resolution_type === PAYMENT_RESOLUTION_TYPE.FULL_RELEASE_ZERO_CHARGE
  ) {
    patch.released_amount_pence = released;
  }
  if (extras?.provider_state != null) {
    patch.provider_state = extras.provider_state;
  }
  return patch;
}

/**
 * After recovery capture succeeds, original hold may be released safely.
 * Returns whether release of the original hold is now allowed.
 */
export function canReleaseOriginalHoldAfterRecovery(args: {
  recoveryCapturedPence: number;
  finalChargePence: number;
  originalHoldStillActive: boolean;
}): { allow: true; release_original: boolean } | { allow: false; reason: string } {
  const recovered = pence(args.recoveryCapturedPence);
  const finalCharge = pence(args.finalChargePence);
  if (recovered <= 0) {
    return { allow: false, reason: "recovery_not_captured" };
  }
  if (recovered < finalCharge) {
    return { allow: false, reason: "recovery_short_of_final_charge" };
  }
  return {
    allow: true,
    release_original: args.originalHoldStillActive,
  };
}

/** Idempotent capture decision — same inputs → same capture/release amounts. */
export function idempotentCaptureReleaseDecision(args: {
  originalAuthorisedPence: number;
  finalChargePence: number;
  alreadyCapturedPence?: number | null;
  alreadyReleasedPence?: number | null;
}): {
  capture_pence: number;
  release_pence: number;
  already_complete: boolean;
  plan: FinalFareAuthorisationPlan;
} {
  const plan = planFinalFareAgainstAuthorisation({
    originalAuthorisedPence: args.originalAuthorisedPence,
    finalChargePence: args.finalChargePence,
  });
  const alreadyCaptured = pence(args.alreadyCapturedPence);
  const alreadyReleased = pence(args.alreadyReleasedPence);
  const needCapture = Math.max(0, plan.money.captured_pence - alreadyCaptured);
  const needRelease = Math.max(0, plan.money.released_pence - alreadyReleased);
  const alreadyComplete =
    alreadyCaptured >= plan.money.captured_pence
    && alreadyReleased >= plan.money.released_pence;
  return {
    capture_pence: alreadyComplete ? 0 : needCapture,
    release_pence: alreadyComplete ? 0 : needRelease,
    already_complete: alreadyComplete,
    plan,
  };
}
