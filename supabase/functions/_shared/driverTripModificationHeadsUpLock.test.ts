/**
 * Lock: applied trip modifications must push trip_modified to the Driver.
 * Realtime alone is not enough for heads-up when the app is backgrounded.
 *
 * P1: notify is awaited (not void), payload retains data.type=trip_modified,
 * metrics use booking_delivery_log via send-driver-notification.
 *
 * Run: deno test supabase/functions/_shared/driverTripModificationHeadsUpLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("A: fetchTripAndBroadcastUpdated awaits notifyDriverTripModified once", async () => {
  const apply = await Deno.readTextFile(
    new URL("./tripModificationApply.ts", import.meta.url),
  );
  const notify = await Deno.readTextFile(
    new URL("./notifyDriverTripModified.ts", import.meta.url),
  );
  assertEquals(apply.includes("notifyDriverTripModified"), true);
  assertEquals(apply.includes("await notifyDriverTripModified"), true);
  // Forbidden: fire-and-forget that Edge freeze can drop before FCM enqueue.
  assertEquals(apply.includes("void notifyDriverTripModified"), false);
  assertEquals(notify.includes('type: "trip_modified"'), true);
  assertEquals(notify.includes('type: "TRIP_UPDATE"'), true);
  assertEquals(notify.includes("modification_version"), true);
  assertEquals(notify.includes("change_request_id"), true);
  assertEquals(notify.includes("Never throws"), true);
});

Deno.test("B: previewOnly path does not call fetchTripAndBroadcastUpdated before return", async () => {
  const req = await Deno.readTextFile(
    new URL("../request-trip-modification/index.ts", import.meta.url),
  );
  // previewOnly returns early with preview payload — broadcast/notify only after applied.
  assertEquals(req.includes("if (previewOnly)"), true);
  assertEquals(req.includes("previewOnly: true"), true);
  assertEquals(
    req.includes('finalRequest.status === "applied" || finalRequest.status === "approved"'),
    true,
  );
  // Ensure notify path is gated on applied/approved (not preview).
  const appliedBlock = req.slice(
    req.indexOf('finalRequest.status === "applied"'),
  );
  assertEquals(appliedBlock.includes("fetchTripAndBroadcastUpdated"), true);
  const previewBlock = req.slice(
    req.indexOf("if (previewOnly)"),
    req.indexOf("if (previewOnly)") + 800,
  );
  assertEquals(previewBlock.includes("fetchTripAndBroadcastUpdated"), false);
});

Deno.test("C/H: send-driver-notification preserves trip_modified client type + HIGH priority", async () => {
  const src = await Deno.readTextFile(
    new URL("../send-driver-notification/index.ts", import.meta.url),
  );
  assertEquals(src.includes("isTripModified"), true);
  assertEquals(src.includes("type: isTripModified ? 'trip_modified' : payload.type"), true);
  assertEquals(src.includes("active_trip_updates"), true);
  assertEquals(src.includes("resolveDriverAuthoritativeToken"), true);
  assertEquals(src.includes("recordBookingDeliveryPhaseBestEffort"), true);
  assertEquals(src.includes('phase: "push_enqueued"'), true);
  assertEquals(src.includes('phase: "push_enqueued_skip_no_token"'), true);
  assertEquals(src.includes("recordFcmPushOutcomeBestEffort"), true);
});

Deno.test("D/E: no-token and FCM outcome instrumentation stay best-effort", async () => {
  const instr = await Deno.readTextFile(
    new URL("./fcmPushDeliveryInstrumentation.ts", import.meta.url),
  );
  assertEquals(instr.includes("recordBookingDeliveryPhaseBestEffort"), true);
  assertEquals(instr.includes("Never throws"), true);
  assertEquals(instr.includes("change_request_id"), true);
  const send = await Deno.readTextFile(
    new URL("../send-driver-notification/index.ts", import.meta.url),
  );
  assertEquals(send.includes("NO_TOKENS"), true);
  assertEquals(send.includes("push_enqueued_skip_no_token"), true);
});

Deno.test("G: change_request_id in detail (not offer_id FK) for per-mod idempotency", async () => {
  const notify = await Deno.readTextFile(
    new URL("./notifyDriverTripModified.ts", import.meta.url),
  );
  assertEquals(notify.includes("data.change_request_id = changeRequestId"), true);
  assertEquals(notify.includes("data.offer_id = changeRequestId"), false);
  assertEquals(notify.includes("apikey: serviceKey"), true);
  const apply = await Deno.readTextFile(
    new URL("./tripModificationApply.ts", import.meta.url),
  );
  assertEquals(apply.includes('.in("status", ["applied", "approved"])'), true);
  assertEquals(apply.includes("changeRequestId"), true);
  assertEquals(apply.includes("skip duplicate trip_modified notify"), true);
  assertEquals(apply.includes('filter("detail->>change_request_id", "eq", changeRequestId)'), true);
  assertEquals(apply.includes("options?.changeRequestId"), true);
});

Deno.test("metrics enqueue scoped to trip_modified only (not all trip pushes)", async () => {
  const send = await Deno.readTextFile(
    new URL("../send-driver-notification/index.ts", import.meta.url),
  );
  assertEquals(send.includes("Scope new enqueue metrics to trip_modified"), true);
  assertEquals(send.includes("trip_modified only (ride offers use postgres trigger)"), true);
  assertEquals(send.includes("eventType: isTripModified ? \"trip_modified\" : null"), true);
  assertEquals(send.includes("must NOT write change_request_id into offer_id"), true);
  assertEquals(send.includes("changeRequestId: isTripModified ? tripModifiedChangeRequestId : null"), true);
  const instr = await Deno.readTextFile(
    new URL("./fcmPushDeliveryInstrumentation.ts", import.meta.url),
  );
  assertEquals(instr.includes("Never map trip_change_requests.id / change_request_id"), true);
});

Deno.test("I: notify targets confirmed_driver_id (assigned Driver only)", async () => {
  const apply = await Deno.readTextFile(
    new URL("./tripModificationApply.ts", import.meta.url),
  );
  assertEquals(apply.includes("confirmed_driver_id"), true);
  assertEquals(apply.includes("await notifyDriverTripModified"), true);
});

Deno.test("J: Driver catch-up remains independent (backend does not remove Realtime broadcast)", async () => {
  const apply = await Deno.readTextFile(
    new URL("./tripModificationApply.ts", import.meta.url),
  );
  assertEquals(apply.includes("await broadcastTripUpdated"), true);
  assertEquals(apply.includes("await notifyDriverTripModified"), true);
});

Deno.test("default heads-up copy is Trip updated / Customer changed the trip", async () => {
  const notify = await Deno.readTextFile(
    new URL("./notifyDriverTripModified.ts", import.meta.url),
  );
  assertEquals(notify.includes('title: params.title ?? "Trip updated"'), true);
  assertEquals(
    notify.includes('body: params.body ?? "Customer changed the trip."'),
    true,
  );
});
