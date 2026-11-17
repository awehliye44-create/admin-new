/**
 * Bug #42/#43 — navigation_impacted must reflect active nav-target change.
 * MK-261117-010 applied change_dropoff with navigation_impacted=false because
 * request-trip-modification reused computeRequiresDriverApproval (always false).
 * requires_approval stays false; status must not reopen pending_driver_approval.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeNavigationTargetChanged,
  computeRequiresDriverApproval,
} from "../../functions/request-trip-modification/lib/tripModificationApproval.ts";

Deno.test("Bug #42/#43: change_dropoff with new coords is navigation impacted", () => {
  const before = [
    { type: "pickup", stop_index: 0, address: "MK Central", lat: 52.0342, lng: -0.773, status: "completed" },
    { type: "dropoff", stop_index: 1, address: "Hospital Roundabout", lat: 52.0238197, lng: -0.7355938, status: "current" },
  ];
  const after = [
    { type: "pickup", stop_index: 0, address: "MK Central", lat: 52.0342, lng: -0.773, status: "completed" },
    { type: "dropoff", stop_index: 1, address: "8 Broadlands", lat: 52.0225933, lng: -0.7365099, status: "pending" },
  ];
  assertEquals(
    computeNavigationTargetChanged({
      changeType: "change_dropoff",
      beforeStops: before,
      afterStops: after,
      tripStatus: "in_progress",
    }),
    true,
  );
  assertEquals(
    computeRequiresDriverApproval({
      changeType: "change_dropoff",
      beforeStops: before,
      afterStops: after,
      tripStatus: "in_progress",
      fareDeltaPence: 0,
      beforeDistanceMeters: 4390,
      afterDistanceMeters: 1151,
      beforeDurationSeconds: 600,
      afterDurationSeconds: 180,
    }),
    false,
  );
});

Deno.test("Bug #42/#43: request-trip-modification wires navigation target SSOT", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/request-trip-modification/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "computeNavigationTargetChanged");
  assertStringIncludes(src, "navigation_impacted: navigationImpacted");
  assertStringIncludes(src, 'status: paymentRequired ? "payment_required" : "approved"');
  // Must not reopen driver-approval from navigation_impacted alone.
  assertEquals(src.includes('navigationImpacted\n            ? "pending_driver_approval"'), false);
});
