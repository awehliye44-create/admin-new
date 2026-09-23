/**
 * Customer Receivable SSOT — pure planners (no I/O).
 *
 * DECLINED ADDITIONAL AUTHORISATION
 * → OPEN receivable
 * → RESERVE FOR NEXT BOOKING (before provider call)
 * → FOLD INTO NEXT PREAUTHORISATION
 * → PROVIDER-CONFIRMED CAPTURE (COMPLETED/CAPTURED + GET amount)
 * → CLEAR (SETTLED) EXACTLY ONCE / PARTIAL reopen
 *
 * Policy A: genuine waiting stays in earned fare / driver TEN.
 * Do not alter existing TEN rows. Do not create standalone Revolut
 * payments for micro receivables. Do not apply wallet −25p repair.
 * Recovery creates no second TEN / commission / payout.
 */

export const CUSTOMER_RECEIVABLE_SOURCE_TYPE = {
  DECLINED_INCREMENTAL_AUTHORISATION: "DECLINED_INCREMENTAL_AUTHORISATION",
  CAPTURE_SHORTFALL: "CAPTURE_SHORTFALL",
  MANUAL: "MANUAL",
} as const;

export const CUSTOMER_RECEIVABLE_REASON = {
  PICKUP_WAITING_DECLINED: "PICKUP_WAITING_DECLINED",
  FARE_INCREMENT_DECLINED: "FARE_INCREMENT_DECLINED",
  CAPTURE_SHORTFALL: "CAPTURE_SHORTFALL",
} as const;

export const CUSTOMER_RECEIVABLE_STATUS = {
  OPEN: "OPEN",
  RESERVED: "RESERVED",
  SETTLED: "SETTLED",
  WAIVED: "WAIVED",
  MANUAL_REVIEW: "MANUAL_REVIEW",
} as const;

export const CUSTOMER_RECEIVABLE_EVENT = {
  CREATED: "CREATED",
  RESERVED: "RESERVED",
  RELEASED: "RELEASED",
  SETTLED: "SETTLED",
  WAIVED: "WAIVED",
  MANUAL_REVIEW: "MANUAL_REVIEW",
  AMOUNT_ADJUSTED: "AMOUNT_ADJUSTED",
  PARTIAL_SETTLED: "PARTIAL_SETTLED",
} as const;

export const ALLOCATION_STATUS = {
  RESERVED: "RESERVED",
  CAPTURED: "CAPTURED",
  RELEASED: "RELEASED",
  PARTIAL: "PARTIAL",
} as const;

/** Typed persistence failure — never soft-swallow create failures. */
export const RECEIVABLE_PERSISTENCE_UNAVAILABLE =
  "RECEIVABLE_PERSISTENCE_UNAVAILABLE" as const;

export type ReceivablePersistenceUnavailableError = {
  code: typeof RECEIVABLE_PERSISTENCE_UNAVAILABLE;
  message: string;
  manual_review: true;
  decline_evidence_retained: true;
};

export function makeReceivablePersistenceUnavailable(
  message: string,
): ReceivablePersistenceUnavailableError {
  return {
    code: RECEIVABLE_PERSISTENCE_UNAVAILABLE,
    message,
    manual_review: true,
    decline_evidence_retained: true,
  };
}

/** Policy A — no TEN / commission / payout side-effects from recovery. */
export const TEN_REPAIR_FORBIDDEN = true as const;
export const POLICY_A = {
  TEN_REPAIR_FORBIDDEN,
  NO_SECOND_TEN_FROM_RECOVERY: true as const,
  NO_SECOND_COMMISSION_FROM_RECOVERY: true as const,
  NO_PAYOUT_FROM_RECOVERY: true as const,
  DRIVER_ENTITLEMENT: "PLATFORM_FRONTS_EARNED_WAITING" as const,
} as const;

/**
 * Proven preauth ordering — lock tests assert this sequence.
 * create session → lock → select OPEN → RESERVED allocations → commit
 * → fare+reserved → Revolut call
 */
