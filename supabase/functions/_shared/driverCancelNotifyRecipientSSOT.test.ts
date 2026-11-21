/**
 * #66 — Cancel notify recipient eligibility (rematch-released vs live assigned).
 */
import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isDriverEligibleForCancelTripNotify,
  resolveCancelNotifyAssignedDriverId,
} from "./driverCancelNotifyRecipientSSOT.ts";

const DRIVER_A = "c40dd8a6-f422-40bc-9534-bae7be88b93e";
const DRIVER_B = "56136f5f-1a3a-4a14-bb23-439b3951415a";

Deno.test("#66 resolveCancelNotifyAssignedDriverId prefers confirmed then driver; never previous", () => {
  assertEquals(
    resolveCancelNotifyAssignedDriverId({
      confirmed_driver_id: DRIVER_A,
      driver_id: DRIVER_B,
      previous_driver_id: DRIVER_A,
    }),
    DRIVER_A,
  );
  assertEquals(
    resolveCancelNotifyAssignedDriverId({
      confirmed_driver_id: null,
      driver_id: DRIVER_B,
      previous_driver_id: DRIVER_A,
    }),
    DRIVER_B,
  );
  assertEquals(
    resolveCancelNotifyAssignedDriverId({
      confirmed_driver_id: null,
      driver_id: null,
      previous_driver_id: DRIVER_A,
    }),
    null,
  );
});

Deno.test("#66 Driver A cancels → broadcasting → Admin cancel: no notify to A", () => {
  const trip = {
    confirmed_driver_id: null,
    driver_id: null,
    previous_driver_id: DRIVER_A,
    cancelled_driver_ids: [DRIVER_A],
    excluded_driver_ids: [DRIVER_A],
  };
  assertEquals(resolveCancelNotifyAssignedDriverId(trip), null);
  assertEquals(isDriverEligibleForCancelTripNotify(trip, DRIVER_A), false);
});

Deno.test("#66 Driver A cancels → broadcasting → Customer cancel: no notify to A", () => {
  const trip = {
    confirmed_driver_id: null,
    driver_id: null,
    previous_driver_id: DRIVER_A,
    cancelled_driver_ids: [DRIVER_A],
    excluded_driver_ids: [DRIVER_A],
  };
  assertEquals(isDriverEligibleForCancelTripNotify(trip, DRIVER_A), false);
});

Deno.test("#66 Driver A cancels → Driver B accepts → cancel notifies only B", () => {
  const trip = {
    confirmed_driver_id: DRIVER_B,
    driver_id: DRIVER_B,
    previous_driver_id: DRIVER_A,
    cancelled_driver_ids: [DRIVER_A],
    excluded_driver_ids: [DRIVER_A],
  };
  assertEquals(resolveCancelNotifyAssignedDriverId(trip), DRIVER_B);
  assertEquals(isDriverEligibleForCancelTripNotify(trip, DRIVER_B), true);
  assertEquals(isDriverEligibleForCancelTripNotify(trip, DRIVER_A), false);
});

Deno.test("#66 delayed cancel notify after rematch release is blocked", () => {
  // Send-time row after Admin cancel while still carrying rematch release ids.
  const trip = {
    confirmed_driver_id: null,
    driver_id: null,
    previous_driver_id: DRIVER_A,
    cancelled_driver_ids: [DRIVER_A],
    excluded_driver_ids: [DRIVER_A],
  };
  assertEquals(isDriverEligibleForCancelTripNotify(trip, DRIVER_A), false);
});

Deno.test("#66 genuinely assigned trip cancel notifies the assigned driver", () => {
  const trip = {
    confirmed_driver_id: DRIVER_A,
    driver_id: DRIVER_A,
    previous_driver_id: null,
    cancelled_driver_ids: null,
    excluded_driver_ids: null,
  };
  assertEquals(resolveCancelNotifyAssignedDriverId(trip), DRIVER_A);
  assertEquals(isDriverEligibleForCancelTripNotify(trip, DRIVER_A), true);
  assertEquals(isDriverEligibleForCancelTripNotify(trip, DRIVER_B), false);
});

