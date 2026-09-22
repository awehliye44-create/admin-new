/**
 * Lock: ingest-telemetry allowlists Book→Finding Phase 1 physical cert keys.
 * Run: deno test --allow-read supabase/tests/_shared/bookFindingPhysicalCertIngestLock.test.ts
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ingestPath = new URL(
  "../../functions/ingest-telemetry/index.ts",
  import.meta.url,
);
const ctapPath = new URL(
  "../../functions/create-trip-after-payment/index.ts",
  import.meta.url,
);

Deno.test("ingest-telemetry allowlists Book→Finding physical cert keys", async () => {
  const ingest = await Deno.readTextFile(ingestPath);
  for (const key of [
    "perf_id",
    "client_action_id",
    "payment_method",
    "adopt_required",
    "adopt_result",
    "apple_pay_sheet_visible_semantics",
    "book_to_apple_pay_sheet_visible_ms",
    "authorization_after_sheet_ms",
    "canonical_after_auth_ms",
    "post_canonical_customer_delay_ms",
    "client_state_ms",
    "navigation_dispatch_ms",
    "navigation_mount_ms",
    "finding_readiness_ms",
    "finding_interactive_delta_ms",
    "stage_canonical_trip_created_ms",
    "stage_ctap_response_received_ms",
    "stage_finding_interactive_ms",
    "ram_class",
    "build_type",
    "t3_via",
  ]) {
    assertStringIncludes(ingest, `"${key}"`);
  }
  assertStringIncludes(ingest, "const MAX_METADATA_KEYS = 120");
});

Deno.test("CTAP still authorises before insert; trip_inserted_ms is insert time", async () => {
  const ctap = await Deno.readTextFile(ctapPath);
  const verifyIdx = ctap.indexOf("verifyRevolutHoldForTripCreateFast(supabase");
  const insertCall = ctap.indexOf(".insert(tripData)");
  if (verifyIdx < 0 || insertCall < 0) {
    throw new Error("expected verify + trips.insert");
  }
  if (!(verifyIdx < insertCall)) {
    throw new Error("payment verify must precede trips.insert");
  }
  assertStringIncludes(ctap, "const tripInsertedAt = Date.now()");
  assertStringIncludes(ctap, "trip_inserted_ms: tripInsertedAt");
  assertStringIncludes(ctap, "trip_created_at:");
  if (ctap.includes("trip_inserted_ms: ctapResponseAt")) {
    throw new Error("trip_inserted_ms must not be the HTTP response clock");
  }
});