export const PREAUTH_RECEIVABLE_ORDERING = [
  "CREATE_PENDING_PAYMENT_SESSION",
  "ACQUIRE_CUSTOMER_RECEIVABLE_LOCK",
  "SELECT_OPEN_RECEIVABLES_FOR_UPDATE",
  "CREATE_RESERVED_ALLOCATIONS",
  "COMMIT_DURABLE_RESERVATION",
  "CALCULATE_FARE_PLUS_RESERVED",
  "CALL_REVOLUT_PREAUTH",
] as const;

export type CustomerReceivableStatus =
  (typeof CUSTOMER_RECEIVABLE_STATUS)[keyof typeof CUSTOMER_RECEIVABLE_STATUS];

function positivePence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function nonNegPence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/** Idempotent key for one open declined-waiting receivable per trip. */
export function buildDeclinedWaitingReceivableIdempotencyKey(tripId: string): string {
  return `receivable:trip:${tripId}:declined_waiting_v1`;
}

/**
 * Canonical outstanding from performed fare vs provider-confirmed capture.
 * Never invents capture from fare alone.
 */
export function computeDeclinedIncrementReceivablePence(args: {
  final_fare_pence?: number | null;
  captured_pence?: number | null;
  shortfall_pence?: number | null;
}): number {
  const shortfall = positivePence(args.shortfall_pence);
  if (shortfall > 0) return shortfall;
  const due = nonNegPence(args.final_fare_pence);
  const captured = nonNegPence(args.captured_pence);
  if (captured <= 0 || due <= captured) return 0;
  return due - captured;
}

export type CreateReceivablePlan = {
  should_create: boolean;
  customer_id: string;
  source_trip_id: string;
  source_payment_session_id: string | null;
  source_authorisation_id: string | null;
  source_type: string;
  reason_code: string;
  original_amount_pence: number;
  outstanding_amount_pence: number;
  currency: string;
  idempotency_key: string;
  metadata: Record<string, unknown>;
  reject_reason: string | null;
};

export function planCreateReceivableFromDeclinedIncrement(args: {
  customer_id?: string | null;
  source_trip_id?: string | null;
  source_payment_session_id?: string | null;
  source_authorisation_id?: string | null;
  final_fare_pence?: number | null;
  captured_pence?: number | null;
  shortfall_pence?: number | null;
  currency?: string | null;
  pickup_waiting_charge_pence?: number | null;
  provider_state?: string | null;
}): CreateReceivablePlan {
  const customerId = String(args.customer_id ?? "").trim();
  const tripId = String(args.source_trip_id ?? "").trim();
  const amount = computeDeclinedIncrementReceivablePence(args);
  const providerUnknown =
    String(args.provider_state ?? "").trim().toUpperCase() === "UNKNOWN";

  const base = {
    customer_id: customerId,
    source_trip_id: tripId,
    source_payment_session_id: args.source_payment_session_id ?? null,
    source_authorisation_id: args.source_authorisation_id ?? null,
    source_type: CUSTOMER_RECEIVABLE_SOURCE_TYPE.DECLINED_INCREMENTAL_AUTHORISATION,
    reason_code: CUSTOMER_RECEIVABLE_REASON.PICKUP_WAITING_DECLINED,
    original_amount_pence: amount,
    outstanding_amount_pence: amount,
    currency: (args.currency ?? "gbp").toLowerCase(),
    idempotency_key: tripId ? buildDeclinedWaitingReceivableIdempotencyKey(tripId) : "",
    metadata: {
      final_fare_pence: nonNegPence(args.final_fare_pence),
      captured_pence: nonNegPence(args.captured_pence),
      shortfall_pence: amount,
      pickup_waiting_charge_pence: nonNegPence(args.pickup_waiting_charge_pence),
      recovery_mode: "next_booking_preauth_fold",
      standalone_revolut_charge_forbidden: true,
      ten_repair_forbidden: TEN_REPAIR_FORBIDDEN,
      policy_a: POLICY_A.DRIVER_ENTITLEMENT,
      no_second_ten: POLICY_A.NO_SECOND_TEN_FROM_RECOVERY,
      no_second_commission: POLICY_A.NO_SECOND_COMMISSION_FROM_RECOVERY,
      no_payout_from_recovery: POLICY_A.NO_PAYOUT_FROM_RECOVERY,
    },
  };

  if (!customerId || !tripId) {
    return { ...base, should_create: false, reject_reason: "missing_customer_or_trip" };
  }
  if (providerUnknown) {
    return { ...base, should_create: false, reject_reason: "provider_state_unknown" };
  }
  if (amount <= 0) {
    return { ...base, should_create: false, reject_reason: "zero_shortfall" };
  }
  return { ...base, should_create: true, reject_reason: null };
}

