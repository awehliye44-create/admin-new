/**
 * Temporary Step 4F.1 dry-run recovery for MK-260817-007 and MK-260817-009 only.
 *
 * Live credits are disabled in this module. No provider, FR, payout, Commission
 * Wallet, or settlement-recalculation ownership. Credit source is the saved
 * corrected driver_net_pence stamp after hardcoded expected-stamp match.
 */

export const MK007_ID = "8b39acc6-91d0-43cb-b20a-49d9ef0feebd";
export const MK009_ID = "be49d383-6a8b-4cb0-9da3-2bec9d496d93";
export const MK008_ID = "3b48b86c-9ebf-407e-bb8b-a51ad2e75edc";
export const APPROVED_DRIVER_ID = "cd8bae4c-3827-4b90-98c6-10be70eb0e52";

export const APPROVED_MK007_MK009_TRIP_IDS = [MK007_ID, MK009_ID] as const;

export const PAYOUT_CLEARING_DELAY_HOURS = 27;

export const RECOVERY_AUDIT_REASON = "VERIFIED_CAPTURE_MISSING_TRIP_EARNING_NET_MK007_MK009";

export type ExpectedStamp = {
  trip_code: string;
  commissionable_fare_pence: number;
  commission_pence: number;
  driver_net_pence: number;
  applied_customer_promotion_pence: number;
  commission_after_promotion_pence: number;
  final_fare_pence: number;
  captured_amount_pence: number;
  accepted_commission_percent: number;
};

export const EXPECTED_STAMPS: Record<string, ExpectedStamp> = {
  [MK007_ID]: {
    trip_code: "MK-260817-007",
    commissionable_fare_pence: 500,
    commission_pence: 75,
    driver_net_pence: 425,
    applied_customer_promotion_pence: 20,
    commission_after_promotion_pence: 55,
    final_fare_pence: 480,
    captured_amount_pence: 480,
    accepted_commission_percent: 15,
  },
  [MK009_ID]: {
    trip_code: "MK-260817-009",
    commissionable_fare_pence: 831,
    commission_pence: 125,
    driver_net_pence: 706,
    applied_customer_promotion_pence: 33,
    commission_after_promotion_pence: 92,
    final_fare_pence: 798,
    captured_amount_pence: 798,
    accepted_commission_percent: 15,
  },
};

export const TRIP_SELECT =
  "id, trip_code, status, driver_id, financial_model, driver_net_pence, airport_charge_pence, " +
  "commission_pct, accepted_commission_percent, commissionable_fare_pence, commission_pence, " +
  "final_fare_pence, offer_discount_pence, fare_snapshot_json, currency_code, currency";

export const PS_SELECT =
  "id, trip_id, purpose, status, provider_state, provider_state_verified_at, captured_amount_pence, " +
  "captured_at, provider_order_id, provider_capture_id, refunded_amount_pence, released_amount_pence, " +
  "hold_release_state, financial_operation_state, provider_refund_id, released_at, refunded_at";

export type PaymentSessionRow = Record<string, unknown>;
export type TripRow = Record<string, unknown>;

export type DryRunEligible = {
  status: "DRY_RUN_ELIGIBLE";
  tripId: string;
  tripCode: string;
  dryRun: true;
  saved_driver_entitlement_pence: number;
  payment_session_id: string;
  payment_session_status: string;
  payment_session_lifecycle_mismatch: boolean;
  payment_session_finalization_required_before_credit: boolean;
  provider_state: string;
  provider_state_verified_at: string;
  captured_amount_pence: number;
  captured_at: string;
  provider_order_id: string;
  provider_capture_id: string;
  existing_wallet_count: number;
  existing_wallet_amount_pence: number;
  proposed_amount_pence: number;
  proposed_ledger_type: "TRIP_EARNING_NET";
  posting_created_at: null;
  posting_created_at_projection: "future_execution_timestamp";
  economic_earned_at: string;
  eligible_at: string;
  eligibility_origin: "captured_at_plus_27h";
  provider_operation_required: false;
  settlement_recalculation_required: false;
  driver_id: string;
};

