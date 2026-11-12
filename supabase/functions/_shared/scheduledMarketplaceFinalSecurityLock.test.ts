/**
 * Phase 3 final security readiness — lock tests (no production deploy).
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SCHEDULED_MARKETPLACE_PUBLISH_MAX_ATTEMPTS,
  evaluateScheduledMarketplaceAutoPublishEligibility,
} from "./scheduledMarketplaceAutoPublishSSOT.ts";
import {
  AUTO_PUBLISH_BLOCKED_HOLD_REASONS,
  AUTO_PUBLISH_ELIGIBLE_HOLD_REASONS,
  SCHEDULED_HOLD_REASONS,
} from "./scheduledMarketplaceHoldSSOT.ts";
import { permissionKeyForScheduledRideAction } from "./scheduledRidesActionPermissionsSSOT.ts";
import { isCardFundedPaymentMethod } from "./scheduledCaptureCoverageSSOT.ts";

const root = new URL("../../../", import.meta.url);

Deno.test("scheduled rides action keys map 1:1 for every Edge action", () => {
  const actions = [
    "make_available_now",
    "make_available_at",
    "assign_now",
    "assign_at",
    "broadcast_now",
    "broadcast_at",
    "hold_exceptional",
    "cancel_pending_release",
    "cancel_ride",
  ];
  for (const a of actions) {
    const key = permissionKeyForScheduledRideAction(a);
    assert(key?.startsWith("scheduled_rides."), `missing mapping for ${a}`);
  }
  assertEquals(permissionKeyForScheduledRideAction("make_available_now"), "scheduled_rides.make_available");
  assertEquals(permissionKeyForScheduledRideAction("assign_now"), "scheduled_rides.assign");
  assertEquals(permissionKeyForScheduledRideAction("cancel_ride"), "scheduled_rides.cancel_ride");
});

Deno.test("Admin Roles SSOT catalogues scheduled_rides actions without mass-grant copy", async () => {
  const ssot = await Deno.readTextFile(new URL("shared/rolesPermissionsSSOT.ts", root));
  assertStringIncludes(ssot, "scheduled_rides.make_available");
  assertStringIncludes(ssot, "scheduled_rides.assign");
  assertStringIncludes(ssot, "scheduled_rides.broadcast");
  assertStringIncludes(ssot, "scheduled_rides.hold");
  assertStringIncludes(ssot, "scheduled_rides.cancel_pending");
  assertStringIncludes(ssot, "scheduled_rides.cancel_ride");
  assertStringIncludes(ssot, "does NOT grant these automatically");
});

Deno.test("RolesPermissions UI exposes Scheduled Rides action matrix", async () => {
  const src = await Deno.readTextFile(new URL("src/pages/RolesPermissions.tsx", root));
  assertStringIncludes(src, "SCHEDULED_RIDES_ROLE_ACTION_KEYS");
  assertStringIncludes(src, "Scheduled Rides — Emergency Action Capabilities");
});

Deno.test("admin-scheduled-ride-action enforces action RBAC + audit atomicity + staff JWT", async () => {
  const src = await Deno.readTextFile(
    new URL("supabase/functions/admin-scheduled-ride-action/index.ts", root),
  );
  assertStringIncludes(src, "requireStaffAction");
  assertStringIncludes(src, "permissionKeyForScheduledRideAction");
  assertStringIncludes(src, "requireAdminOrStaff");
  assertStringIncludes(src, "STAFF_JWT_REQUIRED");
  assertStringIncludes(src, "AUDIT_REQUIRED");
  assertStringIncludes(src, "auditOrFail");
  assertStringIncludes(src, "assign_now");
  assertStringIncludes(src, "cancel_ride");
  assertStringIncludes(src, "apply_terminal_trip_cancellation");
  // Must not swallow audit failures.
  assert(!/console\.warn\(\s*"\[admin-scheduled-ride-action\] audit insert failed"/.test(src));
});

Deno.test("ScheduledRides routes Assign Now and Cancel Ride through Edge", async () => {
  const src = await Deno.readTextFile(new URL("src/pages/ScheduledRides.tsx", root));
  assertStringIncludes(src, "action: 'assign_now'");
  assertStringIncludes(src, "action: 'cancel_ride'");
  assert(!/admin_assign_scheduled_driver/.test(src));
  assert(!/admin-trip-actions/.test(src));
  assert(!/adminPageMutate/.test(src));
});

Deno.test("final security migration blocks admin_page_mutate protected fields", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "supabase/migrations/20270213130000_scheduled_marketplace_final_security.sql",
      root,
    ),
  );
  assertStringIncludes(sql, "_admin_trips_protected_mutate_columns");
  assertStringIncludes(sql, "scheduled_status");
  assertStringIncludes(sql, "scheduled_broadcast_at");
  assertStringIncludes(sql, "broadcast_enabled");
  assertStringIncludes(sql, "scheduled_hold_reason");
  assertStringIncludes(sql, "pending_release_kind");
  assertStringIncludes(sql, "confirmed_driver_id");
  assertStringIncludes(sql, "dispatch_mode");
  assertStringIncludes(sql, "scheduled_rides.assign");
  assertStringIncludes(sql, "publication_exhausted");
  // No mass-grant of emergency actions
  assert(!/INSERT INTO public\.role_action_permissions[\s\S]*scheduled_rides\./i.test(sql));
});

Deno.test("publication exhausted is never auto-publish eligible", () => {
  assert((SCHEDULED_HOLD_REASONS as readonly string[]).includes("publication_exhausted"));
  assert((AUTO_PUBLISH_BLOCKED_HOLD_REASONS as readonly string[]).includes("publication_exhausted"));
  assert(!(AUTO_PUBLISH_ELIGIBLE_HOLD_REASONS as readonly string[]).includes("publication_exhausted"));
  assertEquals(SCHEDULED_MARKETPLACE_PUBLISH_MAX_ATTEMPTS, 5);

  const blocked = evaluateScheduledMarketplaceAutoPublishEligibility({
    dispatch_mode: "scheduled",
    status: "scheduled",
    scheduled_status: "admin_held",
    scheduled_hold_reason: "publication_exhausted",
    scheduled_publish_attempts: 5,
    broadcast_enabled: true,
    booking_source: "customer_app",
    service_area_id: "sa",
  });
  assertEquals(blocked.ok, false);

  const maxed = evaluateScheduledMarketplaceAutoPublishEligibility({
    dispatch_mode: "scheduled",
    status: "scheduled",
    scheduled_status: "admin_held",
    scheduled_hold_reason: "publication_retry",
    scheduled_publish_attempts: 5,
    broadcast_enabled: true,
    booking_source: "customer_app",
    service_area_id: "sa",
  });
  assertEquals(maxed.ok, false);
});

Deno.test("manual / exceptional / unknown holds never auto-release", () => {
  for (const reason of [
    "admin_exceptional",
    "manual_trip",
    "unknown_historical",
    "airport_pricing",
    "payment_gate",
  ] as const) {
    const r = evaluateScheduledMarketplaceAutoPublishEligibility({
      dispatch_mode: "scheduled",
      status: "scheduled",
      scheduled_status: "admin_held",
      scheduled_hold_reason: reason,
      broadcast_enabled: reason === "airport_pricing" ? false : true,
      airport_charge_pence: reason === "airport_pricing" ? null : 0,
      booking_source: "customer_app",
      service_area_id: "sa",
    });
    assertEquals(r.ok, false, reason);
  }
});

Deno.test("valid zero airport charge never triggers airport pricing hold", async () => {
  const { assertAirportPricingReady } = await import("./scheduledMarketplaceHoldSSOT.ts");
  assertEquals(
    assertAirportPricingReady({
      broadcastEnabled: false,
      airportChargePence: 0,
      scheduledHoldReason: "publication_pending",
    }).ok,
    true,
  );
  assertEquals(
    evaluateScheduledMarketplaceAutoPublishEligibility({
      dispatch_mode: "scheduled",
      status: "scheduled",
      scheduled_status: "admin_held",
      scheduled_hold_reason: "publication_pending",
      broadcast_enabled: false,
      airport_charge_pence: 0,
      booking_source: "customer_app",
      service_area_id: "sa",
    }).ok,
    true,
  );
});

Deno.test("non-card payment models skip Revolut authorisation only", async () => {
  assertEquals(isCardFundedPaymentMethod("card"), true);
  assertEquals(isCardFundedPaymentMethod("apple_pay"), true);
  assertEquals(isCardFundedPaymentMethod("google_pay"), true);
  assertEquals(isCardFundedPaymentMethod("cash"), false);
  assertEquals(isCardFundedPaymentMethod("corporate_invoice"), false);

  const gateSql = await Deno.readTextFile(
    new URL(
      "supabase/migrations/20270201120100_scheduled_finance_phase1_gap_closure.sql",
      root,
    ),
  );
  // Authoritative gate: card-funded Revolut path; non-card early return; commission wallet model return.
  assertStringIncludes(gateSql, "DRIVER_COLLECTED_COMMISSION_WALLET");
  assertStringIncludes(gateSql, "CARD','APPLE_PAY','GOOGLE_PAY");

  const postCommit = await Deno.readTextFile(
    new URL("supabase/functions/_shared/bookingPostCommit.ts", root),
  );
  assertStringIncludes(postCommit, "assertPaymentGate");
  assertStringIncludes(postCommit, "attemptScheduledMarketplaceAutoPublish");
  assertStringIncludes(postCommit, "holdBroadcast");
  // Airport readiness is enforced inside evaluateScheduledMarketplaceAutoPublishEligibility.
  const autoPub = await Deno.readTextFile(
    new URL("supabase/functions/_shared/scheduledMarketplaceAutoPublishSSOT.ts", root),
  );
  assertStringIncludes(autoPub, "assertAirportPricingReady");

  // Corporate payment method enforcement remains at insert (existing policy).
  const corpSql = await Deno.readTextFile(
    new URL(
      "supabase/migrations/20261108200000_corporate_suspended_booking_digital_only_lock.sql",
      root,
    ),
  );
  assertStringIncludes(corpSql, "get_corporate_allowed_payment_methods");

  // Commission wallet eligibility remains at dispatch/offer stage.
  const eligibility = await Deno.readTextFile(
    new URL("supabase/functions/_shared/rideOfferDriverEligibility.ts", root),
  );
  assertStringIncludes(eligibility, "driver_passes_commission_wallet_dispatch_gate");
});

Deno.test("payment gate clear restores publication_pending only for payment_gate holds", async () => {
  const src = await Deno.readTextFile(
    new URL("supabase/functions/_shared/paymentGateBlockedResolutionSSOT.ts", root),
  );
  assertStringIncludes(src, 'scheduled_hold_reason: "publication_pending"');
  assertStringIncludes(src, 'eq("scheduled_hold_reason", "payment_gate")');
});

Deno.test("exhaustion stamps ops_alerts", async () => {
  const src = await Deno.readTextFile(
    new URL("supabase/functions/_shared/scheduledMarketplaceAutoPublishSSOT.ts", root),
  );
  assertStringIncludes(src, "stampScheduledMarketplacePublishExhausted");
  assertStringIncludes(src, "ops_alerts");
  assertStringIncludes(src, "publication_exhausted");
  assertStringIncludes(src, "scheduled_marketplace_publish_exhausted");
});
