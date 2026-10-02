/**
 * Lock: the preauth buffer is SERVER-OWNED.
 *
 * hold = payable fare + buffer resolved from service_area_preauth_settings.
 * The buffer is not fare, not revenue and never auto-captured; the unused
 * part is released. The client cannot choose, suppress or inflate it.
 *
 * Defect: customer-receivable-booking-quote froze `body.buffer_pence`
 * (Customer hard-codes 0), so every opaque quote authorised fare-only even
 * with MK config fixed £2.50 (e.g. 771 instead of 1021).
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeServiceAreaPreauthBuffer,
  resolvePreauthBuffer,
} from "./preauthBufferResolverSSOT.ts";
import {
  type BookingPaymentQuoteRow,
  issueBookingPaymentQuote,
  parseBookingQuoteRequestBody,
  resolveBookingQuoteServerBuffer,
  resolvePreauthAmountsFromQuote,
} from "./bookingPaymentQuoteSSOT.ts";
import {
  CUSTOMER_RECEIVABLE_CONSENT_VERSION,
  buildServerReceivableQuoteVersion,
  planCustomerReceivableFoldConsent,
  planReceivableReservedTotalMatchesConsent,
} from "./customerReceivableConsentSSOT.ts";
import { assertBookingPreauthAmount } from "./bookingPreauthAmountGuardSSOT.ts";
import { planRevolutCompletionCapture } from "./revolutPaymentHoldSSOT.ts";

const MK = "cb58f1bd-8b6f-45b9-ad31-b3140309892c";
const MK_FIXED_250 = {
  enable_preauth_buffer: true,
  buffer_type: "fixed",
  buffer_value: 2.5,
  min_hold_pence: null,
  max_hold_pence: null,
};

type Cfg = Record<string, unknown> | null;

/** Minimal Supabase fake: preauth settings read + booking_payment_quotes issue. */
function fakeSupabase(cfg: Cfg, existingQuote: Record<string, unknown> | null = null) {
  const inserted: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const settingsReads: string[] = [];
  const client = {
    from(table: string) {
      let pendingInsert: Record<string, unknown> | null = null;
      let pendingUpdate: Record<string, unknown> | null = null;
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select() {
          return chain;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        insert(row: Record<string, unknown>) {
          pendingInsert = row;
          return chain;
        },
        update(patch: Record<string, unknown>) {
          pendingUpdate = patch;
          return chain;
        },
        maybeSingle() {
          if (table === "service_area_preauth_settings") {
            settingsReads.push(String(filters.service_area_id));
            return Promise.resolve({
              data: filters.service_area_id === MK ? cfg : null,
              error: null,
            });
          }
          if (table === "booking_payment_quotes") {
            return Promise.resolve({ data: existingQuote, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        single() {
          if (pendingInsert) {
            inserted.push(pendingInsert);
            return Promise.resolve({
              data: { id: `quote-${inserted.length}`, ...pendingInsert },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: unknown) => void) {
          if (pendingUpdate) updates.push({ ...filters, ...pendingUpdate });
          resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
  return { client, inserted, updates, settingsReads };
}

const BASE_BODY = {
  client_action_id: "11111111-1111-4111-8111-111111111111",
  trip_fare_pence: 771,
  currency: "gbp",
  service_area_id: MK,
  vehicle_type_id: "vt-standard",
  ride_category: "vt-standard",
  pickup: { lat: 52.04, lng: -0.76 },
  dropoff: { lat: 52.01, lng: -0.73 },
  stops: [],
};

const SERVER_FARE_QUOTE_ID = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";

/**
 * The trip fare comes from the server fare artifact (771 for MK). Any
 * trip_fare_pence / buffer_pence in the client body is noise.
 */
async function issueFromBody(
  body: Record<string, unknown>,
  cfg: Cfg = MK_FIXED_250,
  opts: { serverTripFarePence?: number; serverDiscountApplied?: boolean } = {},
) {
  const fake = fakeSupabase(cfg);
  // deno-lint-ignore no-explicit-any
  const supabase = fake.client as any;
  const fields = parseBookingQuoteRequestBody(body);
  const serverTripFare = opts.serverTripFarePence ?? 771;
  const serverBuffer = await resolveBookingQuoteServerBuffer(supabase, {
    service_area_id: fields.service_area_id,
    server_trip_fare_pence: serverTripFare,
    server_discount_applied: opts.serverDiscountApplied === true,
  });
  const issued = await issueBookingPaymentQuote(supabase, {
    customer_id: "cust-1",
    user_id: "user-1",
    client_action_id: fields.client_action_id,
    service_area_id: fields.service_area_id,
    ride_category: fields.ride_category,
    route_fingerprint: fields.route_fingerprint,
    currency: fields.currency,
    server_trip_fare_pence: serverTripFare,
    server_fare_quote_id: SERVER_FARE_QUOTE_ID,
    pricing_fingerprint: `pf-test|t:${serverTripFare}|b:${serverBuffer.bufferPence}`,
    server_buffer: serverBuffer,
    server_outstanding_pence: 0,
    gate: { enabled: false, allowlist: new Set() },
  });
  if (!issued.ok) throw new Error(issued.error);
  return { quote: issued.quote, fake, fields };
}

Deno.test("1. MK fixed £2.50: fare 771 → buffer 250, total 1021 frozen on quote", async () => {
  const { quote, fake } = await issueFromBody(BASE_BODY);
  assertEquals(quote.trip_fare_pence, 771);
  assertEquals(quote.buffer_pence, 250);
  assertEquals(quote.total_authorisation_pence, 1021);
  assertEquals(fake.settingsReads, [MK]);
  const meta = fake.inserted[0].metadata as { buffer_source: Record<string, unknown> };
  assertEquals(meta.buffer_source.config_table, "public.service_area_preauth_settings");
  assertEquals(meta.buffer_source.buffer_type, "fixed");
  assertEquals(meta.buffer_source.buffer_value, 2.5);
});

Deno.test("2. client buffer_pence 0 is ignored → still 250", async () => {
  const { quote, fields } = await issueFromBody({ ...BASE_BODY, buffer_pence: 0 });
  assertEquals("buffer_pence" in fields, false);
  assertEquals(quote.buffer_pence, 250);
  assertEquals(quote.total_authorisation_pence, 1021);
});

Deno.test("3. malicious client buffer_pence 99999 is ignored → still 250", async () => {
  const { quote } = await issueFromBody({ ...BASE_BODY, buffer_pence: 99999 });
  assertEquals(quote.buffer_pence, 250);
  assertEquals(quote.total_authorisation_pence, 1021);
});

Deno.test("4. disabled buffer → 0 regardless of client value", async () => {
  const { quote } = await issueFromBody(
    { ...BASE_BODY, buffer_pence: 500 },
    { ...MK_FIXED_250, enable_preauth_buffer: false },
  );
  assertEquals(quote.buffer_pence, 0);
  assertEquals(quote.total_authorisation_pence, 771);
  const noRow = await issueFromBody({ ...BASE_BODY, buffer_pence: 500 }, null);
  assertEquals(noRow.quote.buffer_pence, 0);
});

Deno.test("5. percentage uses canonical ceil rounding", () => {
  // 771 × 12.5% = 96.375 → ceil 97 (Math.round would give 96).
  const r = computeServiceAreaPreauthBuffer(
    { enable_preauth_buffer: true, buffer_type: "percentage", buffer_value: 12.5 },
    771,
    MK,
  );
  assertEquals(r.bufferPence, 97);
  // Exact percentage stays exact: 1000 × 20% = 200.
  assertEquals(
    computeServiceAreaPreauthBuffer(
      { enable_preauth_buffer: true, buffer_type: "percentage", buffer_value: 20 },
      1000,
      MK,
    ).bufferPence,
    200,
  );
});

Deno.test("6. min_hold clamp raises the hold; skipped when discounted (voucher)", async () => {
  const cfg = { ...MK_FIXED_250, min_hold_pence: 1500 };
  const r = computeServiceAreaPreauthBuffer(cfg, 771, MK);
  assertEquals(r.bufferPence, 729);
  assertEquals(771 + r.bufferPence, 1500);
  const skipped = computeServiceAreaPreauthBuffer(cfg, 771, MK, { skipMinHoldWhenDiscounted: true });
  assertEquals(skipped.bufferPence, 250);
  const { quote } = await issueFromBody(BASE_BODY, cfg, { serverDiscountApplied: true });
  assertEquals(quote.buffer_pence, 250);
  // A client voucher_id is not a server discount and cannot skip min_hold.
  const { quote: clientVoucher } = await issueFromBody({ ...BASE_BODY, voucher_id: "v-1" }, cfg);
  assertEquals(clientVoucher.buffer_pence, 729);
  const { quote: noVoucher } = await issueFromBody(BASE_BODY, cfg);
  assertEquals(noVoucher.buffer_pence, 729);
});

Deno.test("7. max_hold clamp caps the hold; buffer never negative", () => {
  const capped = computeServiceAreaPreauthBuffer({ ...MK_FIXED_250, max_hold_pence: 900 }, 771, MK);
  assertEquals(capped.bufferPence, 129);
  const belowFare = computeServiceAreaPreauthBuffer(
    { ...MK_FIXED_250, max_hold_pence: 500 },
    771,
    MK,
  );
  assertEquals(belowFare.bufferPence, 0);
});

Deno.test("7b. no service area → no buffer and no settings read", async () => {
  const fake = fakeSupabase(MK_FIXED_250);
  // deno-lint-ignore no-explicit-any
  const r = await resolvePreauthBuffer(fake.client as any, 771, null);
  assertEquals(r.bufferPence, 0);
  assertEquals(fake.settingsReads.length, 0);
});

Deno.test("7c. unexpired quote with a stale buffer is not reused", async () => {
  const fields = parseBookingQuoteRequestBody(BASE_BODY);
  const stale = {
    id: "quote-old",
    customer_id: "cust-1",
    user_id: "user-1",
    client_action_id: fields.client_action_id,
    service_area_id: MK,
    ride_category: fields.ride_category,
    route_fingerprint: fields.route_fingerprint,
    currency: "gbp",
    trip_fare_pence: 771,
    buffer_pence: 0,
    receivable_pence: 0,
    total_authorisation_pence: 771,
    fold_eligible: false,
    consent_version: 1,
    state: "ISSUED",
    consumed_payment_session_id: null,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    metadata: {},
  };
  const fake = fakeSupabase(MK_FIXED_250, stale);
  // deno-lint-ignore no-explicit-any
  const supabase = fake.client as any;
  const serverBuffer = await resolveBookingQuoteServerBuffer(supabase, {
    service_area_id: MK,
    server_trip_fare_pence: 771,
    server_discount_applied: false,
  });
  const issued = await issueBookingPaymentQuote(supabase, {
    customer_id: "cust-1",
    user_id: "user-1",
    client_action_id: fields.client_action_id,
    service_area_id: MK,
    ride_category: fields.ride_category,
    route_fingerprint: fields.route_fingerprint,
    currency: "gbp",
    server_trip_fare_pence: 771,
    server_fare_quote_id: SERVER_FARE_QUOTE_ID,
    pricing_fingerprint: `pf-test|t:771|b:${serverBuffer.bufferPence}`,
    server_buffer: serverBuffer,
    server_outstanding_pence: 0,
    gate: { enabled: false, allowlist: new Set() },
  });
  assertEquals(issued.ok, true);
  if (issued.ok) {
    assertEquals(issued.reused, false);
    assertEquals(issued.quote.buffer_pence, 250);
    assertEquals(issued.quote.total_authorisation_pence, 1021);
  }
  assertEquals(fake.updates[0]?.state, "CANCELLED");
});

function quoteRow(overrides: Partial<BookingPaymentQuoteRow> = {}): BookingPaymentQuoteRow {
  return {
    id: "q-1",
    customer_id: "cust-1",
    user_id: "user-1",
    client_action_id: "ca-1",
    service_area_id: MK,
    ride_category: "vt-standard",
    route_fingerprint: "fp",
    currency: "gbp",
    trip_fare_pence: 771,
    buffer_pence: 250,
    receivable_pence: 0,
    total_authorisation_pence: 1021,
    fold_eligible: false,
    consent_version: 1,
    state: "ISSUED",
    consumed_payment_session_id: null,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    metadata: {},
    ...overrides,
  };
}

Deno.test("8. create-preauth consumes quote fare + frozen buffer (no recompute)", async () => {
  const amounts = resolvePreauthAmountsFromQuote(quoteRow());
  assertEquals(amounts.trip_fare_pence, 771);
  assertEquals(amounts.buffer_pence, 250);
  assertEquals(amounts.total_authorisation_pence, 1021);

  const src = await Deno.readTextFile(
    new URL("../create-preauth-payment-intent/index.ts", import.meta.url),
  );
  // Single canonical resolver, imported — no local copy.
  assertStringIncludes(src, 'from "../_shared/preauthBufferResolverSSOT.ts"');
  assertEquals(/async function resolvePreauthBuffer\s*\(/.test(src), false);
  assertEquals(src.includes('.from("service_area_preauth_settings")'), false);
  // Opaque quote branch uses the frozen row buffer.
  const opaqueIdx = src.indexOf("if (preloadedOpaqueQuote) {");
  const elseIdx = src.indexOf("} else {", opaqueIdx);
  const branch = src.slice(opaqueIdx, elseIdx);
  assertStringIncludes(branch, "bufferPence = preloadedOpaqueQuote.buffer_pence;");
  assertEquals(branch.includes("resolvePreauthBuffer("), false);
});

Deno.test("9. Revolut order amount on the opaque path is the quote total 1021", async () => {
  const amounts = resolvePreauthAmountsFromQuote(quoteRow());
  const guard = assertBookingPreauthAmount({
    estimatedTotalPence: amounts.trip_fare_pence,
    authorisedAmountPence: amounts.total_authorisation_pence,
  });
  assertEquals(guard.ok, true);
  if (guard.ok) assertEquals(guard.authorisedAmountPence, 1021);

  const src = await Deno.readTextFile(new URL("./revolutPreauth.ts", import.meta.url));
  assertStringIncludes(src, "authorisedAmountPence = amounts.total_authorisation_pence;");
  assertStringIncludes(src, "amountMinor: authorisedAmountPence,");
  assertStringIncludes(src, "bufferPence: bufferPenceForSession,");
});

Deno.test("10. completion captures the final fare 771, releases the 250 buffer", () => {
  const plan = planRevolutCompletionCapture({
    finalFarePence: 771,
    authorisedHoldPence: 1021,
    bufferPence: 250,
  });
  assertEquals(plan.kind, "capture_within_hold");
  if (plan.kind === "capture_within_hold") {
    assertEquals(plan.capture_amount_pence, 771);
    assertEquals(plan.release_remainder_pence, 250);
  }
});

const gateOn = { enabled: true, allowlist: new Set<string>() };

Deno.test("11. consent: fare-only display does not fail when a buffer is configured", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 0,
    server_ride_fare_pence: 771,
    server_buffer_pence: 250,
    gate: gateOn,
    consent: {
      customer_receivable_consent_version: CUSTOMER_RECEIVABLE_CONSENT_VERSION,
      customer_receivable_displayed_outstanding_pence: 0,
      customer_receivable_displayed_trip_fare_pence: 771,
      customer_receivable_displayed_total_authorisation_pence: 771,
    },
  });
  assertEquals(d.allow_fold, true);
  assertEquals("fail_closed" in d && d.fail_closed, false);
});

Deno.test("11b. consent: fold display (fare + debt) passes with buffer; outstanding protections intact", () => {
  const consent = {
    customer_receivable_consent_version: CUSTOMER_RECEIVABLE_CONSENT_VERSION,
    customer_receivable_displayed_outstanding_pence: 36,
    customer_receivable_quote_version: buildServerReceivableQuoteVersion(36),
    customer_receivable_displayed_trip_fare_pence: 771,
    customer_receivable_displayed_total_authorisation_pence: 807,
  };
  const ok = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    server_ride_fare_pence: 771,
    server_buffer_pence: 250,
    gate: gateOn,
    consent,
  });
  assertEquals(ok.allow_fold, true);
  assertEquals(
    (ok as { telemetry: Record<string, unknown> }).telemetry.server_total_authorisation_pence,
    1057,
  );

  const missingDebt = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    server_ride_fare_pence: 771,
    server_buffer_pence: 250,
    gate: gateOn,
    consent: { ...consent, customer_receivable_displayed_total_authorisation_pence: 771 },
  });
  assertEquals("fail_closed" in missingDebt && missingDebt.fail_closed, true);
  assertEquals(
    (missingDebt as { telemetry: { note?: string } }).telemetry.note,
    "displayed_total_authorisation_mismatch",
  );

  const changedDebt = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 50,
    server_ride_fare_pence: 771,
    server_buffer_pence: 250,
    gate: gateOn,
    consent,
  });
  assertEquals("fail_closed" in changedDebt && changedDebt.fail_closed, true);

  const gateOff = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    server_ride_fare_pence: 771,
    server_buffer_pence: 250,
    gate: { enabled: false, allowlist: new Set() },
    consent,
  });
  assertEquals("fail_closed" in gateOff && gateOff.fail_closed, true);
});

