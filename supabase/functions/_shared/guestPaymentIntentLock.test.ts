/**
 * guestPaymentIntentLock.test.ts
 *
 * Lock tests for the create-guest-payment-intent Edge Function.
 * Guards the critical invariants: no-auth guest path, financial model gating,
 * correct function called by website, checkout_url contract, and SSOT reuse.
 *
 * Run: deno test --allow-read supabase/functions/_shared/guestPaymentIntentLock.test.ts
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as fs from "https://deno.land/std@0.208.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.208.0/path/mod.ts";

const ROOT = path.resolve(path.fromFileUrl(import.meta.url), "../../..");
const GUEST_FN = path.join(ROOT, "functions/create-guest-payment-intent/index.ts");
const LEGACY_FN = path.join(ROOT, "functions/create-payment-intent/index.ts");

function readSrc(filePath: string): string {
  return Deno.readTextFileSync(filePath);
}

// ── 1. Function file exists ───────────────────────────────────────────────────

Deno.test("create-guest-payment-intent: function file exists", () => {
  const exists = fs.existsSync(GUEST_FN);
  assertEquals(exists, true, "create-guest-payment-intent/index.ts must exist");
});

// ── 2. No Supabase auth.getUser on the guest path ─────────────────────────────

Deno.test("create-guest-payment-intent: does not call auth.getUser (no user JWT required)", () => {
  const src = readSrc(GUEST_FN);
  const hasGetUser = src.includes("auth.getUser") || src.includes("getUser(token");
  assertEquals(hasGetUser, false, "Guest function must NOT call auth.getUser — guests have no JWT");
});

// ── 3. Does not require trip_id ───────────────────────────────────────────────

Deno.test("create-guest-payment-intent: does not require trip_id in request body", () => {
  const src = readSrc(GUEST_FN);
  // trip_id would be a required field check like '!trip_id'
  const requiresTripId = /if\s*\(!trip_id\)/.test(src);
  assertEquals(requiresTripId, false, "Guest function must not require trip_id");
});

// ── 4. Uses createRevolutOrder SSOT ──────────────────────────────────────────

Deno.test("create-guest-payment-intent: uses shared createRevolutOrder", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "createRevolutOrder", "Must use shared createRevolutOrder SSOT");
});

// ── 5. Uses getRevolutMerchantConfigFromVault ────────────────────────────────

Deno.test("create-guest-payment-intent: uses getRevolutMerchantConfigFromVault (vault-first)", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "getRevolutMerchantConfigFromVault");
});

// ── 6. Uses upsertPaymentSessionPending SSOT ────────────────────────────────

Deno.test("create-guest-payment-intent: uses upsertPaymentSessionPending SSOT", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "upsertPaymentSessionPending");
});

// ── 7. Financial model gate — DRIVER_COLLECTED fails closed ──────────────────

Deno.test("create-guest-payment-intent: fails closed for DRIVER_COLLECTED", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "DRIVER_COLLECTED");
  assertStringIncludes(src, "skipPreauth", "Must check shouldSkipPlatformPreauthForCommissionWallet");
});

// ── 8. Financial model gate — INVALID fails closed ───────────────────────────

Deno.test("create-guest-payment-intent: fails closed for INVALID_FINANCIAL_CONFIG", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "INVALID_FINANCIAL_CONFIG");
  assertStringIncludes(src, "pairing.ok");
});

// ── 9. Uses classifyServiceAreaFinancialPairing ──────────────────────────────

Deno.test("create-guest-payment-intent: uses classifyServiceAreaFinancialPairing", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "classifyServiceAreaFinancialPairing");
});

// ── 10. Returns checkout_url ─────────────────────────────────────────────────

Deno.test("create-guest-payment-intent: returns checkout_url in response", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "checkout_url: order.checkout_url");
});

// ── 11. Returns checkoutUrl alias (website reads both) ───────────────────────

Deno.test("create-guest-payment-intent: returns checkoutUrl alias (website Vw reads n.checkoutUrl)", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "checkoutUrl: order.checkout_url");
});

// ── 12. Sets booking_source whatsapp_booking in snapshot ────────────────────

Deno.test("create-guest-payment-intent: booking_snapshot.booking_source = 'whatsapp_booking'", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, `booking_source: "whatsapp_booking"`);
});

// ── 13. Creates anonymous auth user for webhook finalize ─────────────────────

Deno.test("create-guest-payment-intent: creates anonymous auth user (user_id for webhook finalize)", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "auth.admin.createUser");
});

// ── 14. Cleans up guest user on Revolut order failure ───────────────────────

Deno.test("create-guest-payment-intent: deletes guest auth user on Revolut order failure", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "auth.admin.deleteUser(guestUserId)");
});

// ── 15. Idempotency — same client_request_id returns existing checkout_url ───

Deno.test("create-guest-payment-intent: idempotency check on client_request_id", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "client_action_id");
  assertStringIncludes(src, "existingSession");
  assertStringIncludes(src, "idempotent");
});

// ── 16. Rate limiting present ────────────────────────────────────────────────

Deno.test("create-guest-payment-intent: rate limiting applied", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "checkRateLimit");
  assertStringIncludes(src, "Too many requests");
});

// ── 17. Legacy create-payment-intent still requires auth (not regressed) ─────

Deno.test("create-payment-intent: still requires auth.getUser (Customer app path unchanged)", () => {
  const src = readSrc(LEGACY_FN);
  const hasGetUser = src.includes("auth.getUser") || src.includes("auth.getUser(token");
  assertEquals(hasGetUser, true, "Legacy create-payment-intent must still require auth — Customer app uses it");
});

// ── 18. Legacy function still requires trip_id ───────────────────────────────

Deno.test("create-payment-intent: still requires trip_id (Customer app path unchanged)", () => {
  const src = readSrc(LEGACY_FN);
  const requiresTripId = src.includes("trip_id") && src.includes("Missing required fields");
  assertEquals(requiresTripId, true, "Legacy create-payment-intent must still enforce trip_id");
});

// ── 19. Guest function does NOT import from Customer-native payment modules ───

Deno.test("create-guest-payment-intent: does not use native Customer app payment paths", () => {
  const src = readSrc(GUEST_FN);
  const forbidden = [
    "PaymentMethodSheet",
    "useBookRide",
    "requestGooglePayPayment",
    "requestApplePayPayment",
    "savedCard",
    "customer-native",
    "onecab-customer-native",
  ];
  for (const token of forbidden) {
    assertEquals(
      src.includes(token),
      false,
      `Guest function must not reference Customer native code: ${token}`,
    );
  }
});

// ── 20. Guest function does not bypass financial model for PLATFORM_COLLECTED ─

Deno.test("create-guest-payment-intent: proceeds for PLATFORM_COLLECTED (does not block)", () => {
  const src = readSrc(GUEST_FN);
  // The function must NOT early-return for PLATFORM_COLLECTED paths —
  // confirmed by the absence of a block on !skipPreauth (only blocks on skipPreauth).
  assertStringIncludes(src, "if (skipPreauth)");
  // And DRIVER_COLLECTED error is returned only when skipPreauth is true
  const driverCollectedBlock = src.indexOf("if (skipPreauth)");
  const platformBlock = src.indexOf("PLATFORM_COLLECTED");
  assertEquals(
    driverCollectedBlock >= 0,
    true,
    "DRIVER_COLLECTED must be rejected via skipPreauth gate",
  );
  // PLATFORM_COLLECTED is not gated — only DRIVER_COLLECTED (skipPreauth) early-returns.
  // Confirm: skipPreauth gate returns DRIVER_COLLECTED error, and src has no separate platform gate.
  assertStringIncludes(src, `if (skipPreauth)`);
  assertStringIncludes(src, `"DRIVER_COLLECTED"`);
  // There must be no `if (!skipPreauth)` early-return that would block PLATFORM_COLLECTED.
  assertEquals(src.includes("if (!skipPreauth)"), false, "Must not gate PLATFORM_COLLECTED with !skipPreauth");
});

// ── 21. return_url flows into booking_snapshot ───────────────────────────────

Deno.test("create-guest-payment-intent: return_url is stored in booking_snapshot", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "return_url,");
});

// ── 22. CORS headers applied ─────────────────────────────────────────────────

Deno.test("create-guest-payment-intent: CORS headers applied (public endpoint)", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "corsHeaders");
});

// ── 23. Public WhatsApp guest contract: no customer email required ────────────

Deno.test("create-guest-payment-intent: does not require customer_email in request", () => {
  const src = readSrc(GUEST_FN);
  assertEquals(src.includes("customer_email"), false, "must not require customer_email");
  assertEquals(src.includes("customer.email"), false, "must not require customer.email");
  assertStringIncludes(src, "customer_name is required");
  assertStringIncludes(src, "customer_phone is required");
});

Deno.test("create-guest-payment-intent: Revolut order is not passed a customer email", () => {
  const src = readSrc(GUEST_FN);
  const createIdx = src.indexOf("createRevolutOrder({");
  assertEquals(createIdx >= 0, true);
  const createBlock = src.slice(createIdx, createIdx + 800);
  assertEquals(
    createBlock.includes("customer:") || createBlock.includes("email:"),
    false,
    "createRevolutOrder call must not include customer/email — Revolut hosted checkout does not need it",
  );
});

Deno.test("create-guest-payment-intent: synthetic guest email is internal auth-only (not Revolut)", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "guest.onecab.internal");
  assertStringIncludes(src, "auth.admin.createUser");
  // Synthetic email must only appear near createUser, not in createRevolutOrder args.
  const revolutBlock = src.slice(src.indexOf("createRevolutOrder({"), src.indexOf("createRevolutOrder({") + 900);
  assertEquals(revolutBlock.includes("guest.onecab.internal"), false);
});

Deno.test("corsHeaders allow x-client-source for onecab.net WhatsApp Pay & Confirm", () => {
  const cors = readSrc(path.join(ROOT, "functions/_shared/corsHeaders.ts"));
  assertStringIncludes(
    cors,
    "x-client-source",
    "Browser Pay & Confirm sends x-client-source — must be in Access-Control-Allow-Headers or CORS preflight fails",
  );
  assertStringIncludes(cors, "Access-Control-Allow-Methods");
});

Deno.test("create-guest-payment-intent: is the guest entry (not Customer JWT create-payment-intent)", () => {
  const src = readSrc(GUEST_FN);
  assertStringIncludes(src, "whatsapp_booking");
  assertStringIncludes(src, "whatsapp-booking");
  assertEquals(src.includes("auth.getUser"), false);
  assertEquals(src.includes('from "../create-payment-intent'), false);
  assertEquals(src.includes("create-payment-intent/index"), false);
});
