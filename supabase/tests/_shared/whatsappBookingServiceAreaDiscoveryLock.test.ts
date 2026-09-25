/**
 * WhatsApp booking — service-area discovery + out-of-area handling lock.
 *
 * Enforces:
 * 1. list-customer-service-areas is a thin READ over service_areas (is_active + active region)
 * 2. Public projection exposes only customer-safe identity fields
 * 3. resolve-service-area emits code=OUTSIDE_AREA for positive outside coverage
 * 4. Technical failures stay HTTP 500 / non-OUTSIDE_AREA
 * 5. Out-of-area WhatsApp notice uses verified book continuation token + dedupe
 * 6. Welcome menu constants are untouched by the notify function
 *
 * Run: deno test --allow-read supabase/tests/_shared/whatsappBookingServiceAreaDiscoveryLock.test.ts
 *
 * If any assertion fails, fix the code — never delete or soften the lock.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OUT_OF_AREA_NOTICE_DEDUPE_MS,
  OUT_OF_AREA_NOTICE_META_KEY,
  shouldSendOutOfAreaNotice,
  WHATSAPP_OUT_OF_AREA_NOTICE_TEXT,
  withOutOfAreaNoticeSent,
} from "../../functions/_shared/whatsappOutOfAreaNotice.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const FUNCTIONS = path.join(ROOT, "functions");

function readFunction(name: string): string {
  return fs.readFileSync(path.join(FUNCTIONS, name, "index.ts"), "utf8");
}

function readShared(name: string): string {
  return fs.readFileSync(path.join(FUNCTIONS, "_shared", name), "utf8");
}

function readConfig(): string {
  return fs.readFileSync(path.join(ROOT, "config.toml"), "utf8");
}

// ---------------------------------------------------------------------------
// list-customer-service-areas
// ---------------------------------------------------------------------------

Deno.test("list-customer-service-areas: reads service_areas SSOT with is_active + active region", () => {
  const src = readFunction("list-customer-service-areas");
  assert(src.includes('.from("service_areas")'));
  assert(src.includes('.eq("is_active", true)'));
  const viaJoin = src.includes('regions!inner(status)') && src.includes('.eq("regions.status", "active")');
  const viaIds = src.includes('.from("regions")') && src.includes('.eq("status", "active")') &&
    src.includes('.in("region_id", regionIds)');
  assert(viaJoin || viaIds, "must filter active regions via join or region id list");
});

Deno.test("list-customer-service-areas: exposes only customer-safe fields", () => {
  const src = readFunction("list-customer-service-areas");
  assert(src.includes("id: String(row.id)"));
  assert(src.includes("name: String(row.name)"));
  assert(!src.includes("geo_boundary"));
  assert(!src.includes("financial_model"));
  assert(!src.includes("payment_provider"));
  assert(!src.includes("commission_wallet"));
  assert(!src.includes("customer_payment_policy"));
  assert(!/Milton Keynes/.test(src));
});

Deno.test("list-customer-service-areas: does not invent a parallel coverage table", () => {
  const src = readFunction("list-customer-service-areas");
  assert(!src.includes("whatsapp_service_areas"));
  assert(!src.includes("create table"));
});

Deno.test("config.toml: list-customer-service-areas is public (verify_jwt=false)", () => {
  const cfg = readConfig();
  assert(cfg.includes("[functions.list-customer-service-areas]"));
  const idx = cfg.indexOf("[functions.list-customer-service-areas]");
  const slice = cfg.slice(idx, idx + 120);
  assert(slice.includes("verify_jwt = false"));
});

// ---------------------------------------------------------------------------
// resolve-service-area OUTSIDE_AREA
// ---------------------------------------------------------------------------

Deno.test("resolve-service-area: positive outside coverage returns code OUTSIDE_AREA", () => {
  const src = readFunction("resolve-service-area");
  assertEquals((src.match(/code: 'OUTSIDE_AREA'/g) ?? []).length, 2);
  assert(src.includes("outside service coverage area"));
  assert(src.includes("not inside any active service area"));
});

Deno.test("resolve-service-area: technical catch path does NOT claim OUTSIDE_AREA", () => {
  const src = readFunction("resolve-service-area");
  const catchIdx = src.indexOf("} catch (error)");
  assert(catchIdx > 0);
  const catchBlock = src.slice(catchIdx);
  assert(!catchBlock.includes("OUTSIDE_AREA"));
  assert(catchBlock.includes("status: 500"));
});

// ---------------------------------------------------------------------------
// out-of-area WhatsApp notice
// ---------------------------------------------------------------------------

Deno.test("whatsappOutOfAreaNotice: professional message body matches product copy", () => {
  assert(WHATSAPP_OUT_OF_AREA_NOTICE_TEXT.startsWith("*ONECAB*"));
  assert(WHATSAPP_OUT_OF_AREA_NOTICE_TEXT.includes(
    "Sorry, ONECAB is not currently available in your pickup area.",
  ));
  assert(WHATSAPP_OUT_OF_AREA_NOTICE_TEXT.includes(
    "We’re expanding to more locations, and we hope to serve your area soon.",
  ));
  assert(WHATSAPP_OUT_OF_AREA_NOTICE_TEXT.includes(
    "You can choose a different pickup location to continue.",
  ));
});

Deno.test("whatsappOutOfAreaNotice: dedupe skips recent sends and allows after window", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");
  assertEquals(shouldSendOutOfAreaNotice({}, now), true);
  assertEquals(
    shouldSendOutOfAreaNotice(
      { [OUT_OF_AREA_NOTICE_META_KEY]: new Date(now - 60_000).toISOString() },
      now,
    ),
    false,
  );
  assertEquals(
    shouldSendOutOfAreaNotice(
      {
        [OUT_OF_AREA_NOTICE_META_KEY]: new Date(now - OUT_OF_AREA_NOTICE_DEDUPE_MS - 1)
          .toISOString(),
      },
      now,
    ),
    true,
  );
});

Deno.test("whatsappOutOfAreaNotice: withOutOfAreaNoticeSent preserves other metadata", () => {
  const next = withOutOfAreaNoticeSent({ foo: 1 }, "2026-09-25T12:00:00.000Z");
  assertEquals(next.foo, 1);
  assertEquals(next[OUT_OF_AREA_NOTICE_META_KEY], "2026-09-25T12:00:00.000Z");
});

Deno.test("whatsapp-booking-out-of-area-notify: requires OUTSIDE_AREA + book continuation token", () => {
  const src = readFunction("whatsapp-booking-out-of-area-notify");
  assert(src.includes('body.code !== "OUTSIDE_AREA"'));
  assert(src.includes("verifyWhatsAppContinuationToken"));
  assert(src.includes('claims.purpose !== "book"'));
  assert(src.includes("WHATSAPP_OUT_OF_AREA_NOTICE_TEXT"));
  assert(src.includes("shouldSendOutOfAreaNotice"));
  assert(src.includes("sendWhatsAppTextMessage"));
});

Deno.test("whatsapp-booking-out-of-area-notify: stamps dedupe only after successful send", () => {
  const src = readFunction("whatsapp-booking-out-of-area-notify");
  const sendIdx = src.indexOf("sendWhatsAppTextMessage");
  const stampIdx = src.indexOf("withOutOfAreaNoticeSent");
  assert(sendIdx > 0 && stampIdx > sendIdx, "dedupe stamp must follow Graph send");
  assert(src.includes('delivery: "failed"'));
  // Failed delivery must not stamp the notice key before returning.
  const failBlock = src.slice(src.indexOf("if (!result.ok)"), src.indexOf("const sentAtIso"));
  assert(!failBlock.includes("withOutOfAreaNoticeSent"));
});

Deno.test("whatsapp-booking-out-of-area-notify: does not touch welcome menu", () => {
  const src = readFunction("whatsapp-booking-out-of-area-notify");
  assert(!src.includes("sendWhatsAppWelcomeMenu"));
  assert(!src.includes("WHATSAPP_WELCOME"));
  const outbound = readShared("whatsappOutbound.ts");
  assert(outbound.includes("WHATSAPP_WELCOME_BUTTONS"));
  assert(outbound.includes("Book a ride"));
  assert(outbound.includes("Track my booking"));
  assert(outbound.includes("Customer support"));
});

Deno.test("config.toml: whatsapp-booking-out-of-area-notify is public (verify_jwt=false)", () => {
  const cfg = readConfig();
  assert(cfg.includes("[functions.whatsapp-booking-out-of-area-notify]"));
  const idx = cfg.indexOf("[functions.whatsapp-booking-out-of-area-notify]");
  const slice = cfg.slice(idx, idx + 140);
  assert(slice.includes("verify_jwt = false"));
});

// ---------------------------------------------------------------------------
// create-guest-payment-intent — server-side coverage authority
// ---------------------------------------------------------------------------

Deno.test("create-guest-payment-intent: refuses OUTSIDE_AREA before Revolut / session", () => {
  const src = readFunction("create-guest-payment-intent");
  const shared = readShared("whatsappPickupCoverageSSOT.ts");
  assert(src.includes("assertPickupCoveredByResolveServiceArea"));
  assert(src.includes("whatsappPickupCoverageSSOT"));
  assert(shared.includes('code: "OUTSIDE_AREA"'));
  assert(src.includes("GUEST_PICKUP_COVERAGE_REJECTED"));
  const coverageIdx = src.indexOf("await assertPickupCoveredByResolveServiceArea");
  const idempotentIdx = src.indexOf("idempotent return");
  const revolutIdx = src.indexOf("await createRevolutOrder");
  const sessionIdx = src.indexOf("await upsertPaymentSessionPending");
  assert(
    coverageIdx > 0 &&
      idempotentIdx > coverageIdx &&
      revolutIdx > coverageIdx &&
      sessionIdx > coverageIdx,
    "pickup coverage must run before idempotent checkout, Revolut, and payment session",
  );
});

Deno.test("create-guest-payment-intent: rejects forged service_area_id vs pickup resolve", () => {
  const src = readFunction("create-guest-payment-intent");
  assert(src.includes("assertPickupCoveredByResolveServiceArea"));
  const shared = readShared("whatsappPickupCoverageSSOT.ts");
  assert(shared.includes('code: "SERVICE_AREA_MISMATCH"'));
  assert(shared.includes("body.settings.service_area_id !== input.serviceAreaId"));
});

Deno.test("config.toml: create-guest-payment-intent is public (verify_jwt=false)", () => {
  const cfg = readConfig();
  assert(cfg.includes("[functions.create-guest-payment-intent]"));
  const idx = cfg.indexOf("[functions.create-guest-payment-intent]");
  const slice = cfg.slice(idx, idx + 140);
  assert(slice.includes("verify_jwt = false"));
});

Deno.test("whatsapp-booking-fares: gates pickup via resolve-service-area before calculate-fare", () => {
  const src = readFunction("whatsapp-booking-fares");
  assert(src.includes("assertPickupCoveredByResolveServiceArea"));
  assert(src.includes("pickup coordinates are required"));
  const coverageIdx = src.indexOf("await assertPickupCoveredByResolveServiceArea");
  const fareIdx = src.indexOf("/functions/v1/calculate-fare");
  assert(coverageIdx > 0 && fareIdx > coverageIdx, "coverage must run before calculate-fare proxy");
});
