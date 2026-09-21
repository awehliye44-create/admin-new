/**
 * Lock: Accept-offer Phase 2 — lean eligibility + sub-stage marks + ingest keys.
 *
 * Run: deno test --allow-read supabase/tests/_shared/acceptOfferPhase2PerfLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveAcceptOfferEdgeDurations } from "../../functions/_shared/acceptOfferPerf.ts";

const acceptOfferPath = new URL(
  "../../functions/accept-offer/index.ts",
  import.meta.url,
);
const eligibilityPath = new URL(
  "../../functions/_shared/driverEligibility.ts",
  import.meta.url,
);
const ingestPath = new URL(
  "../../functions/ingest-telemetry/index.ts",
  import.meta.url,
);

Deno.test("Phase 2 lean eligibility skips Auth Admin + TS document walk", async () => {
  const eligibility = await Deno.readTextFile(eligibilityPath);
  assertStringIncludes(eligibility, "assertCanAcceptOfferByDriverIdFast");
  assertStringIncludes(eligibility, "check_driver_documents_approved");
  // Fast path must not call Auth Admin or evaluateDriverDocumentState.
  const fastIdx = eligibility.indexOf("assertCanAcceptOfferByDriverIdFast");
  const fastBody = eligibility.slice(fastIdx, fastIdx + 4500);
  assertEquals(fastBody.includes("getUserById"), false);
  assertEquals(fastBody.includes("evaluateDriverDocumentState"), false);
  assertEquals(fastBody.includes("evaluateDriverOnboardingLogin"), false);
});

Deno.test("accept-offer uses Fast eligibility with auth-row reuse + sub-stage marks", async () => {
  const src = await Deno.readTextFile(acceptOfferPath);
  assertStringIncludes(src, "assertCanAcceptOfferByDriverIdFast");
  assertStringIncludes(src, "driverRow: authDriver");
  assertStringIncludes(src, 'perf.mark("eligibility_validation_start")');
  assertStringIncludes(src, "mark: (stage) => perf.mark(stage)");
  // Full slow path must not remain on Accept critical path.
  assertEquals(src.includes("assertCanAcceptOfferByDriverId(supabase"), false);
});

Deno.test("deriveAcceptOfferEdgeDurations exposes eligibility sub-stages", () => {
  const d = deriveAcceptOfferEdgeDurations({
    eligibility_validation_start: 100,
    eligibility_driver_load_start: 100,
    eligibility_driver_load_end: 105,
    eligibility_docs_rpc_start: 110,
    eligibility_docs_rpc_end: 280,
    eligibility_local_checks_end: 285,
    eligibility_validation_end: 290,
    edge_response: 500,
  });
  assertEquals(d.edge_validation_ms, 190);
  assertEquals(d.eligibility_driver_load_ms, 5);
  assertEquals(d.eligibility_docs_rpc_ms, 170);
  assertEquals(d.eligibility_local_checks_ms, 5);
});

Deno.test("P2 remains off-path after CANONICAL_ASSIGNMENT_CONFIRMED", async () => {
  const src = await Deno.readTextFile(acceptOfferPath);
  const afterCanonical = src.slice(
    src.indexOf('perf.mark("CANONICAL_ASSIGNMENT_CONFIRMED")'),
  );
  assertStringIncludes(afterCanonical, "scheduleAcceptOfferBackground");
  assertStringIncludes(afterCanonical, "notifyCustomerAssignedWithRetry");
  assertStringIncludes(afterCanonical, "sendRideStopPush");
  assertStringIncludes(afterCanonical, "record_booking_delivery");
});

Deno.test("ingest allowlist persists lifecycle + Complete + Rating→Home keys", async () => {
  const src = await Deno.readTextFile(ingestPath);
  for (const key of [
    "edge_rtt_ms",
    "edge_server_ms",
    "pre_edge_ms",
    "tap_to_gate_ms",
    "gps_gate_ms",
    "response_to_state_ms",
    "state_to_interactive_ms",
    "tap_to_interactive_ms",
    "unaccounted_ms",
    "complete_gate_ms",
    "waiting_finalize_ms",
    "fare_ms",
    "completion_writes_ms",
    "payment_capture_ms",
    "state_to_rating_nav_ms",
    "rating_nav_to_mount_ms",
    "rating_mount_to_interactive_ms",
    "complete_tap_to_rating_ms",
    "rating_tap_to_home_interactive_ms",
    "app_version",
    "driver_id",
    "trip_id",
    "cold_start_hint",
    "eligibility_docs_rpc_ms",
  ]) {
    assertStringIncludes(src, `"${key}"`);
  }
});
