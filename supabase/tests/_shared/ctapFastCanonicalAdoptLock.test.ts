/**
 * MK-260926-007 / MK-009 next phase — CTAP fast canonical adopt (backend).
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
  // Minimal P0 — no driver/fare/route/restore enrichment
  assert(!edge.includes("driver_photo"));
  assert(!edge.includes("restore-active-trip"));
  assert(!edge.includes("waiting_"));
  assert(!edge.includes("route_polyline"));
  assert(!edge.includes("dispatchOffer"));
  assert(!edge.includes("notify"));
});

Deno.test("lookup emits internal timing spans without extra DB queries", async () => {
  const edge = await read("supabase/functions/lookup-booking-canonical-trip/index.ts");
  assert(edge.includes("edge_receive_ms"));
  assert(edge.includes("auth_ms"));
  assert(edge.includes("customer_lookup_ms"));
  assert(edge.includes("trip_cai_lookup_ms"));
  assert(edge.includes("status_validation_ms"));
  assert(edge.includes("response_ready_ms"));
  assert(edge.includes("server_total_ms"));
  // Still only customers + trips selects
  const fromCustomers = (edge.match(/\.from\("customers"\)/g) ?? []).length;
  const fromTrips = (edge.match(/\.from\("trips"\)/g) ?? []).length;
  assertEquals(fromCustomers, 1);
  assertEquals(fromTrips, 1);
});

Deno.test("lookup does not require payment_sessions.trip_id reverse link", async () => {
  const edge = await read("supabase/functions/lookup-booking-canonical-trip/index.ts");
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
  const persistIdx = ctap.indexOf('phase: "response_ready"');
  const returnIdx = ctap.indexOf("ride_id: trip.id", persistIdx);
  assert(persistIdx > 0 && returnIdx > persistIdx);
});

Deno.test("persistOpsLog inspects PostgREST { error } and never throws into booking", async () => {
  const tel = await read("supabase/functions/_shared/bookingWaterfallTelemetry.ts");
  assert(tel.includes("const { error } = await adminClient.from(\"ops_logs\").insert"));
  assert(tel.includes("ops_logs insert error"));
  assert(tel.includes("PostgREST returns { error }"));
  // Must not rethrow
  assert(!/throw error/.test(tel));
  const ops = await read("supabase/functions/_shared/opsLog.ts");
  assert(ops.includes("const { error } = await client.from(\"ops_logs\").insert"));
  assert(ops.includes("[opsLog] insert error:"));
});

Deno.test("ingest-telemetry allowlists CTAP/CAI race residual keys", async () => {
  const ingest = await read("supabase/functions/ingest-telemetry/index.ts");
  assert(ingest.includes('"race_winner_kind"'));
  assert(ingest.includes('"shared_auth_token"'));
  assert(ingest.includes('"stage_lookup_1_fetch_start_ms"'));
  assert(ingest.includes('"edge_lookup_server_total_ms"'));
  assert(ingest.includes('"genuine_cai_misses"'));
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

Deno.test("CTAP financial invariants remain: AUTHORISED before T1, reverse link P2", async () => {
  const ctap = await read("supabase/functions/create-trip-after-payment/index.ts");
  assert(ctap.includes("paymentSessionId"));
  assert(ctap.includes("PAYMENT_SESSION_NOT_AUTHORISED"));
  assert(ctap.includes("PAYMENT_AUTHORISATION_INSUFFICIENT"));
  // Reverse payment_sessions.trip_id must not block ride_id return
  assert(ctap.includes("ride_id: trip.id"));
  assert(ctap.includes("P2 work (payment_session reverse link, dispatch, notifications, fare"));
});
