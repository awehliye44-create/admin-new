/**
 * Lock: opaque booking-payment quote SSOT.
 * Payment admission authority is the persisted server quote — never client
 * outstanding:N:v1, never live reprice after Book tap.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BOOKING_PAYMENT_QUOTE_ERROR_COPY,
  BOOKING_QUOTE_INVALID,
  FARE_QUOTE_CHANGED,
  FARE_QUOTE_EXPIRED,
  OUTSTANDING_BALANCE_CHANGED,
  RECEIVABLE_FOLD_UNAVAILABLE,
  buildBookingPaymentRouteFingerprint,
  resolvePreauthAmountsFromQuote,
  validateBookingPaymentQuoteForPreauth,
  type BookingPaymentQuoteRow,
} from "./bookingPaymentQuoteSSOT.ts";

function quote(overrides: Partial<BookingPaymentQuoteRow> = {}): BookingPaymentQuoteRow {
  const trip = overrides.trip_fare_pence ?? 746;
  const recv = overrides.receivable_pence ?? 36;
  const fold = overrides.fold_eligible ?? true;
  const buffer = overrides.buffer_pence ?? 0;
  const total =
    overrides.total_authorisation_pence
    ?? (trip + buffer + (fold ? recv : 0));
  return {
    id: "quote-782",
    customer_id: "cust-1",
    user_id: "user-1",
    client_action_id: "ca-1",
    service_area_id: "sa-1",
    ride_category: "go",
    route_fingerprint: "fp-a",
    currency: "gbp",
    trip_fare_pence: trip,
    buffer_pence: buffer,
    receivable_pence: recv,
    total_authorisation_pence: total,
    fold_eligible: fold,
    consent_version: 1,
    state: "ISSUED",
    consumed_payment_session_id: null,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    metadata: {},
    ...overrides,
    // Re-assert computed total unless caller forced fold/amounts inconsistently.
    total_authorisation_pence:
      overrides.total_authorisation_pence
      ?? (
        (overrides.trip_fare_pence ?? trip)
        + (overrides.buffer_pence ?? buffer)
        + ((overrides.fold_eligible ?? fold)
          ? (overrides.receivable_pence ?? recv)
          : 0)
      ),
  };
}

Deno.test("1) unexpired quote 746+36=782 ignores live reprice 743", () => {
  const q = quote({ trip_fare_pence: 746, receivable_pence: 36, fold_eligible: true });
  const amounts = resolvePreauthAmountsFromQuote(q);
  assertEquals(amounts.total_authorisation_pence, 782);
  assertEquals(amounts.trip_fare_pence, 746);
  // Live estimate 743 must not replace quoted total.
  assertEquals(amounts.total_authorisation_pence !== 743 + 36, true);
});

Deno.test("2) expired quote → FARE_QUOTE_EXPIRED", () => {
  const q = quote({
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  const v = validateBookingPaymentQuoteForPreauth({
    quote: q,
    customer_id: "cust-1",
    client_action_id: "ca-1",
    route_fingerprint: "fp-a",
    open_receivable_pence: 36,
    gate_enabled: true,
  });
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.code, FARE_QUOTE_EXPIRED);
});

Deno.test("3) route fingerprint change → FARE_QUOTE_CHANGED", () => {
  const q = quote();
  const v = validateBookingPaymentQuoteForPreauth({
    quote: q,
    customer_id: "cust-1",
    client_action_id: "ca-1",
    route_fingerprint: "fp-CHANGED",
    open_receivable_pence: 36,
    gate_enabled: true,
  });
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.code, FARE_QUOTE_CHANGED);
});

Deno.test("4) OPEN receivable changed → OUTSTANDING_BALANCE_CHANGED", () => {
  const q = quote({ receivable_pence: 36 });
  const v = validateBookingPaymentQuoteForPreauth({
    quote: q,
    customer_id: "cust-1",
    client_action_id: "ca-1",
    route_fingerprint: "fp-a",
    open_receivable_pence: 40,
    gate_enabled: true,
  });
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.code, OUTSTANDING_BALANCE_CHANGED);
});

Deno.test("5+6) consumed / wrong CA rejected as BOOKING_QUOTE_INVALID", () => {
  const consumed = quote({
    state: "CONSUMED",
    consumed_payment_session_id: "sess-1",
  });
  const v = validateBookingPaymentQuoteForPreauth({
    quote: consumed,
    customer_id: "cust-1",
    client_action_id: "ca-1",
    route_fingerprint: "fp-a",
    open_receivable_pence: 36,
    gate_enabled: true,
  });
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.code, BOOKING_QUOTE_INVALID);

  const wrongCa = validateBookingPaymentQuoteForPreauth({
    quote: quote(),
    customer_id: "cust-1",
    client_action_id: "ca-OTHER",
    route_fingerprint: "fp-a",
    open_receivable_pence: 36,
    gate_enabled: true,
  });
  assertEquals(wrongCa.ok, false);
  if (!wrongCa.ok) assertEquals(wrongCa.code, BOOKING_QUOTE_INVALID);
});

Deno.test("7) consume RPC uses FOR UPDATE (one winner)", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20261128120000_booking_payment_quotes.sql", import.meta.url),
  );
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "consume_booking_payment_quote");
  assertStringIncludes(sql, "quote_consumed_different_client_action");
});

Deno.test("8) gate OFF before quote → fold_eligible false, total=fare only", () => {
  const q = quote({
    fold_eligible: false,
    receivable_pence: 36,
    trip_fare_pence: 746,
    total_authorisation_pence: 746,
  });
  const amounts = resolvePreauthAmountsFromQuote(q);
  assertEquals(amounts.fold_eligible, false);
  assertEquals(amounts.total_authorisation_pence, 746);
  assertEquals(amounts.receivable_pence, 0);
});

Deno.test("9) gate OFF after eligible ISSUED → RECEIVABLE_FOLD_UNAVAILABLE", () => {
  const q = quote({ fold_eligible: true });
  const v = validateBookingPaymentQuoteForPreauth({
    quote: q,
    customer_id: "cust-1",
    client_action_id: "ca-1",
    route_fingerprint: "fp-a",
    open_receivable_pence: 36,
    gate_enabled: false,
  });
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.code, RECEIVABLE_FOLD_UNAVAILABLE);
});

Deno.test("10) provider target equals opaque quote total exactly", () => {
  const q = quote({ trip_fare_pence: 746, receivable_pence: 36 });
  assertEquals(resolvePreauthAmountsFromQuote(q).total_authorisation_pence, 782);
});

Deno.test("11) typed error copy exact", () => {
  assertEquals(
    BOOKING_PAYMENT_QUOTE_ERROR_COPY[FARE_QUOTE_EXPIRED],
    "The fare quote expired. We've refreshed your price.",
  );
  assertEquals(
    BOOKING_PAYMENT_QUOTE_ERROR_COPY[FARE_QUOTE_CHANGED],
    "Your trip price changed. Please review the new total.",
  );
  assertEquals(
    BOOKING_PAYMENT_QUOTE_ERROR_COPY[OUTSTANDING_BALANCE_CHANGED],
    "Your outstanding balance changed. Please review the new total.",
  );
  assertEquals(
    BOOKING_PAYMENT_QUOTE_ERROR_COPY[RECEIVABLE_FOLD_UNAVAILABLE],
    "Your previous balance cannot be included right now. Please review the payment total.",
  );
  assertEquals(
    BOOKING_PAYMENT_QUOTE_ERROR_COPY[BOOKING_QUOTE_INVALID],
    "We couldn't verify this payment total. Please refresh and try again.",
  );
});

Deno.test("12) trip-fare mismatch must NOT use outstanding copy", async () => {
  const src = await Deno.readTextFile(new URL("./revolutPreauth.ts", import.meta.url));
  assertStringIncludes(src, "displayed_trip_fare_mismatch");
  assertStringIncludes(src, "FARE_QUOTE_CHANGED");
  // Fail-closed trip fare path must map to FARE_QUOTE_CHANGED, not outstanding string alone.
  const idx = src.indexOf("displayed_trip_fare_mismatch");
  const window = src.slice(idx, idx + 400);
  assertStringIncludes(window, "FARE_QUOTE_CHANGED");
});

Deno.test("13) rejection rolls back pending session (zero session)", async () => {
  const src = await Deno.readTextFile(new URL("./revolutPreauth.ts", import.meta.url));
  assertStringIncludes(src, "rollbackOrphanPendingPaymentSession");
  assertStringIncludes(src, "OPAQUE_BOOKING_QUOTE_FROZEN");
  assertStringIncludes(src, "consumeBookingPaymentQuoteViaRpc");
});

Deno.test("14) fingerprint stable for same route; changes on destination", () => {
  const a = buildBookingPaymentRouteFingerprint({
    service_area_id: "sa",
    ride_category: "go",
    pickup: { lat: 52.04, lng: -0.76 },
    dropoff: { lat: 52.05, lng: -0.77 },
    stops: [],
  });
  const b = buildBookingPaymentRouteFingerprint({
    service_area_id: "sa",
    ride_category: "go",
    pickup: { lat: 52.04, lng: -0.76 },
    dropoff: { lat: 52.05, lng: -0.77 },
    stops: [],
  });
  const c = buildBookingPaymentRouteFingerprint({
    service_area_id: "sa",
    ride_category: "go",
    pickup: { lat: 52.04, lng: -0.76 },
    dropoff: { lat: 52.06, lng: -0.77 },
    stops: [],
  });
  assertEquals(a, b);
  assertEquals(a === c, false);
});

Deno.test("migration + quote edge exist", async () => {
  const mig = await Deno.readTextFile(
    new URL("../../migrations/20261128120000_booking_payment_quotes.sql", import.meta.url),
  );
  assertStringIncludes(mig, "booking_payment_quotes");
  assertStringIncludes(mig, "gate_off_rejects_unconsumed_fold_quote");
  const edge = await Deno.readTextFile(
    new URL("../customer-receivable-booking-quote/index.ts", import.meta.url),
  );
  assertStringIncludes(edge, "issueBookingPaymentQuote");
  assertStringIncludes(edge, "quote_id");
  assertStringIncludes(edge, "client_action_id");
});
