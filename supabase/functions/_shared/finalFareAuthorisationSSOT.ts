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