export type OpenReceivableRow = {
  id: string;
  customer_id: string;
  outstanding_amount_pence: number;
  status: string;
  currency: string;
  source_trip_id: string;
  idempotency_key: string;
  created_at?: string;
};

export type PreauthReceivableFoldPlan = {
  ride_fare_pence: number;
  buffer_pence: number;
  receivables_total_pence: number;
  /** ride + buffer + open receivables */
  authorised_amount_pence: number;
  receivable_ids: string[];
  allocations: Array<{ receivable_id: string; allocated_amount_pence: number }>;
};

/**
 * Ordering proof planner — returns the canonical step list callers must follow
 * before any Revolut preauth call. Does not perform I/O.
 */
export function planReserveBeforeProviderCall(args: {
  has_pending_payment_session: boolean;
  open_receivable_count: number;
}): {
  ok: boolean;
  steps: typeof PREAUTH_RECEIVABLE_ORDERING;
  must_persist_reservation_before_provider: true;
  reject_reason: string | null;
} {
  if (!args.has_pending_payment_session) {
    return {
      ok: false,
      steps: PREAUTH_RECEIVABLE_ORDERING,
      must_persist_reservation_before_provider: true,
      reject_reason: "pending_payment_session_required",
    };
  }
  return {
    ok: true,
    steps: PREAUTH_RECEIVABLE_ORDERING,
    must_persist_reservation_before_provider: true,
    reject_reason: null,
  };
}

/**
 * Fold OPEN customer receivables into the next booking preauth hold.
 * One provider authorisation covers ride + buffer + outstanding debt.
 * Currency isolation: when `currency` is set, only matching OPEN rows fold.
 */
export function planFoldReceivablesIntoPreauth(args: {
  ride_fare_pence: number;
  buffer_pence: number;
  open_receivables: OpenReceivableRow[];
  currency?: string | null;
}): PreauthReceivableFoldPlan {
  const ride = nonNegPence(args.ride_fare_pence);
  const buffer = nonNegPence(args.buffer_pence);
  const currencyFilter = args.currency
    ? String(args.currency).trim().toLowerCase()
    : null;
  const open = (args.open_receivables ?? [])
    .filter(
      (r) =>
        r.status === CUSTOMER_RECEIVABLE_STATUS.OPEN
        && positivePence(r.outstanding_amount_pence) > 0
        && (
          !currencyFilter
          || String(r.currency ?? "").trim().toLowerCase() === currencyFilter
        ),
    )
    .slice()
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const allocations = open.map((r) => ({
    receivable_id: r.id,
    allocated_amount_pence: positivePence(r.outstanding_amount_pence),
  }));
  const receivables_total_pence = allocations.reduce(
    (sum, a) => sum + a.allocated_amount_pence,
    0,
  );
  return {
    ride_fare_pence: ride,
    buffer_pence: buffer,
    receivables_total_pence,
    authorised_amount_pence: ride + buffer + receivables_total_pence,
    receivable_ids: allocations.map((a) => a.receivable_id),
    allocations,
  };
}

