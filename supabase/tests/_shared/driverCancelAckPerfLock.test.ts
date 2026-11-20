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
  const scheduleAt = src.indexOf("scheduleEdgeBackground");
  const successAt = src.indexOf("return successResponse({", scheduleAt);
  assertEquals(successAt > scheduleAt, true);
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
