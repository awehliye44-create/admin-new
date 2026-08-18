/**
 * TEST SPEC of SQL `driver_wallet_resolve_economic_date` only.
 * Production Edge/Driver must call the SQL RPC — do not import this from I/O adapters.
 */

export const FINANCIAL_MODEL_PLATFORM_COLLECTED = "PLATFORM_COLLECTED";
export const FINANCIAL_MODEL_DRIVER_COLLECTED = "DRIVER_COLLECTED_COMMISSION_WALLET";
export const PAYMENT_SESSION_PURPOSE_RIDE_BOOKING = "RIDE_BOOKING";
export const PAYMENT_SESSION_PURPOSE_PAYMENT_RECOVERY = "PAYMENT_RECOVERY";

export type SpecPaymentSession = {
  purpose?: string | null;
  captured_at?: string | null;
  captured_amount_pence?: number | null;
  refunded_amount_pence?: number | null;
  released_amount_pence?: number | null;
  refunded_at?: string | null;
  released_at?: string | null;
  status?: string | null;
  provider_state?: string | null;
  provider_state_verified_at?: string | null;
  hold_release_state?: string | null;
};

export type SpecResolveInput = {
  type?: string | null;
  related_trip_id?: string | null;
  created_at?: string | null;
  financial_model?: string | null;
  sessions?: SpecPaymentSession[] | null;
};

export type SpecResolveResult = {
  economic_earned_at: string | null;
  posting_created_at: string | null;
  economic_date_status: string;
  captured_at: string | null;
};

function upper(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function isRefunded(s: SpecPaymentSession): boolean {
  if (s.refunded_at) return true;
  if (Math.max(0, Number(s.refunded_amount_pence ?? 0)) > 0) return true;
  return upper(s.status) === "REFUNDED";
}

function isReleased(s: SpecPaymentSession): boolean {
  if (s.released_at) return true;
  if (Math.max(0, Number(s.released_amount_pence ?? 0)) > 0) return true;
  if (upper(s.status) === "RELEASED") return true;
  return upper(s.hold_release_state).includes("RELEASE");
}

function isVerifiedTerminal(s: SpecPaymentSession): boolean {
  const state = upper(s.provider_state);
  if (state !== "COMPLETED" && state !== "CAPTURED") return false;
  return Boolean(String(s.provider_state_verified_at ?? "").trim());
}

export function specResolveEconomicDate(input: SpecResolveInput): SpecResolveResult {
  const posting = input.created_at ?? null;
  if (upper(input.type) !== "TRIP_EARNING_NET") {
    return {
      economic_earned_at: posting,
      posting_created_at: posting,
      economic_date_status: "POSTING_CREATED_AT",
      captured_at: null,
    };
  }
  if (!String(input.related_trip_id ?? "").trim()) {
    return {
      economic_earned_at: null,
      posting_created_at: posting,
      economic_date_status: "PAYMENT_SESSION_MISSING",
      captured_at: null,
    };
  }
  if (upper(input.financial_model) !== FINANCIAL_MODEL_PLATFORM_COLLECTED) {
    return {
      economic_earned_at: null,
      posting_created_at: posting,
      economic_date_status: "FINANCIAL_MODEL_MISMATCH",
      captured_at: null,
    };
  }

  const booking = (input.sessions ?? []).filter(
    (s) => upper(s.purpose) === PAYMENT_SESSION_PURPOSE_RIDE_BOOKING,
  );
  if (booking.length === 0) {
    return {
      economic_earned_at: null,
      posting_created_at: posting,
      economic_date_status: "PAYMENT_SESSION_MISSING",
      captured_at: null,
    };
  }

  if (booking.length > 1) {
    return {
      economic_earned_at: null,
      posting_created_at: posting,
      economic_date_status: "CAPTURE_AMBIGUOUS",
      captured_at: null,
    };
  }

  const live = booking.filter((s) =>
    Boolean(s.captured_at)
    && Math.round(Number(s.captured_amount_pence ?? 0)) > 0
    && !isRefunded(s)
    && !isReleased(s)
    && isVerifiedTerminal(s),
  );
  if (live.length === 1) {
    const captured = String(live[0]!.captured_at);
    return {
      economic_earned_at: captured,
      posting_created_at: posting,
      economic_date_status: "RESOLVED",
      captured_at: captured,
    };
  }

  const refunded = booking.some(isRefunded);
  const released = booking.some(isReleased);
  if (refunded && !released) {
    return {
      economic_earned_at: null,
      posting_created_at: posting,
      economic_date_status: "CAPTURE_REFUNDED",
      captured_at: null,
    };
  }
  if (released) {
    return {
      economic_earned_at: null,
      posting_created_at: posting,
      economic_date_status: "CAPTURE_RELEASED",
      captured_at: null,
    };
  }
  if (booking.some((s) => !s.captured_at)) {
    return {
      economic_earned_at: null,
      posting_created_at: posting,
      economic_date_status: "CAPTURE_TIMESTAMP_MISSING",
      captured_at: null,
    };
  }
  const unverified = booking.some((s) =>
    Boolean(s.captured_at)
    && Math.round(Number(s.captured_amount_pence ?? 0)) > 0
    && !isRefunded(s)
    && !isReleased(s)
    && !isVerifiedTerminal(s),
  );
  return {
    economic_earned_at: null,
    posting_created_at: posting,
    economic_date_status: unverified ? "CAPTURE_NOT_VERIFIED" : "PAYMENT_SESSION_MISSING",
    captured_at: null,
  };
}
