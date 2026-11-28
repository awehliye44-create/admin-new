/**
 * Bug #27: accept + cancel_confirmed must return after authoritative commit;
 * notify / marketplace / dispatch kicks run via scheduleEdgeBackground.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = await Deno.readTextFile(
  new URL("../../functions/scheduled-ride-action/index.ts", import.meta.url),
);

Deno.test("Bug #27: scheduled-ride-action imports scheduleEdgeBackground", () => {
  assertStringIncludes(src, 'from "../_shared/scheduleEdgeBackground.ts"');
});

Deno.test("Bug #27: accept post-commit notify/broadcast is backgrounded", () => {
  const acceptAt = src.indexOf('if (action === "accept")');
  const declineAt = src.indexOf('if (action === "decline")');
  assertEquals(acceptAt > -1, true);
  assertEquals(declineAt > acceptAt, true);
  const acceptBlock = src.slice(acceptAt, declineAt);
  assertStringIncludes(acceptBlock, 'scheduleEdgeBackground(async () => {');
  assertStringIncludes(acceptBlock, "scheduled_accept_post_commit");
  assertStringIncludes(acceptBlock, 'post_commit: "background"');
  assertStringIncludes(acceptBlock, "stages_ms: acceptStagesMs");
  // Must not await marketplace broadcast on the sync path after accept RPC.
  const syncTail = acceptBlock.slice(
    0,
    acceptBlock.indexOf("scheduleEdgeBackground(async () => {"),
  );
  assertEquals(syncTail.includes("broadcastScheduledMarketplaceChanged"), false);
  assertEquals(syncTail.includes("notifyCustomerTripLifecycle"), false);
  assertEquals(syncTail.includes("send-driver-notification"), false);
  assertEquals(syncTail.includes("deliverCustomerLifecycleNotifyByKind"), false);
  // SN1: durable intent allowed on sync path; provider send stays background.
  assertStringIncludes(syncTail, "persistCustomerLifecycleNotifyIntent");
});

Deno.test("Bug #27: cancel_confirmed post-CAS work is backgrounded", () => {
  const cancelAt = src.indexOf('if (action === "cancel_confirmed")');
  assertEquals(cancelAt > -1, true);
  const cancelBlock = src.slice(cancelAt);
  assertStringIncludes(cancelBlock, 'scheduleEdgeBackground(async () => {');
  assertStringIncludes(cancelBlock, "scheduled_cancel_post_cas");
  assertStringIncludes(cancelBlock, 'post_commit: "background"');
  assertStringIncludes(cancelBlock, "stages_ms: cancelStagesMs");
  const beforeBg = cancelBlock.slice(
    0,
    cancelBlock.indexOf("scheduleEdgeBackground(async () => {"),
  );
  assertStringIncludes(beforeBg, "release_scheduled_assignment_for_driver_cancel");
  assertEquals(beforeBg.includes("auto-dispatch"), false);
  assertEquals(beforeBg.includes("scheduled-dispatch"), false);
  assertEquals(
    beforeBg.includes("notifyCustomerTripLifecycle"),
    false,
  );
});
