/**
 * P0 — CTAP ↔ webhook scheduled create parity lock (MK-261112-006).
 * Isolated code-level verification only — no deploy / no device QA.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildMinimalTripInsertRow } from "./bookingSSOT.ts";
import { resolveScheduledDispatchConfig } from "./scheduledDispatchConfig.ts";
import {
  evaluateCaptureDeadlineCoverage,
  mergeCaptureDeadlinePersistence,
} from "./scheduledCaptureCoverageSSOT.ts";
const root = new URL("../../../", import.meta.url);

Deno.test("CTAP create stamps canonical scheduled held invariants", () => {
  const row = buildMinimalTripInsertRow({
    body: {
      client_action_id: "parity-1",
      pickup: { address: "A", lat: 52.04, lng: -0.76 },
      dropoff: { address: "B", lat: 52.05, lng: -0.75 },
      when: "SCHEDULED",
      scheduled_at: "2026-11-20T14:00:00.000Z",
      estimated_fare: 8,
      estimated_duration: 25,
      payment_method: "APPLE_PAY",
      booking_source: "choose_ride",
    },
    customerId: "cust-1",
    preauthAmountPence: 800,
    paymentSessionId: "ps-1",
    paymentProvider: "revolut",
    paymentRefId: "ord-1",
    regionId: "r1",
    regionCurrencyCode: "GBP",
    regionDistanceUnit: "mi",
    serviceAreaId: "sa-1",
    serviceAreaCode: "MK",
    nowMs: Date.parse("2026-11-12T12:00:00.000Z"),
    scheduledDispatchConfig: resolveScheduledDispatchConfig({
      urgent_dispatch_trigger_minutes_before_pickup: 9,
      scheduled_response_window_minutes: 4,
    }),
  });
  assertEquals(row.scheduled_status, "admin_held");
  assertEquals(row.scheduled_broadcast_at, null);
  assertEquals(row.scheduled_hold_reason, "publication_pending");
  assertEquals(row.status, "scheduled");
  assertEquals(row.dispatch_mode, "scheduled");
  assert(row.scheduled_convert_at != null);
});

Deno.test("finalize migration enforces held + capture deadline before insert", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "supabase/migrations/20270218130200_finalize_scheduled_create_parity.sql",
      root,
    ),
  );
  assertStringIncludes(sql, "publication_pending");
  assertStringIncludes(sql, "admin_held");
  assertStringIncludes(sql, "scheduled_broadcast_at");
  assertStringIncludes(sql, "CAPTURE_DEADLINE_MISSING");
  assertStringIncludes(sql, "CAPTURE_DEADLINE_INSUFFICIENT");
  assertStringIncludes(sql, "required_capture_coverage_until");
  assertStringIncludes(sql, "compute_scheduled_dispatch_anchors");
  assertStringIncludes(sql, "scheduled_capture_coverage_verified");
});

Deno.test("lifecycle migration blocks ideal future broadcast at create", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "supabase/migrations/20270218130000_scheduled_auto_publish_webhook_create_fix.sql",
      root,
    ),
  );
  assertStringIncludes(sql, "publication_pending");
  assertStringIncludes(sql, "NEW.scheduled_broadcast_at := NULL");
  assertStringIncludes(sql, "TG_OP = 'INSERT'");
});

Deno.test("webhook persists capture deadline, gates coverage, auto-publishes", async () => {
  const src = await Deno.readTextFile(
    new URL("supabase/functions/revolut-webhook/index.ts", root),
  );
  assertStringIncludes(src, "persistCaptureDeadlineFromOrder");
  assertStringIncludes(src, "ensureScheduledCaptureCoverage");
  assertStringIncludes(src, "attemptScheduledMarketplaceAutoPublish");
  assertStringIncludes(src, "coverageBlocksFinalize");
  assertStringIncludes(src, "finalize_paid_booking_session");
  assert(!src.includes("Make Available in Scheduled Jobs"));
});

Deno.test("CTAP post-commit still auto-publishes scheduled marketplace", async () => {
  const src = await Deno.readTextFile(
    new URL("supabase/functions/_shared/bookingPostCommit.ts", root),
  );
  assertStringIncludes(src, "attemptScheduledMarketplaceAutoPublish");
  assertStringIncludes(src, "post_commit_auto_publish");
  // No duplicate imports after cleanup.
  const matches = src.match(/from "\.\/scheduledMarketplaceAutoPublishSSOT\.ts"/g) ?? [];
  assertEquals(matches.length, 1);
});

Deno.test("capture deadline merge never overwrites valid with null", () => {
  const merged = mergeCaptureDeadlinePersistence({
    existingDeadlineIso: "2026-11-19T12:00:00.000Z",
    existingObservedAtIso: "2026-11-12T10:00:00.000Z",
    providerDeadlineRaw: null,
    providerObservedAtIso: "2026-11-12T11:00:00.000Z",
    source: "provider_webhook",
  });
  assertEquals(merged.captureDeadlineIso, "2026-11-19T12:00:00.000Z");
});

Deno.test("missing capture deadline is not covered", () => {
  const evaluation = evaluateCaptureDeadlineCoverage({
    scheduledAtIso: "2026-11-12T17:30:00.000Z",
    estimatedDurationMinutes: 20,
    captureDeadlineIso: null,
    session: {
      provider_state: "AUTHORISED",
      status: "authorised",
    },
  });
  assertEquals(evaluation.covered, false);
  assert(evaluation.code.includes("MISSING") || evaluation.code.includes("DEADLINE"));
});

Deno.test("Admin presentation SSOT requires due broadcast_at for Requested", async () => {
  const src = await Deno.readTextFile(
    new URL("src/lib/adminScheduledRidePresentation.ts", root),
  );
  assertStringIncludes(src, "marketplaceOpen");
  assertStringIncludes(src, "broadcastMs <= Date.now()");
  assertStringIncludes(src, "Awaiting automatic publication");
  assertStringIncludes(src, "Requested — available in Scheduled Jobs");
});

Deno.test("manual controls retired in Admin UI + Edge + RPC migration", async () => {
  const ui = await Deno.readTextFile(new URL("src/pages/ScheduledRides.tsx", root));
  assert(!ui.includes("Make Available in Scheduled Jobs"));
  assert(!ui.includes("handleHoldExceptional"));
  assertStringIncludes(ui, "Assign Driver");
  assertStringIncludes(ui, "Cancel Ride");

  const edge = await Deno.readTextFile(
    new URL("supabase/functions/admin-scheduled-ride-action/index.ts", root),
  );
  assertStringIncludes(edge, "RETIRED_MANUAL_SCHEDULED_CONTROL");

  const rpc = await Deno.readTextFile(
    new URL(
      "supabase/migrations/20270218130100_retire_manual_scheduled_dispatch_controls.sql",
      root,
    ),
  );
  assertStringIncludes(rpc, "RETIRED_MANUAL_SCHEDULED_CONTROL");
});

Deno.test("Phase 5 flags are not enabled by P0 parity migrations", async () => {
  for (
    const rel of [
      "supabase/migrations/20270218130000_scheduled_auto_publish_webhook_create_fix.sql",
      "supabase/migrations/20270218130100_retire_manual_scheduled_dispatch_controls.sql",
      "supabase/migrations/20270218130200_finalize_scheduled_create_parity.sql",
    ]
  ) {
    const sql = await Deno.readTextFile(new URL(rel, root));
    assert(!/jit_auto_activate_enabled\s*=\s*true/i.test(sql));
    assert(!/scheduled_departure_ack_enabled\s*=\s*true/i.test(sql));
  }
});

Deno.test("CTAP persists capture deadline via merge SSOT before coverage gate", async () => {
  const src = await Deno.readTextFile(
    new URL("supabase/functions/create-trip-after-payment/index.ts", root),
  );
  assertStringIncludes(src, "persistCaptureDeadlineFromOrder");
  assertStringIncludes(src, "ensureScheduledCaptureCoverage");
  assertStringIncludes(src, "capture_deadline_coverage");
});

Deno.test("confirm-revolut-payment extracts + persists capture deadline", async () => {
  const src = await Deno.readTextFile(
    new URL("supabase/functions/confirm-revolut-payment/index.ts", root),
  );
  assertStringIncludes(src, "extractCaptureDeadlineFromRevolutOrder");
  assertStringIncludes(src, "persistCaptureDeadlineFromOrder");
});

Deno.test("finalize adopts existing trip (CTAP-wins / duplicate webhook)", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "supabase/migrations/20270218130200_finalize_scheduled_create_parity.sql",
      root,
    ),
  );
  assertStringIncludes(sql, "WHERE payment_session_id = v_ps.id");
  assertStringIncludes(sql, "client_action_id = v_ps.client_action_id");
  assertStringIncludes(sql, "RETURN v_existing_trip");
  assertStringIncludes(sql, "RETURN v_same_trip");
  assertStringIncludes(sql, "unique_violation");
});