export type ProviderSettleEvidence = {
  orderId?: string | null;
  terminalState?: string | null;
  confirmedCapturedPence?: number | null;
  /** True only when amount came from provider GET (not capture POST alone). */
  amountFromProviderGet?: boolean | null;
};

/**
 * Settlement gate — MUST reject AUTHORISED / PROCESSING / UNKNOWN /
 * capture-POST-without-GET. Only COMPLETED|CAPTURED with confirmed amount settles.
 */
export function planSettleFromProviderEvidence(args: {
  evidence?: ProviderSettleEvidence | null;
  payment_session_id?: string | null;
}): {
  ok: boolean;
  reject_reason: string | null;
  terminal_state: string | null;
  confirmed_captured_pence: number;
  provider_order_id: string | null;
} {
  const ev = args.evidence ?? null;
  if (!ev) {
    return {
      ok: false,
      reject_reason: "provider_evidence_required",
      terminal_state: null,
      confirmed_captured_pence: 0,
      provider_order_id: null,
    };
  }
  const orderId = String(ev.orderId ?? "").trim();
  const terminal = String(ev.terminalState ?? "").trim().toUpperCase();
  const amount = nonNegPence(ev.confirmedCapturedPence);
  const fromGet = ev.amountFromProviderGet === true;

  if (!orderId) {
    return {
      ok: false,
      reject_reason: "provider_order_id_required",
      terminal_state: terminal || null,
      confirmed_captured_pence: amount,
      provider_order_id: null,
    };
  }
  if (terminal === "UNKNOWN") {
    return {
      ok: false,
      reject_reason: "provider_state_unknown",
      terminal_state: terminal,
      confirmed_captured_pence: amount,
      provider_order_id: orderId,
    };
  }
  if (terminal === "AUTHORISED" || terminal === "AUTHORIZED") {
    return {
      ok: false,
      reject_reason: "authorisation_does_not_settle",
      terminal_state: terminal,
      confirmed_captured_pence: amount,
      provider_order_id: orderId,
    };
  }
  if (terminal === "PROCESSING" || terminal === "PENDING") {
    return {
      ok: false,
      reject_reason: "processing_does_not_settle",
      terminal_state: terminal,
      confirmed_captured_pence: amount,
      provider_order_id: orderId,
    };
  }
  if (terminal !== "COMPLETED" && terminal !== "CAPTURED") {
    return {
      ok: false,
      reject_reason: "terminal_completed_or_captured_required",
      terminal_state: terminal || null,
      confirmed_captured_pence: amount,
      provider_order_id: orderId,
    };
  }
  if (!fromGet) {
    return {
      ok: false,
      reject_reason: "capture_post_alone_does_not_settle",
      terminal_state: terminal,
      confirmed_captured_pence: amount,
      provider_order_id: orderId,
    };
  }
  if (!args.payment_session_id) {
    return {
      ok: false,
      reject_reason: "payment_session_id_required",
      terminal_state: terminal,
      confirmed_captured_pence: amount,
      provider_order_id: orderId,
    };
  }
  return {
    ok: true,
    reject_reason: null,
    terminal_state: terminal,
    confirmed_captured_pence: amount,
    provider_order_id: orderId,
  };
}

export type PartialCaptureAllocationLine = {
  receivable_id: string;
  allocated_amount_pence: number;
  settle_pence: number;
  remaining_outstanding_pence: number;
  next_status: "SETTLED" | "OPEN";
};

/**
 * Partial capture allocation order:
 * historical receivables first (created_at ASC), then current trip fare.
 * Example: reserved debt 36, captured 20 → settle 20 of receivables,
 * leave 16 OPEN, trip fare gets 0.
 */