export type RecoveryResult =
  | { status: "NOT_IN_ALLOW_LIST"; tripId: string; tripCode: null; dryRun: true }
  | { status: "TRIP_NOT_FOUND"; tripId: string; tripCode: null; dryRun: true }
  | { status: "DRIVER_MISMATCH"; tripId: string; tripCode: string | null; dryRun: true; driver_id: string }
  | { status: "FINANCIAL_MODEL_VIOLATION"; tripId: string; tripCode: string | null; dryRun: true; financial_model: string }
  | {
    status: "SETTLEMENT_STAMP_MISMATCH";
    tripId: string;
    tripCode: string | null;
    dryRun: true;
    reason: string;
    expected: ExpectedStamp;
    actual: Record<string, unknown>;
  }
  | { status: "PAYMENT_SESSION_NOT_FOUND"; tripId: string; tripCode: string | null; dryRun: true }
  | { status: "PAYMENT_SESSION_BLOCKED"; tripId: string; tripCode: string | null; dryRun: true; reason: string }
  | { status: "ALREADY_CREDITED"; tripId: string; tripCode: string | null; dryRun: true; credited_pence: number }
  | { status: "WALLET_AMOUNT_MISMATCH"; tripId: string; tripCode: string | null; dryRun: true; expected_pence: number; actual_pence: number }
  | { status: "DUPLICATE_WALLET_CREDIT"; tripId: string; tripCode: string | null; dryRun: true; existing_count: number }
  | { status: "MODEL_ISOLATION_BLOCKED"; tripId: string; tripCode: string | null; dryRun: true; reason: string }
  | DryRunEligible;

