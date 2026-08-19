/**
 * WhatsApp external booking — service-area / payment parity lock tests
 *
 * These tests enforce the invariants described in the product specification:
 *
 * 1. resolve-service-area must return financial_model, customer_payment_policy,
 *    and booking_workflow in its response.
 * 2. booking_workflow must be "platform_collected" | "driver_collected" | "unavailable"
 *    and must be derived from classifyServiceAreaFinancialPairing — never hard-coded.
 * 3. whatsapp-booking-fares must proxy to calculate-fare (no parallel pricing engine).
 * 4. For DRIVER_COLLECTED, whatsapp-booking-fares must return no digital payment methods.
 * 5. For INVALID config, whatsapp-booking-fares must return booking_workflow="unavailable"
 *    without calling calculate-fare.
 * 6. create-trip-after-payment must reject payment_intent_id for DRIVER_COLLECTED
 *    (FINANCIAL_MODEL_VIOLATION), and must reject missing payment_intent_id for
 *    PLATFORM_COLLECTED.
 * 7. booking_source for WhatsApp requests is stamped "whatsapp_booking" — not "customer".
 * 8. The { lat, lng } resolver bug is fixed: resolve-service-area reads pickup_lat/pickup_lng.
 *
 * Run: deno test supabase/functions/_shared/whatsappServiceAreaPaymentParityLock.test.ts
 *
 * If any assertion fails, fix the code — never delete or soften the lock.
 */

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS = path.resolve(__dirname, "..");

function readFunction(name: string): string {
  return fs.readFileSync(path.join(FUNCTIONS, name, "index.ts"), "utf8");
}

function readShared(name: string): string {
  return fs.readFileSync(path.join(FUNCTIONS, "_shared", name), "utf8");
}

// ---------------------------------------------------------------------------
// 1. resolve-service-area response contract
// ---------------------------------------------------------------------------

Deno.test("resolve-service-area: reads financial_model, customer_payment_policy, commission_wallet_enabled from SA", () => {
  const src = readFunction("resolve-service-area");
  assert(src.includes("financial_model"), "must select financial_model");
  assert(src.includes("customer_payment_policy"), "must select customer_payment_policy");
  assert(src.includes("commission_wallet_enabled"), "must select commission_wallet_enabled");
});

Deno.test("resolve-service-area: uses classifyServiceAreaFinancialPairing to derive booking_workflow", () => {
  const src = readFunction("resolve-service-area");
  assert(src.includes("classifyServiceAreaFinancialPairing"), "must call classifyServiceAreaFinancialPairing");
  assert(src.includes("booking_workflow"), "must include booking_workflow");
});

Deno.test("resolve-service-area: returns financial_model and customer_payment_policy in settings", () => {
  const src = readFunction("resolve-service-area");
  assert(
    src.includes("financial_model: saPairing.ok ? saPairing.financial_model : null"),
    "settings must include financial_model from saPairing",
  );
  assert(
    src.includes("customer_payment_policy: saPairing.ok ? saPairing.customer_payment_policy : null"),
    "settings must include customer_payment_policy from saPairing",
  );
});

Deno.test("resolve-service-area: marks booking_workflow=unavailable for invalid financial config", () => {
  const src = readFunction("resolve-service-area");
  assert(src.includes("!saPairing.ok"), "must branch on !saPairing.ok");
  assert(src.includes('"unavailable"'), "must emit unavailable workflow");
});

Deno.test("resolve-service-area: reads pickup_lat and pickup_lng from request body (not { lat, lng })", () => {
  const src = readFunction("resolve-service-area");
  assert(src.includes("const { pickup_lat, pickup_lng } = body"), "must destructure pickup_lat/pickup_lng");
});

Deno.test("resolve-service-area: does NOT hardcode a global/default financial model", () => {
  const src = readFunction("resolve-service-area");
  assert(!/\|\|.*PLATFORM_COLLECTED/.test(src), "must not fallback || PLATFORM_COLLECTED");
  assert(!/\?\?.*PLATFORM_COLLECTED/.test(src), "must not fallback ?? PLATFORM_COLLECTED");
});

Deno.test("resolve-service-area: farePricing is marked DEPRECATED in favour of calculate-fare", () => {
  const src = readFunction("resolve-service-area");
  assert(src.includes("DEPRECATED"), "farePricing comment must say DEPRECATED");
  assert(src.includes("calculate-fare"), "deprecation must point to calculate-fare");
});

Deno.test("resolve-service-area: does NOT perform its own fare arithmetic", () => {
  const src = readFunction("resolve-service-area");
  assert(!src.includes("calculateFare("), "must not call calculateFare()");
  assert(!src.includes("pricing-engine"), "must not import pricing-engine");
});

// ---------------------------------------------------------------------------
// 2. whatsapp-booking-fares invariants
// ---------------------------------------------------------------------------

Deno.test("whatsapp-booking-fares: proxies to calculate-fare (no parallel pricing engine)", () => {
  const src = readFunction("whatsapp-booking-fares");
  assert(src.includes("calculate-fare"), "must call the calculate-fare endpoint");
  assert(!src.includes("base_fare"), "must not contain base_fare (parallel pricing)");
  assert(!src.includes("per_km_rate"), "must not contain per_km_rate (parallel pricing)");
  assert(!src.includes("per_min_rate"), "must not contain per_min_rate (parallel pricing)");
  assert(!src.includes("minimumFarePence"), "must not contain minimumFarePence (parallel pricing)");
});

