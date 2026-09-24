/**
 * Opaque booking-payment quote SSOT.
 *
 * Server issues a persisted quote (UUID token). create-preauth consumes it
 * atomically. Client never constructs or edits the quote.
 * Replaces client-built outstanding:<pence>:v1 as payment admission authority.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  buildServerReceivableQuoteVersion,
  CUSTOMER_RECEIVABLE_CONSENT_VERSION,
  planCustomerReceivableFoldEligibilityQuote,
  readCustomerReceivableFoldGate,
} from "./customerReceivableConsentSSOT.ts";

export const BOOKING_PAYMENT_QUOTE_TTL_MS = 10 * 60 * 1000;

export const FARE_QUOTE_EXPIRED = "FARE_QUOTE_EXPIRED" as const;
export const FARE_QUOTE_CHANGED = "FARE_QUOTE_CHANGED" as const;
export const OUTSTANDING_BALANCE_CHANGED = "OUTSTANDING_BALANCE_CHANGED" as const;
export const RECEIVABLE_FOLD_UNAVAILABLE = "RECEIVABLE_FOLD_UNAVAILABLE" as const;
export const BOOKING_QUOTE_INVALID = "BOOKING_QUOTE_INVALID" as const;

export type BookingPaymentQuoteErrorCode =
  | typeof FARE_QUOTE_EXPIRED
  | typeof FARE_QUOTE_CHANGED
  | typeof OUTSTANDING_BALANCE_CHANGED
  | typeof RECEIVABLE_FOLD_UNAVAILABLE
  | typeof BOOKING_QUOTE_INVALID;

export const BOOKING_PAYMENT_QUOTE_ERROR_COPY: Record<
  BookingPaymentQuoteErrorCode,
  string
> = {
  [FARE_QUOTE_EXPIRED]:
    "The fare quote expired. We've refreshed your price.",
  [FARE_QUOTE_CHANGED]:
    "Your trip price changed. Please review the new total.",
  [OUTSTANDING_BALANCE_CHANGED]:
    "Your outstanding balance changed. Please review the new total.",
  [RECEIVABLE_FOLD_UNAVAILABLE]:
    "Your previous balance cannot be included right now. Please review the payment total.",
  [BOOKING_QUOTE_INVALID]:
    "We couldn't verify this payment total. Please refresh and try again.",
};

export type BookingPaymentQuoteState =
  | "ISSUED"
  | "CONSUMED"
  | "EXPIRED"
  | "CANCELLED";

export type BookingPaymentQuoteRow = {
  id: string;
  customer_id: string;
  user_id: string;
  client_action_id: string;
  service_area_id: string | null;
  ride_category: string;
  route_fingerprint: string;
  currency: string;
  trip_fare_pence: number;
  buffer_pence: number;
  receivable_pence: number;
  total_authorisation_pence: number;
  fold_eligible: boolean;
  consent_version: number;
  state: BookingPaymentQuoteState;
  consumed_payment_session_id: string | null;
  issued_at: string;
  expires_at: string;
  metadata: Record<string, unknown>;
};

function nonNeg(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function stableCoord(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "null";
  return n.toFixed(5);
}

/** Stable route/category fingerprint — changes invalidate the quote. */
export function buildBookingPaymentRouteFingerprint(input: {
  service_area_id?: string | null;
  ride_category?: string | null;
  vehicle_type_id?: string | null;
  pickup?: { lat?: unknown; lng?: unknown } | null;
  dropoff?: { lat?: unknown; lng?: unknown } | null;
  stops?: ReadonlyArray<{ lat?: unknown; lng?: unknown }> | null;
  voucher_id?: string | null;
  currency?: string | null;
}): string {
  const stops = Array.isArray(input.stops) ? input.stops : [];
  const parts = [
    String(input.service_area_id ?? "").trim(),
    String(input.ride_category ?? input.vehicle_type_id ?? "").trim(),
    String(input.currency ?? "gbp").trim().toLowerCase() || "gbp",
    `p:${stableCoord(input.pickup?.lat)},${stableCoord(input.pickup?.lng)}`,
    `d:${stableCoord(input.dropoff?.lat)},${stableCoord(input.dropoff?.lng)}`,
    `s:${stops.map((s) => `${stableCoord(s.lat)},${stableCoord(s.lng)}`).join("|")}`,
    `v:${String(input.voucher_id ?? "").trim()}`,
  ];
  return parts.join("|");
}

export function bookingPaymentQuoteErrorPayload(
  code: BookingPaymentQuoteErrorCode,
  extra?: Record<string, unknown>,
): {
  error: string;
  code: BookingPaymentQuoteErrorCode;
  error_code: BookingPaymentQuoteErrorCode;
  charge_state: "no_charge";
} & Record<string, unknown> {
  return {
    error: BOOKING_PAYMENT_QUOTE_ERROR_COPY[code],
    code,
    error_code: code,
    charge_state: "no_charge",
    ...extra,
  };
}

