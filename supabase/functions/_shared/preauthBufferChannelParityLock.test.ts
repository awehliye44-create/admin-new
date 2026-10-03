/**
 * Lock: preauth buffer CHANNEL PARITY.
 *
 * Every PLATFORM_COLLECTED / PLATFORM_PREPAID card booking authorises
 *   hold = server fare + service-area buffer (resolvePreauthBuffer)
 * whether it starts in the Customer App, WhatsApp / guest web checkout
 * (create-guest-payment-intent) or create-corporate-book.
 *
 * Defect: create-guest-payment-intent created the Revolut order for the fare
 * only (MK-261003-002: fare 500, hold 500, MK config fixed £2.50) and
 * create-corporate-book hard-coded bufferPence: 0.
 *
 * The buffer is not fare, not commissionable, not driver earnings, not invoice
 * fare and is never auto-captured; the unused part is released.
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildChannelPreauthFareSnapshotFields,
  resolveChannelPreauthAmounts,
} from "./channelPreauthAmountsSSOT.ts";
import {
  issueBookingPaymentQuote,
  resolveBookingQuoteServerBuffer,
  resolvePreauthAmountsFromQuote,
} from "./bookingPaymentQuoteSSOT.ts";
import { assertBookingPreauthAmount } from "./bookingPreauthAmountGuardSSOT.ts";
import { planRevolutCompletionCapture } from "./revolutPaymentHoldSSOT.ts";
import { resolveTerminalPaymentDecision, type FarePricingFeeConfig } from "./terminalFeeDecisionSSOT.ts";
import { buildMinimalTripInsertRow } from "./bookingSSOT.ts";

const MK = "cb58f1bd-8b6f-45b9-ad31-b3140309892c";
const VT = "vt-standard";
const MK_FIXED_250 = {
  enable_preauth_buffer: true,
  buffer_type: "fixed",
  buffer_value: 2.5,
  min_hold_pence: null,
  max_hold_pence: null,
};
const SERVER_FARE = 500;

const fnSource = (slug: string) =>
  Deno.readTextFile(new URL(`../${slug}/index.ts`, import.meta.url));

/** Settings read + booking_payment_quotes issue (Customer App opaque-quote path). */
function fakeSupabase(cfg: Record<string, unknown> | null) {
  const settingsReads: string[] = [];
  const client = {
    from(table: string) {
      let pendingInsert: Record<string, unknown> | null = null;
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        insert(row: Record<string, unknown>) {
          pendingInsert = row;
          return chain;
        },
        update: () => chain,
        maybeSingle() {
          if (table === "service_area_preauth_settings") {
            settingsReads.push(String(filters.service_area_id));
            return Promise.resolve({ data: filters.service_area_id === MK ? cfg : null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        single() {
          return Promise.resolve({ data: { id: "quote-1", ...(pendingInsert ?? {}) }, error: null });
        },
        then(resolve: (v: unknown) => void) {
          resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
  // deno-lint-ignore no-explicit-any
  return { client: client as any, settingsReads };
}

async function customerAppHold(cfg = MK_FIXED_250) {
  const fake = fakeSupabase(cfg);
  const serverBuffer = await resolveBookingQuoteServerBuffer(fake.client, {
    service_area_id: MK,
    server_trip_fare_pence: SERVER_FARE,
    server_discount_applied: false,
  });
  const issued = await issueBookingPaymentQuote(fake.client, {
    customer_id: "cust-1",
    user_id: "user-1",
    client_action_id: "11111111-1111-4111-8111-111111111111",
    service_area_id: MK,
    ride_category: VT,
    route_fingerprint: "fp",
    currency: "gbp",
    server_trip_fare_pence: SERVER_FARE,
    server_fare_quote_id: "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
    pricing_fingerprint: `pf-test|t:${SERVER_FARE}|b:${serverBuffer.bufferPence}`,
    server_buffer: serverBuffer,
    server_outstanding_pence: 0,
    gate: { enabled: false, allowlist: new Set() },
  });
  if (!issued.ok) throw new Error(issued.error);
  const a = resolvePreauthAmountsFromQuote(issued.quote);
  return { fare: a.trip_fare_pence, buffer: a.buffer_pence, hold: a.total_authorisation_pence };
}

async function channelHold(cfg: Record<string, unknown> | null = MK_FIXED_250) {
  const fake = fakeSupabase(cfg);
  const a = await resolveChannelPreauthAmounts(fake.client, SERVER_FARE, MK);
  return { fare: a.farePence, buffer: a.bufferPence, hold: a.authorisedAmountPence, amounts: a, fake };
}

// ── Guest handler harness: real create-guest-payment-intent, routed fetch ──

const SUPA = "https://stub-project.supabase.co";
const FAKE_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln";
const GUEST_PHONE = "+447911123456";
const GUEST_USER = "00000000-0000-4000-8000-0000000000aa";
const GUEST_CUSTOMER = "00000000-0000-4000-8000-0000000000bb";

type GuestRun = {
  status: number;
  revolutOrderBodies: Record<string, unknown>[];
  sessionRows: Record<string, unknown>[];
  settingsReads: number;
};

let guestHandler: ((req: Request) => Promise<Response>) | null = null;

async function loadGuestHandler() {
  if (guestHandler) return guestHandler;
  const env: Record<string, string> = {
    SUPABASE_URL: SUPA,
    SUPABASE_SERVICE_ROLE_KEY: "service-role-stub",
    SUPABASE_ANON_KEY: FAKE_JWT,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-stub",
    WHATSAPP_PHONE_NUMBER_ID: "phone-number-stub",
    REVOLUT_MERCHANT_SECRET_KEY: "sk_sandbox_stub",
    ONECAB_PUBLIC_ORIGIN: "https://onecab.example",
  };
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  const original = Object.getOwnPropertyDescriptor(Deno, "serve")!;
  Object.defineProperty(Deno, "serve", {
    configurable: true,
    writable: true,
    value: (h: (req: Request) => Promise<Response>) => {
      guestHandler = h;
      return {};
    },
  });
  try {
    await import("../create-guest-payment-intent/index.ts");
  } finally {
    Object.defineProperty(Deno, "serve", original);
  }
  if (!guestHandler) throw new Error("guest handler not captured");
  return guestHandler;
}

function pgrst(req: Request, rows: unknown[]): Response {
  const wantsObject = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object");
  if (wantsObject) {
    if (rows.length === 0) {
      return new Response(JSON.stringify({ code: "PGRST116", message: "0 rows" }), { status: 406 });
    }
    return Response.json(rows[0]);
  }
  return Response.json(rows);
}

async function runGuest(
  body: Record<string, unknown>,
  cfg: Record<string, unknown> | null = MK_FIXED_250,
): Promise<GuestRun> {
  const handler = await loadGuestHandler();
  const run: GuestRun = { status: 0, revolutOrderBodies: [], sessionRows: [], settingsReads: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    if (url.hostname.endsWith("revolut.com")) {
      if (method === "POST" && url.pathname.endsWith("/orders")) {
        const sent = await req.json();
        run.revolutOrderBodies.push(sent);
        return Response.json({
          id: `ord-${run.revolutOrderBodies.length}`,
          state: "pending",
          amount: sent.amount,
          currency: sent.currency,
          checkout_url: "https://sandbox-checkout.revolut.com/payment-link/stub",
        });
      }
      throw new Error(`unrouted Revolut call ${method} ${url.pathname}`);
    }
    if (url.origin !== SUPA) throw new Error(`unrouted network call ${req.url}`);
    const path = url.pathname;
    if (path === "/functions/v1/resolve-service-area") {
      return Response.json({ success: true, settings: { service_area_id: MK } });
    }
    if (path === "/functions/v1/calculate-route") {
      return Response.json({ success: true, distanceKm: 3.4, durationMinutes: 9 });
    }
    if (path === "/functions/v1/calculate-fare") {
      return Response.json({
        success: true,
        vehicleFares: [{ vehicleTypeId: VT, fare: { totalFarePence: SERVER_FARE } }],
      });
    }
    if (path === `/auth/v1/admin/users/${GUEST_USER}`) {
      return Response.json({
        id: GUEST_USER,
        aud: "authenticated",
        email: "guest@example.test",
        email_confirmed_at: "2026-10-01T00:00:00Z",
        phone: GUEST_PHONE.slice(1),
        phone_confirmed_at: "2026-10-01T00:00:00Z",
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-10-01T00:00:00Z",
      });
    }
    const table = path.startsWith("/rest/v1/") ? path.slice("/rest/v1/".length) : "";
    switch (table) {
      case "payment_sessions":
        if (method === "POST") {
          const row = await req.json();
          run.sessionRows.push(Array.isArray(row) ? row[0] : row);
          return pgrst(req, [{ id: "sess-1" }]);
        }
        return pgrst(req, []);
      case "service_areas":
        return pgrst(req, [{
          id: MK,
          financial_model: "PLATFORM_COLLECTED",
          commission_wallet_enabled: false,
          customer_payment_policy: "PLATFORM_PREPAID",
          currency_code: "GBP",
        }]);
      case "service_area_payment_methods":
        return pgrst(req, []);
      case "service_area_preauth_settings":
        run.settingsReads++;
        return pgrst(req, url.searchParams.get("service_area_id") === `eq.${MK}` && cfg ? [cfg] : []);
      case "payment_provider_vault":
        return pgrst(req, []);
      case "account_email_verifications":
        return pgrst(req, []);
      case "customers":
        return pgrst(req, [{
          id: GUEST_CUSTOMER,
          user_id: GUEST_USER,
          phone: GUEST_PHONE,
          phone_verified: true,
          email_verified: true,
          rider_status: "active",
          deleted_at: null,
        }]);
    }
    throw new Error(`unrouted Supabase call ${method} ${path}`);
  };
  try {
    const res = await handler(new Request("https://edge.local/create-guest-payment-intent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250)}`,
      },
      body: JSON.stringify({
        source: "whatsapp_booking",
        service_area_id: MK,
        vehicle_type_id: VT,
        currency: "GBP",
        payment_method: "card",
        pickup_address: "Central Milton Keynes",
        pickup_lat: 52.04,
        pickup_lng: -0.76,
        dropoff_address: "Bletchley",
        dropoff_lat: 51.99,
        dropoff_lng: -0.73,
        stops: [],
        customer_name: "Guest Rider",
        customer_phone: GUEST_PHONE,
        client_request_id: crypto.randomUUID(),
        ...body,
      }),
    }));
    run.status = res.status;
    await res.body?.cancel();
  } finally {
    globalThis.fetch = realFetch;
  }
  return run;
}

// ── 1. Parity ──────────────────────────────────────────────────────────────

Deno.test("1. MK fixed 250: Customer, Guest and create-corporate-book all hold fare 500 + buffer 250 = 750", async () => {
  const customer = await customerAppHold();
  const channel = await channelHold();
  assertEquals(customer, { fare: 500, buffer: 250, hold: 750 });
  assertEquals({ fare: channel.fare, buffer: channel.buffer, hold: channel.hold }, customer);
  assertEquals(channel.fake.settingsReads, [MK]);
  assertEquals(channel.amounts.bufferSource.config_table, "public.service_area_preauth_settings");
  assertEquals(channel.amounts.bufferSource.buffer_type, "fixed");
  assertEquals(channel.amounts.bufferSource.buffer_value, 2.5);

  const guest = await runGuest({});
  assertEquals(guest.status, 200);
  assertEquals(guest.revolutOrderBodies.length, 1);
  assertEquals(guest.revolutOrderBodies[0].amount, customer.hold);
});

Deno.test("1b. buffer follows config (not a hard-coded 250): disabled → hold = fare; percentage → ceil", async () => {
  const off = await channelHold({ ...MK_FIXED_250, enable_preauth_buffer: false });
  assertEquals([off.buffer, off.hold], [0, 500]);
  const pct = await channelHold({ ...MK_FIXED_250, buffer_type: "percentage", buffer_value: 12.5 });
  assertEquals([pct.buffer, pct.hold], [63, 563]);
  const customerPct = await customerAppHold({ ...MK_FIXED_250, buffer_type: "percentage", buffer_value: 12.5 });
  assertEquals(customerPct.hold, pct.hold);
  const guestOff = await runGuest({}, { ...MK_FIXED_250, enable_preauth_buffer: false });
  assertEquals(guestOff.revolutOrderBodies[0].amount, 500);
  for (const slug of ["create-guest-payment-intent", "create-corporate-book"]) {
    const src = await fnSource(slug);
    assertEquals(/\b250\b/.test(src), false, `${slug} must not hard-code 250`);
    assertEquals(/\b2\.5\b/.test(src), false, `${slug} must not hard-code 2.5`);
  }
});

// ── 2. Source locks ─────────────────────────────────────────────────────────

Deno.test("2. guest + corporate-book use the canonical resolver; no zero buffer, no fare-only order", async () => {
  const guest = await fnSource("create-guest-payment-intent");
  assertStringIncludes(guest, 'from "../_shared/channelPreauthAmountsSSOT.ts"');
  assertStringIncludes(guest, "resolveChannelPreauthAmounts(supabase, priced.amountPence, service_area_id)");
  assertStringIncludes(guest, "amountMinor: preauth.authorisedAmountPence,");
  assertEquals(guest.includes("amountMinor: priced.amountPence"), false);
  assertStringIncludes(guest, "authorisedAmountPence: preauth.authorisedAmountPence,");
  assertStringIncludes(guest, "bufferPence: preauth.bufferPence,");
  assertStringIncludes(guest, "...buildChannelPreauthFareSnapshotFields(preauth),");

  const corp = await fnSource("create-corporate-book");
  assertStringIncludes(corp, 'from "../_shared/channelPreauthAmountsSSOT.ts"');
  assertStringIncludes(corp, "resolveChannelPreauthAmounts(admin, estimatedFarePence, serviceAreaId)");
  assertEquals(/bufferPence:\s*0\b/.test(corp), false);
  assertStringIncludes(corp, "authorisedAmountPence: preauth.authorisedAmountPence,");
  assertStringIncludes(corp, "bufferPence: preauth.bufferPence,");
  assertStringIncludes(corp, "...buildChannelPreauthFareSnapshotFields(preauth),");

  const helper = await Deno.readTextFile(new URL("./channelPreauthAmountsSSOT.ts", import.meta.url));
  assertStringIncludes(helper, 'from "./preauthBufferResolverSSOT.ts"');
  assertEquals(helper.includes('.from("service_area_preauth_settings")'), false);
});

Deno.test("2b. guest never reads client amount / buffer / authorised / hold from the body", async () => {
  const guest = await fnSource("create-guest-payment-intent");
  const start = guest.indexOf("const {\n    service_area_id,");
  const end = guest.indexOf("} = body;", start);
  assert(start > 0 && end > start, "body destructure not found");
  const destructured = guest.slice(start, end);
  for (const field of ["amount", "buffer", "authorised", "hold", "total"]) {
    assertEquals(destructured.includes(field), false, `body field ${field} must not be read`);
  }
  assertEquals(/body\.(amount|buffer_pence|authorised|hold|total)/.test(guest), false);
});

// ── 3. Tamper ───────────────────────────────────────────────────────────────

for (const tamper of [
  { amount: 0 },
  { amount: 1 },
  { amount: 500 },
  { amount: 99999 },
  { buffer_pence: 0 },
  { amount: 1, buffer_pence: 0, authorised_amount_pence: 1, hold_pence: 1 },
]) {
  Deno.test(`3. guest tamper ${JSON.stringify(tamper)} → Revolut order 750`, async () => {
    const run = await runGuest(tamper);
    assertEquals(run.status, 200);
    assertEquals(run.revolutOrderBodies.length, 1);
    assertEquals(run.revolutOrderBodies[0].amount, 750);
    assertEquals(run.sessionRows[0].estimated_total_pence, 500);
    assertEquals(run.sessionRows[0].authorised_amount_pence, 750);
    assertEquals(run.sessionRows[0].buffer_pence, 250);
  });
}

// ── 4. Persistence ──────────────────────────────────────────────────────────

Deno.test("4. guest session persists fare 500 / authorised 750 / buffer 250 with source evidence", async () => {
  const run = await runGuest({ amount: 99999 });
  const order = run.revolutOrderBodies[0] as {
    amount: number;
    capture_mode?: string;
    authorisation_type?: string;
    metadata?: Record<string, string>;
  };
  assertEquals(order.amount, 750);
  assertEquals(order.capture_mode, "manual");
  assertEquals(order.authorisation_type, "pre_authorisation");
  assertEquals(order.metadata?.estimated_total_pence, "500");
  assertEquals(order.metadata?.buffer_pence, "250");
  assertEquals(order.metadata?.authorised_amount_pence, "750");

  const row = run.sessionRows[0];
  assertEquals(row.estimated_total_pence, 500);
  assertEquals(row.authorised_amount_pence, 750);
  assertEquals(row.buffer_pence, 250);
  const snap = row.fare_snapshot as Record<string, unknown>;
  assertEquals(snap.final_fare_pence, 500);
  assertEquals(snap.estimated_total_pence, 500);
  assertEquals(snap.gross_fare_pence, 500);
  assertEquals(snap.buffer_pence, 250);
  assertEquals(snap.authorised_amount_pence, 750);
  assertEquals((snap.buffer_source as Record<string, unknown>).config_table, "public.service_area_preauth_settings");
  const meta = row.metadata as Record<string, unknown>;
  assertEquals(meta.buffer_pence, 250);
  assertEquals((meta.buffer_source as Record<string, unknown>).buffer_type, "fixed");
});

Deno.test("4b. payable resolves to the fare, never the hold (create-trip-after-payment key order)", async () => {
  const run = await runGuest({});
  const snap = run.sessionRows[0].fare_snapshot as Record<string, unknown>;
  const ctap = await fnSource("create-trip-after-payment");
  const listMatch = ctap.match(/const sessionPayablePence[\s\S]*?for \(const key of \[([\s\S]*?)\]\)/);
  assert(listMatch, "create-trip-after-payment payable key list not found");
  const keys = [...listMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert(keys.indexOf("final_fare_pence") < keys.indexOf("authorised_amount_pence"));
  const payable = keys.map((k) => Math.round(Number(snap[k] ?? 0))).find((n) => n > 0);
  assertEquals(payable, 500);

  const fields = buildChannelPreauthFareSnapshotFields((await channelHold()).amounts);
  const order = Object.keys(fields);
  assert(order.indexOf("final_fare_pence") < order.indexOf("authorised_amount_pence"));
  assert(order.indexOf("estimated_total_pence") < order.indexOf("authorised_amount_pence"));
});

Deno.test("4c. trip insert: customer fare 500, preauth_buffer_pence 250, authorised 750", async () => {
  const run = await runGuest({});
  const trip = buildMinimalTripInsertRow({
    body: {
      client_action_id: "ca-guest",
      pickup: { address: "A", lat: 52.04, lng: -0.76 },
      dropoff: { address: "B", lat: 51.99, lng: -0.73 },
      estimated_fare: 7.5,
      booking_source: "whatsapp_booking",
      payment_method: "card",
    } as unknown as Parameters<typeof buildMinimalTripInsertRow>[0]["body"],
    customerId: GUEST_CUSTOMER,
    serviceAreaId: MK,
    serviceAreaCode: "MK",
    regionId: null,
    regionCurrencyCode: "GBP",
    regionDistanceUnit: "mi",
    paymentProvider: "revolut",
    paymentRefId: "ord-1",
    preauthAmountPence: 750,
    paymentSessionId: "sess-1",
    sessionFareSnapshot: run.sessionRows[0].fare_snapshot as Record<string, unknown>,
  });
  assertEquals(trip.authorised_amount_pence, 750);
  assertEquals(trip.preauth_buffer_pence, 250);
  assertEquals(trip.final_fare_pence, 500);
  assertEquals(trip.estimated_total_pence, 500);
  assertEquals(trip.gross_fare_pence, 500);
});

Deno.test("4d. buffer never reaches commission / earnings / invoice / settlement / payout / ledger code", async () => {
  const dir = new URL("./", import.meta.url);
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    if (!/commission|earning|invoice|settlement|payout|ledger/i.test(entry.name)) continue;
    const src = await Deno.readTextFile(new URL(entry.name, dir));
    if (/buffer_pence|bufferPence|preauth_buffer/.test(src)) offenders.push(entry.name);
  }
  assertEquals(offenders, []);
});

// ── 5. Capture / release ────────────────────────────────────────────────────

Deno.test("5. completion captures fare 500, releases buffer 250", () => {
  const plan = planRevolutCompletionCapture({ finalFarePence: 500, authorisedHoldPence: 750, bufferPence: 250 });
  assertEquals(plan.kind, "capture_within_hold");
  if (plan.kind === "capture_within_hold") {
    assertEquals(plan.capture_amount_pence, 500);
    assertEquals(plan.release_remainder_pence, 250);
  }
  const guard = assertBookingPreauthAmount({ estimatedTotalPence: 500, authorisedAmountPence: 750 });
  assertEquals(guard.ok, true);
});

const NO_FEES: FarePricingFeeConfig = {
  cancellation_fee_pence: 0,
  cancellation_grace_period_minutes: null,
  cancellation_apply_after_arrival_only: null,
  no_show_fee_pence: 0,
  no_show_wait_time_minutes: null,
  no_show_apply_after_arrival_only: null,
  late_cancel_enabled: false,
  late_cancel_threshold_minutes: null,
  late_cancel_fee_pence: 0,
  arrival_cancellation_enabled: false,
  arrival_cancellation_fee_pence: 0,
  arrival_cancellation_apply_after_free_waiting_expired: null,
  arrival_cancellation_after_arrival_only: null,
  free_waiting_minutes: null,
};

Deno.test("5b. free cancellation captures 0, releases the full 750 hold", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: {
      trip_id: "trip-guest",
      trip_status: "cancelled",
      started_at: null,
      arrived_at: null,
      free_wait_expires_at: null,
      cancelled_at: "2026-10-03T10:00:00Z",
      cancelled_by: "customer",
      scheduled_at: null,
      cancellation_grace_expires_at: null,
      driver_id: null,
      confirmed_driver_id: null,
      no_show_recorded: false,
      authorised_amount_pence: 750,
      previously_captured_amount_pence: 0,
      payment_session_id: "sess-1",
      provider: "revolut",
      decision_at: "2026-10-03T10:00:00Z",
    },
    config: NO_FEES,
  });
  assertEquals(d.disposition_reason, "NO_FEE_FULL_RELEASE");
  assertEquals(d.capture_required_pence, 0);
  assertEquals(d.release_required_pence, 750);
  assertEquals(d.provider_action, "void_full");
});