function pence(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function snapshot(trip: TripRow): Record<string, unknown> {
  const raw = trip.fare_snapshot_json;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

export function londonCivilDateKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const normalized = normalizeTimestamptz(iso) ?? iso;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export function normalizeTimestamptz(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates = [
    trimmed,
    trimmed.replace(" ", "T"),
    trimmed.replace(/([+-]\d{2})$/, "$1:00"),
    trimmed.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"),
    trimmed.replace(/([+-])00$/, "Z"),
    trimmed.replace(" ", "T").replace(/([+-])00$/, "Z"),
  ];
  for (const candidate of candidates) {
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

export function addHoursIso(iso: string, hours: number): string | null {
  const normalized = normalizeTimestamptz(iso);
  if (!normalized) return null;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + hours * 3_600_000).toISOString();
}

export function savedStampView(trip: TripRow): Record<string, unknown> {
  const snap = snapshot(trip);
  return {
    trip_code: text(trip.trip_code),
    commissionable_fare_pence: pence(trip.commissionable_fare_pence),
    commission_pence: pence(trip.commission_pence),
    driver_net_pence: pence(trip.driver_net_pence),
    applied_customer_promotion_pence: pence(snap.applied_customer_promotion_pence) ??
      pence(trip.offer_discount_pence),
    commission_after_promotion_pence: pence(snap.commission_after_promotion_pence),
    final_fare_pence: pence(trip.final_fare_pence),
    accepted_commission_percent: pence(trip.accepted_commission_percent) ??
      pence(trip.commission_pct),
  };
}

export function stampMatchesExpected(trip: TripRow, expected: ExpectedStamp): string | null {
  const actual = savedStampView(trip);
  const checks: Array<[string, unknown, unknown]> = [
    ["trip_code", actual.trip_code, expected.trip_code],
    ["commissionable_fare_pence", actual.commissionable_fare_pence, expected.commissionable_fare_pence],
    ["commission_pence", actual.commission_pence, expected.commission_pence],
    ["driver_net_pence", actual.driver_net_pence, expected.driver_net_pence],
    ["applied_customer_promotion_pence", actual.applied_customer_promotion_pence, expected.applied_customer_promotion_pence],
    ["commission_after_promotion_pence", actual.commission_after_promotion_pence, expected.commission_after_promotion_pence],
    ["final_fare_pence", actual.final_fare_pence, expected.final_fare_pence],
    ["accepted_commission_percent", actual.accepted_commission_percent, expected.accepted_commission_percent],
  ];
  for (const [key, got, want] of checks) {
    if (got !== want) return `${key}: expected ${want}, got ${got}`;
  }
  const identity = expected.driver_net_pence + expected.commission_after_promotion_pence;
  if (identity !== expected.captured_amount_pence) {
    return `identity_broken: ${expected.driver_net_pence}+${expected.commission_after_promotion_pence}!=${expected.captured_amount_pence}`;
  }
  if (identity !== expected.final_fare_pence) {
    return `identity_final_mismatch: ${identity}!=${expected.final_fare_pence}`;
  }
  return null;
}

function blockedStatus(status: string): boolean {
  const s = status.toLowerCase();
  return [
    "cancelled",
    "canceled",
    "failed",
    "refunded",
    "released",
    "voided",
    "error",
  ].includes(s);
}

export function evaluateMk007Mk009DryRun(input: {
  tripId: string;
  trip: TripRow | null;
  sessions: PaymentSessionRow[];
  tenRows: Array<{ amount_pence?: unknown }>;
  commissionWalletCount: number | null;
  payoutItemCount: number | null;
}): RecoveryResult {
  const tripId = input.tripId;
  const dryRun = true as const;
  if (!(APPROVED_MK007_MK009_TRIP_IDS as readonly string[]).includes(tripId)) {
    return { status: "NOT_IN_ALLOW_LIST", tripId, tripCode: null, dryRun };
  }
  const expected = EXPECTED_STAMPS[tripId];
  if (!input.trip) {
    return { status: "TRIP_NOT_FOUND", tripId, tripCode: null, dryRun };
  }
  const tripCode = text(input.trip.trip_code) || expected.trip_code;
  const financialModel = text(input.trip.financial_model).toUpperCase();
  if (financialModel !== "PLATFORM_COLLECTED") {
    return {
      status: "FINANCIAL_MODEL_VIOLATION",
      tripId,
      tripCode,
      dryRun,
      financial_model: financialModel,
    };
  }
  const driverId = text(input.trip.driver_id);
  if (driverId !== APPROVED_DRIVER_ID) {
    return { status: "DRIVER_MISMATCH", tripId, tripCode, dryRun, driver_id: driverId };
  }
  const stampErr = stampMatchesExpected(input.trip, expected);
  if (stampErr) {
    return {
      status: "SETTLEMENT_STAMP_MISMATCH",
      tripId,
      tripCode,
      dryRun,
      reason: stampErr,
      expected,
      actual: savedStampView(input.trip),
    };
  }

  const existingCount = input.tenRows.length;
  const existingAmount = input.tenRows.reduce(
    (sum, row) => sum + Math.max(0, pence(row.amount_pence) ?? 0),
    0,
  );
  if (existingCount > 1) {
    return { status: "DUPLICATE_WALLET_CREDIT", tripId, tripCode, dryRun, existing_count: existingCount };
  }
  if (existingCount === 1) {
    if (existingAmount !== expected.driver_net_pence) {
      return {
        status: "WALLET_AMOUNT_MISMATCH",
        tripId,
        tripCode,
        dryRun,
        expected_pence: expected.driver_net_pence,
        actual_pence: existingAmount,
      };
    }
    return { status: "ALREADY_CREDITED", tripId, tripCode, dryRun, credited_pence: existingAmount };
  }

  if (input.commissionWalletCount == null) {
    return { status: "MODEL_ISOLATION_BLOCKED", tripId, tripCode, dryRun, reason: "commission_wallet_query_failed" };
  }
  if (input.commissionWalletCount > 0) {
    return { status: "MODEL_ISOLATION_BLOCKED", tripId, tripCode, dryRun, reason: "commission_wallet_rows_present" };
  }
  if (input.payoutItemCount == null) {
    return { status: "MODEL_ISOLATION_BLOCKED", tripId, tripCode, dryRun, reason: "payout_item_query_failed" };
  }
  if (input.payoutItemCount > 0) {
    return { status: "MODEL_ISOLATION_BLOCKED", tripId, tripCode, dryRun, reason: "payout_items_present" };
  }

  if (input.sessions.length === 0) {
    return { status: "PAYMENT_SESSION_NOT_FOUND", tripId, tripCode, dryRun };
  }
  const recovery = input.sessions.filter((row) => text(row.purpose).toUpperCase() === "PAYMENT_RECOVERY");
  if (recovery.length > 0) {
    return {
      status: "PAYMENT_SESSION_BLOCKED",
      tripId,
      tripCode,
      dryRun,
      reason: `payment_recovery_present:${recovery.length}`,
    };
  }
  const rideBooking = input.sessions.filter((row) => text(row.purpose).toUpperCase() === "RIDE_BOOKING");
  if (rideBooking.length !== 1 || input.sessions.length !== 1) {
    return {
      status: "PAYMENT_SESSION_BLOCKED",
      tripId,
      tripCode,
      dryRun,
      reason: `session_count_not_one:${input.sessions.length}:ride_booking:${rideBooking.length}`,
    };
  }
  const session = rideBooking[0];
  const status = text(session.status).toLowerCase();
  if (blockedStatus(status)) {
    return {
      status: "PAYMENT_SESSION_BLOCKED",
      tripId,
      tripCode,
      dryRun,
      reason: `contradictory_status:${status}`,
    };
  }
  const providerState = text(session.provider_state).toUpperCase();
  if (providerState !== "COMPLETED" && providerState !== "CAPTURED") {
    return {
      status: "PAYMENT_SESSION_BLOCKED",
      tripId,
      tripCode,
      dryRun,
      reason: `provider_state:${providerState || "missing"}`,
    };
  }
  const verifiedAt = text(session.provider_state_verified_at);
  if (!verifiedAt) {
    return {
      status: "PAYMENT_SESSION_BLOCKED",
      tripId,
      tripCode,
      dryRun,
      reason: "provider_state_verified_at_missing",
    };
  }
  const capturedAt = text(session.captured_at);
  if (!capturedAt) {
    return {
      status: "PAYMENT_SESSION_BLOCKED",
      tripId,
      tripCode,
      dryRun,
      reason: "captured_at_missing",
    };
  }
  const capturedAmount = pence(session.captured_amount_pence);
  if (capturedAmount !== expected.captured_amount_pence) {
    return {
      status: "PAYMENT_SESSION_BLOCKED",
      tripId,
      tripCode,
      dryRun,
      reason: `captured_amount:${capturedAmount}:expected:${expected.captured_amount_pence}`,
    };
  }
  const finOp = text(session.financial_operation_state).toUpperCase();
  if (finOp && finOp !== "CAPTURED" && finOp !== "COMPLETED") {
    return {
      status: "PAYMENT_SESSION_BLOCKED",
      tripId,
      tripCode,
      dryRun,
      reason: `financial_operation_state:${finOp}`,
    };
  }
  const orderId = text(session.provider_order_id);
  const captureId = text(session.provider_capture_id);
  if (!orderId || !captureId) {
    return {
      status: "PAYMENT_SESSION_BLOCKED",
      tripId,
      tripCode,
      dryRun,
      reason: `provider_identity_missing:order:${Boolean(orderId)}:capture:${Boolean(captureId)}`,
    };
  }
  if ((pence(session.refunded_amount_pence) ?? 0) > 0 || text(session.provider_refund_id) || text(session.refunded_at)) {
    return { status: "PAYMENT_SESSION_BLOCKED", tripId, tripCode, dryRun, reason: "refund_exists" };
  }
  const releaseState = text(session.hold_release_state).toUpperCase();
  if (
    (pence(session.released_amount_pence) ?? 0) > 0
    || releaseState.includes("RELEASE")
    || text(session.released_at)
  ) {
    return { status: "PAYMENT_SESSION_BLOCKED", tripId, tripCode, dryRun, reason: "release_exists" };
  }
  const lifecycleMismatch = status !== "captured";
  if (lifecycleMismatch && status !== "trip_created") {
    return {
      status: "PAYMENT_SESSION_BLOCKED",
      tripId,
      tripCode,
      dryRun,
      reason: `status_not_captured:${status}`,
    };
  }
  const economic = normalizeTimestamptz(capturedAt);
  if (!economic) {
    return { status: "PAYMENT_SESSION_BLOCKED", tripId, tripCode, dryRun, reason: "captured_at_unparsed" };
  }
  const eligibleAt = addHoursIso(economic, PAYOUT_CLEARING_DELAY_HOURS);
  if (!eligibleAt) {
    return { status: "PAYMENT_SESSION_BLOCKED", tripId, tripCode, dryRun, reason: "eligible_at_unresolved" };
  }

  return {
    status: "DRY_RUN_ELIGIBLE",
    tripId,
    tripCode,
    dryRun: true,
    saved_driver_entitlement_pence: expected.driver_net_pence,
    payment_session_id: text(session.id),
    payment_session_status: status,
    payment_session_lifecycle_mismatch: lifecycleMismatch,
    payment_session_finalization_required_before_credit: lifecycleMismatch,
    provider_state: providerState,
    provider_state_verified_at: verifiedAt,
    captured_amount_pence: capturedAmount,
    captured_at: capturedAt,
    provider_order_id: orderId,
    provider_capture_id: captureId,
    existing_wallet_count: 0,
    existing_wallet_amount_pence: 0,
    proposed_amount_pence: expected.driver_net_pence,
    proposed_ledger_type: "TRIP_EARNING_NET",
    posting_created_at: null,
    posting_created_at_projection: "future_execution_timestamp",
    economic_earned_at: economic,
    eligible_at: eligibleAt,
    eligibility_origin: "captured_at_plus_27h",
    provider_operation_required: false,
    settlement_recalculation_required: false,
    driver_id: driverId,
  };
}

type AnyClient = {
  from: (table: string) => {
    select: (columns: string, options?: Record<string, unknown>) => {
      eq: (column: string, value: string) => PromiseLike<{
        data?: unknown;
        error?: { message?: string } | null;
        count?: number | null;
      }> & {
        maybeSingle?: () => Promise<{ data: TripRow | null; error?: { message?: string } | null }>;
      };
    };
  };
};

async function countEq(
  supabase: AnyClient,
  table: string,
  column: string,
  value: string,
): Promise<number | null> {
  const { data, error, count } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq(column, value);
  if (error) return null;
  if (typeof count === "number") return count;
  return Array.isArray(data) ? data.length : 0;
}

export async function recoverMk007Mk009WalletDryRun(
  supabase: AnyClient,
  tripId: string,
): Promise<RecoveryResult> {
  if (!(APPROVED_MK007_MK009_TRIP_IDS as readonly string[]).includes(tripId)) {
    return { status: "NOT_IN_ALLOW_LIST", tripId, tripCode: null, dryRun: true };
  }

  const { data: trip } = await supabase
    .from("trips")
    .select(TRIP_SELECT)
    .eq("id", tripId)
    .maybeSingle!();

  const { data: sessions, error: psError } = await supabase
    .from("payment_sessions")
    .select(PS_SELECT)
    .eq("trip_id", tripId);

  if (psError) {
    return {
      status: "PAYMENT_SESSION_BLOCKED",
      tripId,
      tripCode: trip?.trip_code ? String(trip.trip_code) : null,
      dryRun: true,
      reason: `payment_session_query:${psError.message ?? "error"}`,
    };
  }

  const { data: ledgerRows, error: ledgerError } = await supabase
    .from("driver_wallet_ledger")
    .select("amount_pence,type")
    .eq("related_trip_id", tripId);

  if (ledgerError) {
    return {
      status: "MODEL_ISOLATION_BLOCKED",
      tripId,
      tripCode: trip?.trip_code ? String(trip.trip_code) : null,
      dryRun: true,
      reason: "wallet_query_failed",
    };
  }

  const allLedger = Array.isArray(ledgerRows) ? ledgerRows as Array<{ amount_pence?: unknown; type?: unknown }> : [];
  const foreign = allLedger.filter((row) => String(row.type ?? "").toUpperCase() !== "TRIP_EARNING_NET");
  if (foreign.length > 0) {
    return {
      status: "MODEL_ISOLATION_BLOCKED",
      tripId,
      tripCode: trip?.trip_code ? String(trip.trip_code) : null,
      dryRun: true,
      reason: `wrong_wallet_rows:${foreign.map((row) => String(row.type ?? "unknown")).join(",")}`,
    };
  }
  const ten = allLedger.filter((row) => String(row.type ?? "").toUpperCase() === "TRIP_EARNING_NET");

  const cwCount = await countEq(supabase, "driver_commission_wallet_ledger", "trip_id", tripId);
  const payoutCount = await countEq(supabase, "payout_items", "trip_id", tripId);

  return evaluateMk007Mk009DryRun({
    tripId,
    trip: trip ?? null,
    sessions: Array.isArray(sessions) ? sessions as PaymentSessionRow[] : [],
    tenRows: ten,
    commissionWalletCount: cwCount,
    payoutItemCount: payoutCount,
  });
}