/** @deprecated alias — use bookingPaymentQuoteErrorPayload */
export const bookingPaymentQuoteErrorResponse = bookingPaymentQuoteErrorPayload;

/** Map RPC / validation notes to typed codes. Trip-fare ≠ outstanding. */
export function mapBookingQuoteFailureNote(
  note: string | null | undefined,
  fallback: BookingPaymentQuoteErrorCode = BOOKING_QUOTE_INVALID,
): BookingPaymentQuoteErrorCode {
  const n = String(note ?? "");
  if (n.includes("expired") || n === "quote_expired") return FARE_QUOTE_EXPIRED;
  if (
    n.includes("fingerprint")
    || n.includes("route")
    || n.includes("category")
    || n.includes("trip_fare")
    || n === "fare_changed"
  ) {
    return FARE_QUOTE_CHANGED;
  }
  if (
    n.includes("receivable")
    || n.includes("outstanding")
    || n === "open_receivable_mismatch"
  ) {
    return OUTSTANDING_BALANCE_CHANGED;
  }
  if (n.includes("gate_off") || n.includes("fold")) {
    return RECEIVABLE_FOLD_UNAVAILABLE;
  }
  if (
    n === "FARE_QUOTE_EXPIRED"
    || n === "FARE_QUOTE_CHANGED"
    || n === "OUTSTANDING_BALANCE_CHANGED"
    || n === "RECEIVABLE_FOLD_UNAVAILABLE"
    || n === "BOOKING_QUOTE_INVALID"
  ) {
    return n as BookingPaymentQuoteErrorCode;
  }
  return fallback;
}

export function extractBookingPaymentQuoteIdFromBody(
  body: Record<string, unknown> | null | undefined,
): string | null {
  if (!body || typeof body !== "object") return null;
  const raw =
    body.booking_payment_quote_id
    ?? body.customer_booking_payment_quote_id
    ?? body.quote_id;
  const id = String(raw ?? "").trim();
  return id || null;
}

export function rowFromDb(raw: Record<string, unknown>): BookingPaymentQuoteRow {
  return {
    id: String(raw.id),
    customer_id: String(raw.customer_id),
    user_id: String(raw.user_id),
    client_action_id: String(raw.client_action_id),
    service_area_id: raw.service_area_id != null ? String(raw.service_area_id) : null,
    ride_category: String(raw.ride_category ?? ""),
    route_fingerprint: String(raw.route_fingerprint ?? ""),
    currency: String(raw.currency ?? "gbp").toLowerCase(),
    trip_fare_pence: nonNeg(raw.trip_fare_pence),
    buffer_pence: nonNeg(raw.buffer_pence),
    receivable_pence: nonNeg(raw.receivable_pence),
    total_authorisation_pence: nonNeg(raw.total_authorisation_pence),
    fold_eligible: raw.fold_eligible === true,
    consent_version: nonNeg(raw.consent_version) || CUSTOMER_RECEIVABLE_CONSENT_VERSION,
    state: String(raw.state ?? "ISSUED") as BookingPaymentQuoteState,
    consumed_payment_session_id: raw.consumed_payment_session_id != null
      ? String(raw.consumed_payment_session_id)
      : null,
    issued_at: String(raw.issued_at ?? ""),
    expires_at: String(raw.expires_at ?? ""),
    metadata: raw.metadata && typeof raw.metadata === "object"
      ? raw.metadata as Record<string, unknown>
      : {},
  };
}

export async function loadBookingPaymentQuote(
  supabase: SupabaseClient,
  quoteId: string,
): Promise<BookingPaymentQuoteRow | null> {
  const { data, error } = await supabase
    .from("booking_payment_quotes")
    .select("*")
    .eq("id", quoteId)
    .maybeSingle();
  if (error || !data) return null;
  return rowFromDb(data as Record<string, unknown>);
}

/**
 * Pure validation of a loaded quote against preauth context.
 * Does not mutate. Trip-fare mismatch → FARE_QUOTE_CHANGED (never outstanding).
 */
