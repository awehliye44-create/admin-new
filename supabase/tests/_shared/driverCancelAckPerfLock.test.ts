/**
 * #55B / #55C — Driver cancel ack must not wait on rematch dispatch;
 * admin cancel must notify the assigned Driver immediately after commit.
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("#55B driver-cancel-before-pickup defers rematch after CAS ack", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/driver-cancel-before-pickup/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "scheduleEdgeBackground");
  assertStringIncludes(src, "deferred_background");
  assertEquals(
    /scheduleEdgeBackground\([\s\S]*rebroadcastTripViaAutoDispatch/.test(src),
    true,
  );
  const scheduleAt = src.indexOf("scheduleEdgeBackground(async");
  const successAt = src.indexOf("return successResponse({", scheduleAt);
  assertEquals(scheduleAt > -1, true);
  assertEquals(successAt > scheduleAt, true);
  // Waiting reset + stacked lifecycle stay sync (durable if waitUntil dies).
  assertStringIncludes(src, "buildRematchPickupWaitingResetPatch");
  assertEquals(
    src.lastIndexOf("buildRematchPickupWaitingResetPatch(") < scheduleAt,
    true,
  );
  assertStringIncludes(src, 'failureReason: "driver_cancel_before_pickup"');
  assertEquals(
    src.indexOf('failureReason: "driver_cancel_before_pickup"') < scheduleAt,
    true,
  );
  // Wrong stacked param keys must never return (silent no-op).
  assertEquals(src.includes("stackedTripId:"), false);
  assertEquals(src.includes('reason: "driver_cancel_before_pickup"'), false);
});

Deno.test("#55B expire-offers recovers searching_new_driver without pending offers", async () => {
  const expire = await Deno.readTextFile(
    new URL("../../functions/expire-offers/index.ts", import.meta.url),
  );
  assertStringIncludes(expire, "searching_new_driver");
  assertStringIncludes(expire, "force_rebroadcast");
});

Deno.test("#55 post-start driver_cancel defers payment+notify after terminal CAS", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/lib/driverTripCancel.ts", import.meta.url),
  );
  assertStringIncludes(src, "scheduleEdgeBackground");
  assertStringIncludes(src, "disposeTerminalTripPayment");
  assertStringIncludes(src, "background_payment_notify");
  const scheduleAt = src.indexOf("scheduleEdgeBackground(async");
  const disposeAt = src.indexOf("disposeTerminalTripPayment", scheduleAt);
  assertEquals(scheduleAt > -1, true);
  assertEquals(disposeAt > scheduleAt, true);
  // Stacked follow-up remains sync before background.
  assertEquals(
    src.indexOf('failureReason: "driver_cancel_terminal"') < scheduleAt,
    true,
  );
});

Deno.test("#55C admin-trip-actions notifies assigned Driver after terminal cancel", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/admin-trip-actions/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "notifyDriverTripStopped");
  assertStringIncludes(src, "assignedDriverId");
  const rpcAt = src.indexOf("apply_terminal_trip_cancellation");
  const notifyCallAt = src.indexOf("void notifyDriverTripStopped(");
  assertEquals(rpcAt > -1, true);
  assertEquals(notifyCallAt > rpcAt, true);
});
