/**
 * Phase 3 — automatic marketplace publication lock tests.
 * Run: deno test --allow-read supabase/functions/_shared/scheduledMarketplaceAutoPublishSSOT.test.ts
 */
import {
  assertEquals,
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildScheduledMarketplaceAutoPublishPatch,
  buildScheduledMarketplaceAutoPublishRetryPatch,
  classifyScheduledMarketplaceHold,
  evaluateScheduledMarketplaceAutoPublishEligibility,
  isExceptionalManualBookingSource,
  isRoutineAutoPublishBookingSource,
  SCHEDULED_MARKETPLACE_AUTO_PUBLISH_VIA,
} from "./scheduledMarketplaceAutoPublishSSOT.ts";
import { buildMinimalTripInsertRow } from "./bookingSSOT.ts";
import { resolveScheduledDispatchConfig } from "./scheduledDispatchConfig.ts";

const BASE = {
  id: "trip-1",
  dispatch_mode: "scheduled",
  status: "scheduled",
  scheduled_status: "admin_held",
  scheduled_at: "2026-11-20T14:00:00.000Z",
  scheduled_broadcast_at: null,
  driver_id: null,
  confirmed_driver_id: null,
  broadcast_enabled: true,
  airport_charge_pence: 0,
  pending_release_kind: null,
  pending_release_at: null,
  booking_source: "choose_ride",
  service_area_id: "sa-1",
  vehicle_type_id: "vt-1",
  completed_at: null,
  cancelled_at: null,
};

Deno.test("create still stamps admin_held (Hard Rule #1 create preserved)", () => {
  const row = buildMinimalTripInsertRow({
    body: {
      client_action_id: "p3-1",
      pickup: { address: "A", lat: 52.04, lng: -0.76 },
      dropoff: { address: "B", lat: 52.05, lng: -0.75 },
      when: "SCHEDULED",
      scheduled_at: "2026-11-20T14:00:00.000Z",
      estimated_fare: 12.5,
      payment_method: "card",
      booking_source: "choose_ride",
    },
    customerId: "c1",
    preauthAmountPence: 1500,
    paymentRefId: "ord",
    paymentProvider: "revolut",
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
});

Deno.test("eligible routine held booking may auto-publish", () => {
  const r = evaluateScheduledMarketplaceAutoPublishEligibility(BASE);
  assertEquals(r.ok, true);
  assertEquals(r.reason, "ok");
});

Deno.test("airport pricing hold blocks publication", () => {
  const r = evaluateScheduledMarketplaceAutoPublishEligibility({
    ...BASE,
    broadcast_enabled: false,
    airport_charge_pence: 700,
  });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "airport_pricing_hold");
});

Deno.test("payment_gate_blocked status blocks publication", () => {
  const r = evaluateScheduledMarketplaceAutoPublishEligibility({
    ...BASE,
    scheduled_status: "payment_gate_blocked",
  });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "payment_gate_blocked_status");
});

Deno.test("Assign At / Broadcast At pending blocks auto-publish override", () => {
  const assign = evaluateScheduledMarketplaceAutoPublishEligibility({
    ...BASE,
    pending_release_kind: "assign",
    pending_release_at: "2026-11-20T10:00:00.000Z",
  });
  assertEquals(assign.ok, false);
  assertEquals(assign.reason, "exceptional_pending_release");
  const broadcast = evaluateScheduledMarketplaceAutoPublishEligibility({
    ...BASE,
    pending_release_kind: "broadcast",
    pending_release_at: "2026-11-20T10:00:00.000Z",
  });
  assertEquals(broadcast.ok, false);
});

Deno.test("already assigned / published are idempotent no-ops", () => {
  assertEquals(
    evaluateScheduledMarketplaceAutoPublishEligibility({
      ...BASE,
      confirmed_driver_id: "d1",
    }).reason,
    "already_assigned",
  );
  assertEquals(
    evaluateScheduledMarketplaceAutoPublishEligibility({
      ...BASE,
      scheduled_status: "scheduled",
      scheduled_broadcast_at: "2026-11-12T06:00:00.000Z",
    }, { nowMs: Date.parse("2026-11-12T07:00:00.000Z") }).reason,
    "already_published",
  );
});

Deno.test("Manual Trip booking_source is exceptional (recovery skip)", () => {
  assert(isExceptionalManualBookingSource("admin_manual"));
  assert(!isRoutineAutoPublishBookingSource("admin_manual"));
  const r = evaluateScheduledMarketplaceAutoPublishEligibility({
    ...BASE,
    booking_source: "admin_manual",
  }, { allowUnknownBookingSource: false });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "manual_admin_hold");
});

Deno.test("classify dry-run taxonomy: routine vs airport vs manual", () => {
  assertEquals(classifyScheduledMarketplaceHold(BASE).class, "routine_admin_held");
  assertEquals(classifyScheduledMarketplaceHold(BASE).proposedAction, "auto_publish");
  assertEquals(
    classifyScheduledMarketplaceHold({
      ...BASE,
      broadcast_enabled: false,
      airport_charge_pence: 500,
    }).class,
    "airport_pricing_hold",
  );
  assertEquals(
    classifyScheduledMarketplaceHold({
      ...BASE,
      booking_source: "admin_manual",
    }).class,
    "manual_admin_hold",
  );
});

Deno.test("auto-publish patch is Make Available (not NRO convert)", () => {
  const patch = buildScheduledMarketplaceAutoPublishPatch("2026-11-12T07:00:00.000Z");
  assertEquals(patch.scheduled_status, "scheduled");
  assertEquals(patch.status, "scheduled");
  assertEquals(patch.dispatch_mode, "scheduled");
  assertEquals(patch.scheduled_broadcast_at, "2026-11-12T07:00:00.000Z");
  assert(!("searching_expires_at" in patch));
  const retry = buildScheduledMarketplaceAutoPublishRetryPatch("2026-11-12T07:00:00.000Z");
  assertEquals(retry.pending_release_kind, "jobs");
});

Deno.test("post-commit + recovery sweep are wired into bookingPostCommit and scheduled-dispatch", async () => {
  const postCommit = await Deno.readTextFile(
    new URL("./bookingPostCommit.ts", import.meta.url),
  );
  assertStringIncludes(postCommit, "attemptScheduledMarketplaceAutoPublish");
  assertStringIncludes(postCommit, "SCHEDULED_MARKETPLACE_AUTO_PUBLISH");
  assertStringIncludes(postCommit, "assertPaymentGate");

  const dispatch = await Deno.readTextFile(
    new URL("../scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(dispatch, "auto-publish recovery");
  assertStringIncludes(dispatch, SCHEDULED_MARKETPLACE_AUTO_PUBLISH_VIA.recovery_sweep);
  assertStringIncludes(dispatch, "pending jobs payment gate blocked");
});