export function validateBookingPaymentQuoteForPreauth(args: {
  quote: BookingPaymentQuoteRow;
  customer_id: string;
  client_action_id: string;
  route_fingerprint: string;
  ride_category?: string | null;
  currency?: string | null;
  now_ms?: number;
  /** Live OPEN outstanding — must equal quoted receivable. */
  open_receivable_pence: number;
  gate_enabled: boolean;
}):
  | { ok: true; quote: BookingPaymentQuoteRow }
  | { ok: false; code: BookingPaymentQuoteErrorCode; note: string } {
  const q = args.quote;
  const now = args.now_ms ?? Date.now();

  if (q.customer_id !== args.customer_id) {
    return { ok: false, code: BOOKING_QUOTE_INVALID, note: "customer_mismatch" };
  }
  if (q.client_action_id !== args.client_action_id) {
    return { ok: false, code: BOOKING_QUOTE_INVALID, note: "client_action_mismatch" };
  }
  if (q.state === "CONSUMED") {
    return { ok: false, code: BOOKING_QUOTE_INVALID, note: "already_consumed_precheck" };
  }
  if (q.state === "CANCELLED" || q.state === "EXPIRED") {
    return { ok: false, code: FARE_QUOTE_EXPIRED, note: "quote_not_active" };
  }
  const expiresMs = Date.parse(q.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= now) {
    return { ok: false, code: FARE_QUOTE_EXPIRED, note: "quote_expired" };
  }
  if (q.route_fingerprint !== args.route_fingerprint) {
    return { ok: false, code: FARE_QUOTE_CHANGED, note: "route_fingerprint_mismatch" };
  }
  const cat = String(args.ride_category ?? "").trim();
  if (cat && q.ride_category && cat !== q.ride_category) {
    return { ok: false, code: FARE_QUOTE_CHANGED, note: "ride_category_mismatch" };
  }
  const cur = String(args.currency ?? "gbp").trim().toLowerCase() || "gbp";
  if (cur !== q.currency) {
    return { ok: false, code: FARE_QUOTE_CHANGED, note: "currency_mismatch" };
  }
  if (nonNeg(args.open_receivable_pence) !== q.receivable_pence) {
    return {
      ok: false,
      code: OUTSTANDING_BALANCE_CHANGED,
      note: "open_receivable_mismatch",
    };
  }
  // Emergency OFF rejects unconsumed fold-eligible quotes.
  if (q.fold_eligible && !args.gate_enabled) {
    return {
      ok: false,
      code: RECEIVABLE_FOLD_UNAVAILABLE,
      note: "gate_off_rejects_unconsumed_fold_quote",
    };
  }
  return { ok: true, quote: q };
}

/**
 * Provider / session target MUST equal opaque quote total exactly.
 * Dynamic fare (e.g. 743) must not replace an unexpired quote of 782.
 */
export function resolvePreauthAmountsFromQuote(quote: BookingPaymentQuoteRow): {
  trip_fare_pence: number;
  buffer_pence: number;
  receivable_pence: number;
  total_authorisation_pence: number;
  fold_eligible: boolean;
} {
  return {
    trip_fare_pence: quote.trip_fare_pence,
    buffer_pence: quote.buffer_pence,
    receivable_pence: quote.fold_eligible ? quote.receivable_pence : 0,
    total_authorisation_pence: quote.total_authorisation_pence,
    fold_eligible: quote.fold_eligible,
  };
}

export async function issueBookingPaymentQuote(
  supabase: SupabaseClient,
  input: {
    customer_id: string;
    user_id: string;
    client_action_id: string;
    service_area_id?: string | null;
    ride_category?: string | null;
    route_fingerprint: string;
    currency?: string | null;
    trip_fare_pence: number;
    buffer_pence?: number | null;
    server_outstanding_pence: number;
    gate?: { enabled: boolean; allowlist: Set<string> };
    ttl_ms?: number;
  },
): Promise<
  | { ok: true; quote: BookingPaymentQuoteRow; reused: boolean }
  | { ok: false; error: string }