Deno.test("#66 delayed legitimate cancel via previous_driver_id (no rematch release) allowed", () => {
  const trip = {
    confirmed_driver_id: null,
    driver_id: null,
    previous_driver_id: DRIVER_A,
    cancelled_driver_ids: null,
    excluded_driver_ids: null,
  };
  assertEquals(isDriverEligibleForCancelTripNotify(trip, DRIVER_A), true);
});

Deno.test("#66 same driver reassigned after rematch is eligible again", () => {
  const trip = {
    confirmed_driver_id: DRIVER_A,
    driver_id: DRIVER_A,
    previous_driver_id: DRIVER_A,
    cancelled_driver_ids: [DRIVER_A],
    excluded_driver_ids: [DRIVER_A],
  };
  assertEquals(resolveCancelNotifyAssignedDriverId(trip), DRIVER_A);
  assertEquals(isDriverEligibleForCancelTripNotify(trip, DRIVER_A), true);
});

Deno.test("#66 stacked / scheduled isolation: only current assignment notified", () => {
  const stacked = {
    confirmed_driver_id: DRIVER_B,
    driver_id: DRIVER_B,
    previous_driver_id: DRIVER_A,
    cancelled_driver_ids: [DRIVER_A],
    excluded_driver_ids: [DRIVER_A],
  };
  assertEquals(resolveCancelNotifyAssignedDriverId(stacked), DRIVER_B);
  assertEquals(isDriverEligibleForCancelTripNotify(stacked, DRIVER_B), true);
  assertEquals(isDriverEligibleForCancelTripNotify(stacked, DRIVER_A), false);

  const scheduledUnassigned = {
    confirmed_driver_id: null,
    driver_id: null,
    previous_driver_id: DRIVER_A,
    cancelled_driver_ids: [DRIVER_A],
    excluded_driver_ids: [DRIVER_A],
  };
  assertEquals(resolveCancelNotifyAssignedDriverId(scheduledUnassigned), null);
  assertEquals(
    isDriverEligibleForCancelTripNotify(scheduledUnassigned, DRIVER_A),
    false,
  );
});

Deno.test("#66 lock: admin-trip-actions must not fall back to previous_driver_id", async () => {
  const src = await Deno.readTextFile(
    new URL("../admin-trip-actions/index.ts", import.meta.url),
  );
  assertEquals(src.includes("resolveCancelNotifyAssignedDriverId"), true);
  assertEquals(src.includes("isDriverEligibleForCancelTripNotify"), true);
  // The old OR-chain that notified rematch-released drivers must stay gone.
  assertEquals(
    src.includes(
      '(typeof current.previous_driver_id === "string" && current.previous_driver_id)',
    ),
    false,
  );
  assertNotEquals(src.indexOf("resolveCancelNotifyAssignedDriverId"), -1);
});

Deno.test("#66 lock: send-driver-notification validates cancel assignment at send time", async () => {
  const src = await Deno.readTextFile(
    new URL("../send-driver-notification/index.ts", import.meta.url),
  );
  assertEquals(src.includes("cancel_ride_stop_skip_ineligible_assignment"), true);
  assertEquals(src.includes("isDriverEligibleForCancelTripNotify"), true);
});

Deno.test("#66 lock: cancel-trip + late-cancellation-check use recipient SSOT", async () => {
  const cancelTrip = await Deno.readTextFile(
    new URL("../cancel-trip/index.ts", import.meta.url),
  );
  const late = await Deno.readTextFile(
    new URL("../late-cancellation-check/index.ts", import.meta.url),
  );
  assertEquals(cancelTrip.includes("resolveCancelNotifyAssignedDriverId"), true);
  assertEquals(cancelTrip.includes("isDriverEligibleForCancelTripNotify"), true);
  assertEquals(late.includes("resolveCancelNotifyAssignedDriverId"), true);
  assertEquals(late.includes("isDriverEligibleForCancelTripNotify"), true);
});
