/**
 * MK-260926-007 — CTAP fast canonical adopt.
 *
 * While create-trip-after-payment is in flight, Customer discovers whether
 * THIS client_action_id already produced a canonical trip via a cheap
 * authenticated CAI lookup — not restore-active-trip hydration first.
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

Deno.test("lookup Edge is read-only discovery by client_action_id", async () => {
  const edge = await read("supabase/functions/lookup-booking-canonical-trip/index.ts");
  assert(edge.includes('eq("client_action_id", clientActionId)'));
  assert(edge.includes("evaluateBookingCanonicalTripLookup"));
  assert(edge.includes("getClaims"));
  assert(edge.includes('eq("user_id", userId)'));
  // Zero mutations
  assert(!/\.insert\(/.test(edge));
  assert(!/\.update\(/.test(edge));
  assert(!/\.upsert\(/.test(edge));
  assert(!/\.delete\(/.test(edge));
  assert(!/rpc\(/.test(edge));
});

Deno.test("lookup does not require payment_sessions.trip_id reverse link", async () => {
  const edge = await read("supabase/functions/lookup-booking-canonical-trip/index.ts");
  // Must not join/query payment_sessions for identity — trips.CAI is enough.
  assert(!edge.includes('.from("payment_sessions")'));
  assert(!edge.includes("payment_sessions.trip_id"));
  const ssot = await read("supabase/functions/_shared/bookingCanonicalTripLookupSSOT.ts");
  assert(ssot.includes("payment_session_id"));
  assert(ssot.includes("Does not require payment_sessions.trip_id"));
});

Deno.test("config.toml registers lookup with verify_jwt false (auth in-handler)", async () => {
  const cfg = await read("supabase/config.toml");
  assert(cfg.includes("[functions.lookup-booking-canonical-trip]"));
  const idx = cfg.indexOf("[functions.lookup-booking-canonical-trip]");
  const slice = cfg.slice(idx, idx + 120);
  assert(slice.includes("verify_jwt = false"));
});

Deno.test("CTAP persists response_ready off critical path via waitUntil", async () => {
  const ctap = await read("supabase/functions/create-trip-after-payment/index.ts");
  assert(ctap.includes('phase: "response_ready"'));
  assert(ctap.includes("canonical_t1_ms"));
  assert(ctap.includes("response_ready_ms"));
  assert(ctap.includes("post_t1_required_ms"));
  assert(ctap.includes("EdgeRuntime.waitUntil("));
  assert(ctap.includes("persistOpsLog(supabase"));
  // Persist must not block the HTTP return of ride_id
  const persistIdx = ctap.indexOf('phase: "response_ready"');
  const returnIdx = ctap.indexOf("ride_id: trip.id", persistIdx);
  assert(persistIdx > 0 && returnIdx > persistIdx);
});

Deno.test("SSOT select stays minimal Finding seed", async () => {
  const ssot = await read("supabase/functions/_shared/bookingCanonicalTripLookupSSOT.ts");
  assert(ssot.includes("BOOKING_CANONICAL_TRIP_LOOKUP_SELECT"));
  assert(!ssot.includes("driver_photo"));
  assert(!ssot.includes("vehicle_make"));
  assert(!ssot.includes("route_polyline"));
  assert(!ssot.includes("waiting_"));
  assertEquals(ssot.includes("fare_"), false);
});