> {
  const clientActionId = String(input.client_action_id ?? "").trim();
  const customerId = String(input.customer_id ?? "").trim();
  const userId = String(input.user_id ?? "").trim();
  const fingerprint = String(input.route_fingerprint ?? "").trim();
  if (!clientActionId || !customerId || !userId || !fingerprint) {
    return { ok: false, error: "missing_issue_fields" };
  }

  const gate = input.gate ?? readCustomerReceivableFoldGate();
  const plan = planCustomerReceivableFoldEligibilityQuote({
    customer_id: customerId,
    server_outstanding_pence: input.server_outstanding_pence,
    trip_fare_pence: input.trip_fare_pence,
    buffer_pence: input.buffer_pence,
    gate,
  });

  // Reuse ISSUED unexpired same-fingerprint quote for this CA.
  const { data: existing } = await supabase
    .from("booking_payment_quotes")
    .select("*")
    .eq("client_action_id", clientActionId)
    .eq("state", "ISSUED")
    .maybeSingle();

  if (existing) {
    const row = rowFromDb(existing as Record<string, unknown>);
    const exp = Date.parse(row.expires_at);
    if (Number.isFinite(exp) && exp > Date.now() && row.route_fingerprint === fingerprint) {
      return { ok: true, quote: row, reused: true };
    }
    // Fingerprint changed or expired — cancel old ISSUED row.
    await supabase
      .from("booking_payment_quotes")
      .update({
        state: Number.isFinite(exp) && exp <= Date.now() ? "EXPIRED" : "CANCELLED",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("state", "ISSUED");
  }

  const ttl = input.ttl_ms ?? BOOKING_PAYMENT_QUOTE_TTL_MS;
  const now = new Date();
  const insert = {
    customer_id: customerId,
    user_id: userId,
    client_action_id: clientActionId,
    service_area_id: input.service_area_id ?? null,
    ride_category: String(input.ride_category ?? "").trim(),
    route_fingerprint: fingerprint,
    currency: String(input.currency ?? "gbp").trim().toLowerCase() || "gbp",
    trip_fare_pence: plan.trip_fare_pence,
    buffer_pence: plan.buffer_pence,
    receivable_pence: plan.outstanding_pence,
    total_authorisation_pence: plan.total_authorisation_pence,
    fold_eligible: plan.fold_eligible,
    consent_version: plan.consent_version,
    state: "ISSUED",
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
    metadata: {
      quote_version: plan.quote_version,
      reason: plan.reason,
    },
  };

  const { data, error } = await supabase
    .from("booking_payment_quotes")
    .insert(insert)
    .select("*")
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? "insert_failed" };
  }
  return { ok: true, quote: rowFromDb(data as Record<string, unknown>), reused: false };
}

export async function consumeBookingPaymentQuoteViaRpc(
  supabase: SupabaseClient,
  args: {
    quote_id: string;
    customer_id: string;
    client_action_id: string;
    payment_session_id: string;
    expected_receivable_pence: number;
    gate_enabled: boolean;
  },
): Promise<
  | {
    ok: true;
    idempotent: boolean;
    payment_session_id: string;
    total_authorisation_pence: number;
  }
  | { ok: false; code: BookingPaymentQuoteErrorCode; note: string; raw?: unknown }
> {
  const { data, error } = await supabase.rpc("consume_booking_payment_quote", {
    p_quote_id: args.quote_id,
    p_customer_id: args.customer_id,
    p_client_action_id: args.client_action_id,
    p_payment_session_id: args.payment_session_id,
    p_expected_receivable_pence: nonNeg(args.expected_receivable_pence),
    p_gate_enabled: args.gate_enabled === true,
  });

  if (error) {
    return {
      ok: false,
      code: BOOKING_QUOTE_INVALID,
      note: error.message ?? "rpc_error",
      raw: error,
    };
  }
  const body = (data ?? {}) as Record<string, unknown>;
  if (body.ok === true) {
    return {
      ok: true,
      idempotent: body.idempotent === true,
      payment_session_id: String(body.payment_session_id ?? args.payment_session_id),
      total_authorisation_pence: nonNeg(body.total_authorisation_pence),
    };
  }
  const codeRaw = String(body.error_code ?? BOOKING_QUOTE_INVALID);
  const code = mapBookingQuoteFailureNote(
    codeRaw,
    mapBookingQuoteFailureNote(String(body.note ?? ""), BOOKING_QUOTE_INVALID),
  );
  return {
    ok: false,
    code,
    note: String(body.note ?? codeRaw),
    raw: body,
  };
}

/** Delete orphan pending session created before a failed consume / validation. */
export async function rollbackOrphanPendingPaymentSession(
  supabase: SupabaseClient,
  sessionId: string | null | undefined,
): Promise<void> {
  const id = String(sessionId ?? "").trim();
  if (!id) return;
  await supabase
    .from("payment_sessions")
    .delete()
    .eq("id", id)
    .eq("status", "pending_payment")
    .is("provider_order_id", null);
}

export function quotePublicResponseFields(quote: BookingPaymentQuoteRow): Record<string, unknown> {
  const quoteVersion = buildServerReceivableQuoteVersion(quote.receivable_pence);
  return {
    ok: true,
    quote_id: quote.id,
    client_action_id: quote.client_action_id,
    service_area_id: quote.service_area_id,
    ride_category: quote.ride_category,
    route_fingerprint: quote.route_fingerprint,
    currency: quote.currency,
    trip_fare_pence: quote.trip_fare_pence,
    buffer_pence: quote.buffer_pence,
    receivable_pence: quote.receivable_pence,
    outstanding_pence: quote.receivable_pence,
    total_authorisation_pence: quote.total_authorisation_pence,
    fold_eligible: quote.fold_eligible,
    consent_version: quote.consent_version,
    issued_at: quote.issued_at,
    expires_at: quote.expires_at,
    state: quote.state,
    quote_version: quoteVersion,
    consumed_payment_session_id: quote.consumed_payment_session_id,
  };
}
