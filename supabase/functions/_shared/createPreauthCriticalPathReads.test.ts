/**
 * create-preauth read overlap: saved-card token read once, currency read in the parallel
 * group, Revolut provider config read overlapping the service-area read. Every gate still
 * resolves before any Revolut operation.
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkServiceAreaGatewayForBooking } from "./paymentGatewayGuard.ts";
import { resolveProviderGatewayStatus, startProviderConfigRead } from "./paymentGatewayStatus.ts";

type Row = Record<string, unknown> | null;

function fakeDb(opts: {
  serviceArea?: Row;
  configs?: Record<string, Row>;
  configThrows?: boolean;
  saDelayMs?: number;
}) {
  const events: string[] = [];
  const builder = (table: string) => {
    let eqVal: unknown = null;
    const b = {
      select(_s: string) {
        return b;
      },
      eq(_c: string, v: unknown) {
        eqVal = v;
        return b;
      },
      async maybeSingle() {
        if (table === "service_areas") {
          events.push("sa_start");
          await new Promise((r) => setTimeout(r, opts.saDelayMs ?? 5));
          events.push("sa_end");
          return { data: opts.serviceArea ?? null, error: null };
        }
        if (table === "payment_provider_configs") {
          events.push(`config_start:${eqVal}`);
          await Promise.resolve();
          if (opts.configThrows) throw new Error("config read failed");
          events.push(`config_end:${eqVal}`);
          return { data: opts.configs?.[String(eqVal)] ?? null, error: null };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    return b;
  };
  return { client: { from: builder } as never, events };
}

const disabledRevolut = {
  provider: "revolut",
  display_name: "Revolut",
  environment: "live",
  is_enabled: false,
  supports_customer_payments: true,
  supports_driver_payouts: true,
};

Deno.test("gateway: Revolut config read starts before the service-area read finishes, read once", async () => {
  const db = fakeDb({
    serviceArea: { id: "sa", payment_provider: "revolut" },
    configs: { revolut: disabledRevolut },
  });
  const bundle = await checkServiceAreaGatewayForBooking(db.client, "sa", "customer");
  assert(db.events.indexOf("config_start:revolut") < db.events.indexOf("sa_end"));
  assertEquals(db.events.filter((e) => e.startsWith("config_start")).length, 1);
  assertEquals(bundle.check.ok, false);
  if (!bundle.check.ok) assert(bundle.check.reason.includes("disabled"));
});

Deno.test("gateway: service area on another provider ignores the speculative read", async () => {
  const db = fakeDb({
    serviceArea: { id: "sa", payment_provider: "other_psp" },
    configs: { revolut: disabledRevolut, other_psp: null },
  });
  const bundle = await checkServiceAreaGatewayForBooking(db.client, "sa", "customer");
  assert(db.events.includes("config_start:other_psp"));
  assertEquals(bundle.check.ok, false);
  if (!bundle.check.ok) assertEquals(bundle.check.provider, "other_psp");
});

Deno.test("gateway: service area missing → fail closed, speculative read never rejects unhandled", async () => {
  const db = fakeDb({ serviceArea: null, configThrows: true });
  const bundle = await checkServiceAreaGatewayForBooking(db.client, "sa", "customer");
  assertEquals(bundle.check.ok, false);
  if (!bundle.check.ok) assertEquals(bundle.check.reason, "Service area not found");
  await new Promise((r) => setTimeout(r, 10));
});

Deno.test("gateway: config read failure still propagates (same as the sequential read)", async () => {
  const db = fakeDb({ serviceArea: { id: "sa", payment_provider: "revolut" }, configThrows: true });
  await assertRejects(() => checkServiceAreaGatewayForBooking(db.client, "sa", "customer"), Error, "config read failed");
});

Deno.test("gateway: prefetched config for a different provider is not used", async () => {
  const db = fakeDb({ configs: { revolut: disabledRevolut, x: null } });
  const prefetched = startProviderConfigRead(db.client, "revolut");
  const status = await resolveProviderGatewayStatus(db.client, "x", "customer", { prefetchedConfig: prefetched });
  assertEquals(status.provider, "x");
  assert(db.events.includes("config_start:x"));
});

const preauth = Deno.readTextFileSync(new URL("../create-preauth-payment-intent/index.ts", import.meta.url));
const revolut = Deno.readTextFileSync(new URL("./revolutPreauth.ts", import.meta.url));

Deno.test("currency: read starts in the parallel group and is applied at the gate before Revolut", () => {
  const start = preauth.indexOf("regionCurrencyPrefetch = startRegionCurrencyRead(");
  const group = preauth.indexOf("await Promise.all([eligibilityP, fareP, customerP, gatewayP])");
  const gateOpaque = preauth.indexOf("? await takeRegionCurrency(regionCurrencyPrefetch)");
  const gateEstimate = preauth.indexOf("? takeRegionCurrency(regionCurrencyPrefetch)");
  const revolutCall = preauth.indexOf("await createRevolutPreauthResponse({");
  assert(start > 0 && start < group, "prefetch must start inside the parallel group");
  assert(gateOpaque > group && gateOpaque < revolutCall);
  assert(gateEstimate > group && gateEstimate < revolutCall);
  assert(preauth.includes("if (!r.ok) throw r.error;"), "currency failure re-throws at the gate");
  assert(preauth.includes("startRegionCurrencyRead(supabaseClient, body.service_area_id || null)"));
});

Deno.test("currency: legacy trip path keeps the trip-first sequential read", () => {
  const legacy = preauth.slice(preauth.indexOf("if (body.trip_id) {"), preauth.indexOf("} else {\n      // Quote-based path"));
  assertEquals(legacy.includes("regionCurrencyPrefetch ="), false);
  assert(preauth.includes("resolveRegionCurrency(\n          supabaseClient,\n          tripId,"));
});

Deno.test("saved card: provider token row read once on the new-order path", () => {
  const fn = revolut.slice(revolut.indexOf("export async function createRevolutPreauthResponse"));
  const main = fn.indexOf("const [tokenRow, revolutCustomerResolved] = await Promise.all([");
  const pass = fn.indexOf("preloadedTokenRow: tokenRow,");
  assert(main > 0 && pass > main);
  const attempt = revolut.slice(revolut.indexOf("async function attemptRevolutSavedCardCharge"));
  assert(attempt.includes("args.preloadedTokenRow !== undefined"));
  assert(attempt.includes(": await lookupProviderPaymentMethodToken(args.supabase"));
});

Deno.test("saved card: missing preloaded token still fails closed (no charge attempt)", () => {
  const attempt = revolut.slice(revolut.indexOf("async function attemptRevolutSavedCardCharge"));
  const guard = attempt.indexOf("if (!tokenRow?.provider_payment_method_id) {");
  const pay = attempt.indexOf("payRevolutOrderWithSavedCard(");
  assert(guard > 0 && pay > guard);
});

Deno.test("gates before Revolut: eligibility, quote, gateway, currency precede order creation", () => {
  const fn = revolut.slice(revolut.indexOf("export async function createRevolutPreauthResponse"));
  const consume = fn.indexOf("await consumeBookingPaymentQuoteViaRpc");
  const order = fn.indexOf("await postPreauthOrder");
  assert(consume > 0 && order > consume, "single-use quote consume stays before the provider order");
  const eligibility = preauth.indexOf("if (!bookingEligibility.allowed) {");
  const gateway = preauth.indexOf("return gatewayNotConfiguredResponse(customerGatewayCheck, corsHeaders);");
  const currency = preauth.indexOf("? await takeRegionCurrency(regionCurrencyPrefetch)");
  const call = preauth.indexOf("await createRevolutPreauthResponse({");
  assert(eligibility < gateway && gateway < currency && currency < call);
});