Deno.test("11c. post-reserve check compares buffer-excluded amounts", () => {
  // reserved authorised = 771 + 250 + 36 = 1057; customer agreed to 807.
  assertEquals(
    planReceivableReservedTotalMatchesConsent({
      reserved_authorised_amount_pence: 1057,
      displayed_total_authorisation_pence: 807,
      buffer_pence: 250,
    }).ok,
    true,
  );
  // Debt grew during reserve → fail closed.
  assertEquals(
    planReceivableReservedTotalMatchesConsent({
      reserved_authorised_amount_pence: 1071,
      displayed_total_authorisation_pence: 807,
      buffer_pence: 250,
    }).ok,
    false,
  );
});

Deno.test("12. quote handler never reads a client buffer and requires a service area", async () => {
  const handler = await Deno.readTextFile(
    new URL("../customer-receivable-booking-quote/index.ts", import.meta.url),
  );
  assertEquals(/buffer_pence/.test(handler.replace(/\/\*\*[\s\S]*?\*\//, "")), false);
  assertStringIncludes(handler, "issueServerAuthoritativeBookingQuote(admin, { userId: user.id, body })");
  const src = await Deno.readTextFile(new URL("./serverBookingQuoteIssue.ts", import.meta.url));
  assertEquals(/body\.buffer_pence/.test(src), false);
  assertStringIncludes(src, "resolveBookingQuoteServerBuffer(admin, {");
  assertStringIncludes(src, "server_trip_fare_pence: serverTripFarePence,");
  assertStringIncludes(src, "server_buffer: serverBuffer");
  assertStringIncludes(src, "service_area_id_required");
  assertStringIncludes(src, "service_area_invalid");

  const ssot = await Deno.readTextFile(new URL("./bookingPaymentQuoteSSOT.ts", import.meta.url));
  const parseStart = ssot.indexOf("export function parseBookingQuoteRequestBody");
  const parseEnd = ssot.indexOf("\n}\n", parseStart);
  assertEquals(ssot.slice(parseStart, parseEnd).includes("buffer"), false);
});