export function planPartialCaptureAllocation(args: {
  reserved_receivables: Array<{
    receivable_id: string;
    allocated_amount_pence: number;
    created_at?: string;
  }>;
  captured_pence: number;
  current_trip_fare_pence?: number | null;
}): {
  receivable_lines: PartialCaptureAllocationLine[];
  debt_settled_pence: number;
  debt_remaining_pence: number;
  current_trip_fare_allocation_pence: number;
} {
  const captured = nonNegPence(args.captured_pence);
  let remaining = captured;
  const sorted = (args.reserved_receivables ?? [])
    .slice()
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));

  const receivable_lines: PartialCaptureAllocationLine[] = [];
  for (const r of sorted) {
    const alloc = positivePence(r.allocated_amount_pence);
    const settle = Math.min(alloc, remaining);
    remaining -= settle;
    receivable_lines.push({
      receivable_id: r.receivable_id,
      allocated_amount_pence: alloc,
      settle_pence: settle,
      remaining_outstanding_pence: alloc - settle,
      next_status: alloc - settle === 0 ? "SETTLED" : "OPEN",
    });
  }
  const debt_settled_pence = receivable_lines.reduce((s, l) => s + l.settle_pence, 0);
  const debt_remaining_pence = receivable_lines.reduce(
    (s, l) => s + l.remaining_outstanding_pence,
    0,
  );
  const fareDue = nonNegPence(args.current_trip_fare_pence);
  const current_trip_fare_allocation_pence = Math.min(fareDue, remaining);
  return {
    receivable_lines,
    debt_settled_pence,
    debt_remaining_pence,
    current_trip_fare_allocation_pence,
  };
}

export type ReleaseOnCancelDecision =
  | { action: "RELEASE"; reason: string }
  | { action: "KEEP_RESERVED"; reason: string }
  | { action: "SETTLE"; reason: string };

/**
 * Cancel/release safety:
 * - no provider order → release
 * - definitive failed/cancelled/released with no capture → release
 * - UNKNOWN/timeout → KEEP reserved (reconcile same order)
 * - captured/completed → settle (not release)
 * Never create a replacement order.
 */
export function planReleaseOnCancel(args: {
  provider_order_id?: string | null;
  provider_state?: string | null;
  has_capture?: boolean | null;
}): ReleaseOnCancelDecision {
  const orderId = String(args.provider_order_id ?? "").trim();
  const state = String(args.provider_state ?? "").trim().toUpperCase();
  const hasCapture = args.has_capture === true;

  if (!orderId) {
    return { action: "RELEASE", reason: "no_provider_order" };
  }
  if (state === "UNKNOWN" || state === "" || state === "TIMEOUT") {
    return { action: "KEEP_RESERVED", reason: "provider_unknown_reconcile_only" };
  }
  if (hasCapture || state === "COMPLETED" || state === "CAPTURED") {
    return { action: "SETTLE", reason: "provider_captured_settle_not_release" };
  }
  if (
    state === "FAILED"
    || state === "CANCELLED"
    || state === "CANCELED"
    || state === "RELEASED"
    || state === "DECLINED"
  ) {
    return { action: "RELEASE", reason: "provider_definitive_failed_or_cancelled" };
  }
  // AUTHORISED / PROCESSING / PENDING — keep reserved until release evidence.
  return { action: "KEEP_RESERVED", reason: "non_terminal_keep_reserved" };
}

export function sumOpenReceivablePence(rows: OpenReceivableRow[]): number {
  return rows
    .filter((r) =>
      r.status === CUSTOMER_RECEIVABLE_STATUS.OPEN
      || r.status === CUSTOMER_RECEIVABLE_STATUS.RESERVED
    )
    .reduce((s, r) => s + positivePence(r.outstanding_amount_pence), 0);
}

/** MK-012 + MK-017 fixture helper for lock tests / backfill preview. */
export function sumFixtureOutstandingPence(args: {
  mk012_outstanding_pence: number;
  mk017_outstanding_pence: number;
}): number {
  return positivePence(args.mk012_outstanding_pence)
    + positivePence(args.mk017_outstanding_pence);
}
