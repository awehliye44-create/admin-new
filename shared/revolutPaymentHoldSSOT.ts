/**
 * P0 — Revolut payment hold SSOT.
 * Booking = pre-authorisation only. Capture only after trip completed.
 */

/** Canonical payment_session.status values (superset; DB may use legacy aliases). */
export type RevolutPaymentSessionStatus =
  | "created"
  | "checkout_open"
  | "authorising"
  | "authorised_hold"
  | "trip_created"
  | "dispatching"
  | "completed_pending_capture"
  | "captured"
  | "released"
  | "failed"
  | "abandoned"
  | "expired"
  | "orphan_authorisation"
  | "payment_shortfall"
  | "ADDITIONAL_AUTHORISATION_REQUIRED"
  | "ADDITIONAL_AUTHORISATION_PENDING"
  | "ADDITIONAL_AUTHORISATION_CONFIRMED"
  | "CAPTURE_LIMIT_EXCEEDED"
  | "PARTIAL_CAPTURE_ONLY"
  | "PAYMENT_RECOVERY_REQUIRED"
  | "CAPTURE_CONFIRMED"
  /** Legacy aliases kept for backward compatibility */
  | "pending_payment"
  | "payment_authorised"
  | "payment_orphaned"
  | "cancelled";

export type RevolutHoldAmountInput = {
  /** Fare after discounts (pence). */
  estimatedTotalPence: number;
  /** Preauth buffer from service_area_preauth_settings (pence). */
  bufferPence: number;
  /** Optional pass-through charges included in estimated total (pence). */
  passThroughChargesPence?: number;
};

export type RevolutHoldAmountResult = {
  estimated_total_pence: number;
  buffer_pence: number;
  hold_amount_pence: number;
};

export type RevolutCompletionCaptureInput = {
  finalFarePence: number;
  authorisedHoldPence: number;
  bufferPence: number;
};

export type RevolutCompletionCapturePlan =
  | {
      kind: "capture_within_hold";
      capture_amount_pence: number;
      release_remainder_pence: number;
    }
  | {
      kind: "rehold_required";
      new_hold_amount_pence: number;
      shortfall_pence: number;
    };

/** Shown on Revolut hosted checkout / wallet — never mention pre-auth or buffer. */
export const REVOLUT_CUSTOMER_CHECKOUT_DESCRIPTION = "ONECAB ride";

/** Customer-visible Revolut order description (internal hold/buffer stays in metadata only). */
export function revolutCustomerCheckoutDescription(tripId?: string | null): string {
  const ref = tripId?.trim();
  return ref ? `${REVOLUT_CUSTOMER_CHECKOUT_DESCRIPTION} ${ref}` : REVOLUT_CUSTOMER_CHECKOUT_DESCRIPTION;
}

/** hold_amount = round_up(estimated_total + buffer) — estimated_total already includes pass-through. */
export function computeRevolutHoldAmount(input: RevolutHoldAmountInput): RevolutHoldAmountResult {
  const estimated = Math.max(0, Math.round(input.estimatedTotalPence));
  const buffer = Math.max(0, Math.round(input.bufferPence));
  const hold = estimated + buffer;
  return {
    estimated_total_pence: estimated,
    buffer_pence: buffer,
    hold_amount_pence: hold,
  };
}

/** Completion: capture min(final_fare, hold); re-hold if final exceeds hold. */
export function planRevolutCompletionCapture(
  input: RevolutCompletionCaptureInput,
): RevolutCompletionCapturePlan {
  const finalFare = Math.max(0, Math.round(input.finalFarePence));
  const hold = Math.max(0, Math.round(input.authorisedHoldPence));
  const buffer = Math.max(0, Math.round(input.bufferPence));

  if (finalFare <= hold) {
    return {
      kind: "capture_within_hold",
      capture_amount_pence: finalFare,
      release_remainder_pence: Math.max(0, hold - finalFare),
    };
  }

  return {
    kind: "rehold_required",
    new_hold_amount_pence: finalFare + buffer,
    shortfall_pence: finalFare - hold,
  };
}

/** Map canonical status to persisted DB enum value. */
export function toDbPaymentSessionStatus(
  status: RevolutPaymentSessionStatus,
): string {
  switch (status) {
    case "created":
      return "pending_payment";
    case "checkout_open":
    case "authorising":
      return "authorising";
    case "authorised_hold":
      return "payment_authorised";
    case "orphan_authorisation":
      return "payment_orphaned";
    case "abandoned":
    case "expired":
    case "released":
      return "cancelled";
    default:
      return status;
  }
}

/** Normalise DB status to canonical for client/admin display. */
export function fromDbPaymentSessionStatus(
  status: string | null | undefined,
): RevolutPaymentSessionStatus {
  switch (status) {
    case "pending_payment":
      return "created";
    case "authorising":
      return "checkout_open";
    case "payment_authorised":
      return "authorised_hold";
    case "payment_orphaned":
      return "orphan_authorisation";
    case "cancelled":
      return "released";
    default:
      return (status as RevolutPaymentSessionStatus) ?? "created";
  }
}

export function isTerminalPaymentSessionStatus(status: string | null | undefined): boolean {
  const canonical = fromDbPaymentSessionStatus(status);
  return (
    canonical === "captured"
    || canonical === "released"
    || canonical === "failed"
    || canonical === "payment_shortfall"
    || canonical === "CAPTURE_CONFIRMED"
    || canonical === "PAYMENT_RECOVERY_REQUIRED"
    || canonical === "CAPTURE_LIMIT_EXCEEDED"
    || canonical === "PARTIAL_CAPTURE_ONLY"
  );
}

export function isAuthorisedHoldSessionStatus(status: string | null | undefined): boolean {
  const canonical = fromDbPaymentSessionStatus(status);
  return (
    canonical === "authorised_hold"
    || canonical === "trip_created"
    || canonical === "dispatching"
    || canonical === "completed_pending_capture"
  );
}

/** Session states that must never proceed to trip creation. */
export function isBlockedForTripCreateSessionStatus(status: string | null | undefined): boolean {
  const canonical = fromDbPaymentSessionStatus(status);
  return (
    canonical === "created"
    || canonical === "checkout_open"
    || canonical === "authorising"
    || canonical === "failed"
    || canonical === "abandoned"
    || canonical === "expired"
    || canonical === "released"
  );
}

export function isAbandonedOrCancelledSessionStatus(status: string | null | undefined): boolean {
  const canonical = fromDbPaymentSessionStatus(status);
  return (
    canonical === "abandoned"
    || canonical === "expired"
    || canonical === "released"
    || canonical === "failed"
    || canonical === "cancelled"
  );
}
