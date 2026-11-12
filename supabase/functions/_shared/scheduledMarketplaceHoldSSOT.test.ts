/**
 * Phase 3 gap closure — hold reason + airport bypass locks.
 */
import {
  assertEquals,
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertAirportPricingReady,
  classifyAuthoritativeHold,
  isAutoPublishEligibleHoldReason,
  resolveSafeBroadcastEnabled,
} from "./scheduledMarketplaceHoldSSOT.ts";
import { resolveConversionBroadcastEnabled } from "./scheduledDispatchConfig.ts";
import { evaluateScheduledMarketplaceAutoPublishEligibility } from "./scheduledMarketplaceAutoPublishSSOT.ts";

Deno.test("airport pricing hold blocks assertAirportPricingReady", () => {
  assertEquals(assertAirportPricingReady({ broadcastEnabled: false }).ok, false);
  assertEquals(assertAirportPricingReady({ broadcastEnabled: true }).ok, true);
  assertEquals(assertAirportPricingReady({ broadcastEnabled: null }).ok, true);
});

Deno.test("forceOpen cannot bypass airport broadcast hold", () => {
  assertEquals(
    resolveConversionBroadcastEnabled({
      currentBroadcastEnabled: false,
      forceOpen: true,
    }),
    false,
  );
  assertEquals(
    resolveSafeBroadcastEnabled({
      currentBroadcastEnabled: false,
      forceOpen: true,
    }),
    false,
  );
  assertEquals(
    resolveConversionBroadcastEnabled({
      currentBroadcastEnabled: true,
      forceOpen: true,
    }),
    true,
  );
});

Deno.test("auto-publish eligible only for publication_pending / publication_retry", () => {
  assert(isAutoPublishEligibleHoldReason("publication_pending"));
  assert(isAutoPublishEligibleHoldReason("publication_retry"));
  assert(!isAutoPublishEligibleHoldReason("admin_exceptional"));
  assert(!isAutoPublishEligibleHoldReason("manual_trip"));
  assert(!isAutoPublishEligibleHoldReason("airport_pricing"));
  assert(!isAutoPublishEligibleHoldReason("unknown_historical"));
  assert(!isAutoPublishEligibleHoldReason(null));
});

Deno.test("unknown historical and exceptional holds fail closed for recovery", () => {
  const unknown = classifyAuthoritativeHold({
    scheduledHoldReason: null,
    scheduledStatus: "admin_held",
    scheduledBroadcastAt: null,
  });
  assertEquals(unknown.class, "unknown_historical");
  assertEquals(unknown.autoPublishEligible, false);

  const exceptional = classifyAuthoritativeHold({
    scheduledHoldReason: "admin_exceptional",
    scheduledStatus: "admin_held",
  });
  assertEquals(exceptional.autoPublishEligible, false);

  const pending = classifyAuthoritativeHold({
    scheduledHoldReason: "publication_pending",
    scheduledStatus: "admin_held",
    broadcastEnabled: true,
  });
  assertEquals(pending.autoPublishEligible, true);
});

Deno.test("eligibility requires hold_reason for recovery path", () => {
  const base = {
    dispatch_mode: "scheduled",
    status: "scheduled",
    scheduled_status: "admin_held",
    scheduled_broadcast_at: null,
    driver_id: null,
    confirmed_driver_id: null,
    broadcast_enabled: true,
    booking_source: "choose_ride",
    service_area_id: "sa-1",
  };
  assertEquals(
    evaluateScheduledMarketplaceAutoPublishEligibility({
      ...base,
      scheduled_hold_reason: "admin_exceptional",
    }, { allowUnknownBookingSource: false }).reason,
    "hold_reason_not_eligible",
  );
  assertEquals(
    evaluateScheduledMarketplaceAutoPublishEligibility({
      ...base,
      scheduled_hold_reason: "publication_pending",
    }, { allowUnknownBookingSource: false }).ok,
    true,
  );
});

Deno.test("Admin Broadcast Now UI no longer forces broadcast_enabled true", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../src/pages/ScheduledRides.tsx", import.meta.url),
  );
  assertStringIncludes(src, "invokeAdminScheduledRideAction");
  assertStringIncludes(src, "broadcast_now");
  assert(!/broadcast_enabled:\s*true/.test(src));
});

Deno.test("admin-scheduled-ride-action Edge gates airport + reason + audit", async () => {
  const src = await Deno.readTextFile(
    new URL("../admin-scheduled-ride-action/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "assertAirportPricingReady");
  assertStringIncludes(src, "assertPaymentGate");
  assertStringIncludes(src, "reason required");
  assertStringIncludes(src, "audit_logs");
  assertStringIncludes(src, "AIRPORT_PRICING_UNRESOLVED");
});

Deno.test("DB migration enforces airport broadcast hold trigger", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20270213120000_scheduled_marketplace_hold_reason.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "trips_enforce_airport_broadcast_hold");
  assertStringIncludes(sql, "scheduled_hold_reason");
  assertStringIncludes(sql, "unknown_historical");
  assertStringIncludes(sql, "release_scheduled_airport_broadcast_hold");
});