Deno.test("whatsapp-booking-fares: uses classifyServiceAreaFinancialPairing and shouldSkipPlatformPreauthForCommissionWallet", () => {
  const src = readFunction("whatsapp-booking-fares");
  assert(src.includes("classifyServiceAreaFinancialPairing"), "must classify financial pairing");
  assert(src.includes("shouldSkipPlatformPreauthForCommissionWallet"), "must check skip preauth");
});

Deno.test("whatsapp-booking-fares: returns all three booking_workflow values", () => {
  const src = readFunction("whatsapp-booking-fares");
  assert(src.includes('"platform_collected"'), "must handle platform_collected");
  assert(src.includes('"driver_collected"'), "must handle driver_collected");
  assert(src.includes('"unavailable"'), "must handle unavailable");
});

Deno.test("whatsapp-booking-fares: returns no digital payment methods for DRIVER_COLLECTED", () => {
  const src = readFunction("whatsapp-booking-fares");
  assert(src.includes("card: false"), "must return card:false for driver_collected");
  assert(src.includes("wallet: false"), "must return wallet:false for driver_collected");
  assert(src.includes("applePay: false"), "must return applePay:false for driver_collected");
  assert(src.includes("googlePay: false"), "must return googlePay:false for driver_collected");
  assert(src.includes("skip_platform_preauth"), "must gate on skip_platform_preauth");
});

Deno.test("whatsapp-booking-fares: fails closed on INVALID config (INVALID_FINANCIAL_CONFIG, booking_workflow=unavailable)", () => {
  const src = readFunction("whatsapp-booking-fares");
  assert(src.includes("!saPairing.ok"), "must check !saPairing.ok");
  assert(src.includes("INVALID_FINANCIAL_CONFIG"), "must return INVALID_FINANCIAL_CONFIG error code");
  assert(src.includes('"unavailable"'), "must return unavailable workflow");
});

Deno.test("whatsapp-booking-fares: fails closed on missing service area", () => {
  const src = readFunction("whatsapp-booking-fares");
  assert(src.includes('"Service area not found or inactive"'), "must reject missing SA");
});

Deno.test("whatsapp-booking-fares: passes pickup and dropoff coordinates to calculate-fare", () => {
  const src = readFunction("whatsapp-booking-fares");
  assert(src.includes("fareReqBody.pickup = pickup"), "must forward pickup coords");
  assert(src.includes("fareReqBody.dropoff = dropoff"), "must forward dropoff coords");
});

// ---------------------------------------------------------------------------
// 3. create-trip-after-payment financial model gates
// ---------------------------------------------------------------------------

Deno.test("create-trip-after-payment: rejects payment_intent_id for DRIVER_COLLECTED (FINANCIAL_MODEL_VIOLATION)", () => {
  const src = readFunction("create-trip-after-payment");
  assert(src.includes("FINANCIAL_MODEL_VIOLATION"), "must use FINANCIAL_MODEL_VIOLATION");
  assert(src.includes("skipPlatformPreauth && body.payment_intent_id"), "must gate on preauth+pi_id");
});

Deno.test("create-trip-after-payment: rejects missing payment_intent_id for PLATFORM_COLLECTED", () => {
  const src = readFunction("create-trip-after-payment");
  assert(src.includes("!skipPlatformPreauth && !body.payment_intent_id"), "must require pi_id for platform");
});

Deno.test("create-trip-after-payment: fails closed on INVALID_CONFIGURATION", () => {
  const src = readFunction("create-trip-after-payment");
  assert(src.includes("INVALID_CONFIGURATION"), "must use INVALID_CONFIGURATION");
  assert(src.includes("!saPairing.ok"), "must branch on !saPairing.ok");
});

Deno.test("create-trip-after-payment: stamps payment_provider=driver_collected for driver-collected trips", () => {
  const src = readFunction("create-trip-after-payment");
  assert(src.includes('"driver_collected"'), "must stamp driver_collected provider");
});

// ---------------------------------------------------------------------------
// 4. booking_source — WhatsApp trips are not silently stamped "customer"
// ---------------------------------------------------------------------------

Deno.test("bookingSSOT: passes requestReferer to resolvePersistedTripBookingSource", () => {
  const src = readShared("bookingSSOT.ts");
  assert(src.includes("resolvePersistedTripBookingSource"), "must call resolvePersistedTripBookingSource");
  assert(src.includes("requestReferer"), "must pass requestReferer");
});

Deno.test("presetNegotiationEligibility: WHATSAPP_BOOKING_SOURCE is canonical constant", () => {
  const src = readShared("presetNegotiationEligibility.ts");
  assert(src.includes('WHATSAPP_BOOKING_SOURCE = "whatsapp_booking"'), "must define canonical constant");
});

Deno.test("create-trip-after-payment: forwards the referer header for booking_source stamping", () => {
  const src = readFunction("create-trip-after-payment");
  assert(src.includes('req.headers.get("referer")'), "must forward referer header");
});
