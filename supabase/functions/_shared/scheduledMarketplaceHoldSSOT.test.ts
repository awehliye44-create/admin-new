/**
 * Phase 3 gap closure — hold reason + airport persist-failure latch locks.
 * Airport hold reuses existing Custom Zones route-pricing SSOT; zero/absent ≠ hold.
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
import { decideDispatchAfterFareEnrich } from "./airportChargeFareSplitSSOT.ts";

Deno.test("assertAirportPricingReady: only genuine persist-failure latch", () => {
  // Authoritative stamp from post-commit decideDispatchAfterFareEnrich holdBroadcast.
  assertEquals(
    assertAirportPricingReady({
      scheduledHoldReason: "airport_pricing",
      broadcastEnabled: false,
      airportChargePence: null,
    }).ok,
    false,
  );
  assertEquals(
    assertAirportPricingReady({
      scheduledHoldReason: "airport_pricing",
      broadcastEnabled: true,
      airportChargePence: 0,
    }).ok,
    false,
  );

  // Valid zero / absent charge must never hold (parity with airport_absent).
  assertEquals(
    assertAirportPricingReady({
      broadcastEnabled: false,
      airportChargePence: 0,
    }).ok,
    true,
  );
  assertEquals(
    assertAirportPricingReady({
      broadcastEnabled: false,
      airportChargePence: null,
    }).ok,
    true,
  );
  assertEquals(
    assertAirportPricingReady({
      broadcastEnabled: true,
      airportChargePence: 0,
    }).ok,
    true,
  );
  assertEquals(
    assertAirportPricingReady({ broadcastEnabled: null }).ok,
    true,
  );

  // Legacy: positive charge still latched off broadcast.
  assertEquals(
    assertAirportPricingReady({
      broadcastEnabled: false,
      airportChargePence: 700,
    }).ok,
    false,
  );
});

Deno.test("decideDispatchAfterFareEnrich parity: zero quote never holds broadcast", () => {
  assertEquals(
    decideDispatchAfterFareEnrich({
      quoteAirportPence: 0,
      persistedAirportPence: null,
      updateFailed: true,
    }),
    { allowDispatch: true, holdBroadcast: false, reason: "airport_absent" },
  );
  assertEquals(
    decideDispatchAfterFareEnrich({
      quoteAirportPence: 700,
      persistedAirportPence: 0,
      updateFailed: true,
    }).holdBroadcast,
    true,
  );
});

Deno.test("forceOpen cannot bypass airport broadcast hold latch", () => {
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
    airportChargePence: 0,
  });
  assertEquals(pending.autoPublishEligible, true);

  // Zero-charge + broadcast false without airport_pricing stamp → not airport hold.
  const zeroOk = classifyAuthoritativeHold({
    scheduledHoldReason: "publication_pending",
    scheduledStatus: "admin_held",
    broadcastEnabled: false,
    airportChargePence: 0,
  });
  assertEquals(zeroOk.class, "publication_pending");
  assertEquals(zeroOk.autoPublishEligible, true);
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
      broadcast_enabled: true,
      airport_charge_pence: 0,
    }).ok,
    true,
  );
  // Zero charge must publish even if broadcast_enabled was incorrectly false.
  assertEquals(
    evaluateScheduledMarketplaceAutoPublishEligibility({
      ...base,
      scheduled_hold_reason: "publication_pending",
      broadcast_enabled: false,
      airport_charge_pence: 0,
    }).ok,
    true,
  );
  assertEquals(
    evaluateScheduledMarketplaceAutoPublishEligibility({
      ...base,
      scheduled_hold_reason: "airport_pricing",
      broadcast_enabled: false,
      airport_charge_pence: null,
    }).reason,
    "airport_pricing_hold",
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

Deno.test("admin-scheduled-ride-action Edge gates airport persist latch + reason + audit", async () => {
  const src = await Deno.readTextFile(
    new URL("../admin-scheduled-ride-action/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "assertAirportPricingReady");
  assertStringIncludes(src, "assertPaymentGate");
  assertStringIncludes(src, "reason required");
  assertStringIncludes(src, "admin_scheduled_emergency_mutate");
  assertStringIncludes(src, "AIRPORT_PRICING_UNRESOLVED");
  assertStringIncludes(src, "Custom Zones route pricing");
});

Deno.test("DB migration enforces airport broadcast hold trigger + persist release", async () => {
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
  assertStringIncludes(sql, "Existing mandatory airport charge has not been persisted yet");
  assertStringIncludes(sql, "decideDispatchAfterFareEnrich");
});
