/**
 * Bug #22 — pre-activation scheduled assignment release SSOT.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  shouldUrgentConvertOnPreActivationRelease,
  buildScheduledMarketplaceRematchPatch,
  buildScheduledUrgentRematchPatch,
  clearScheduledAssignmentSpecificState,
  resolvePreActivationReleaseKind,
} from "./scheduledPreActivationReleaseSSOT.ts";

Deno.test("Bug #22: urgent convert uses ~9m clock — not check-in ~20m", () => {
  const pickup = "2026-11-15T15:00:00.000Z";
  // 15 minutes before pickup: inside check-in (20) but outside urgent (9)
  assertEquals(
    shouldUrgentConvertOnPreActivationRelease({
      scheduledAtIso: pickup,
      nowMs: Date.parse("2026-11-15T14:45:00.000Z"),
      urgentTriggerMinutesBeforePickup: 9,
    }),
    false,
  );
  // 5 minutes before pickup: inside urgent
  assertEquals(
    shouldUrgentConvertOnPreActivationRelease({
      scheduledAtIso: pickup,
      nowMs: Date.parse("2026-11-15T14:55:00.000Z"),
      urgentTriggerMinutesBeforePickup: 9,
    }),
    true,
  );
});

Deno.test("Bug #22: marketplace rematch never stamps status=offered", () => {
  const patch = buildScheduledMarketplaceRematchPatch({
    nowIso: "2026-11-15T12:00:00.000Z",
    broadcastAtIso: "2026-11-15T10:00:00.000Z",
    broadcastEnabled: true,
    cancellationReason: "cannot_make_it",
  });
  assertEquals(patch.status, "scheduled");
  assertEquals(patch.dispatch_mode, "scheduled");
  assertEquals(patch.scheduled_status, "broadcasting");
  assertEquals(patch.dispatch_status, "available");
  assertEquals(patch.driver_id, null);
  assertEquals(patch.confirmed_driver_id, null);
  assertEquals(patch.cancelled_at, null);
  assertEquals(patch.scheduled_jit_activate_at, null);
  assertEquals(patch.commitment_time, null);
  assertEquals(patch.cancellation_reason, "cannot_make_it");
});

Deno.test("Bug #22: airport hold rematch stays admin_held / scheduled", () => {
  const patch = buildScheduledMarketplaceRematchPatch({
    nowIso: "2026-11-15T12:00:00.000Z",
    broadcastAtIso: "2026-11-15T10:00:00.000Z",
    broadcastEnabled: false,
  });
  assertEquals(patch.status, "scheduled");
  assertEquals(patch.scheduled_status, "admin_held");
  assertEquals(patch.broadcast_enabled, false);
});

Deno.test("Bug #22: urgent rematch uses Broadcast Now / convert shape", () => {
  const patch = buildScheduledUrgentRematchPatch({
    nowIso: "2026-11-15T14:55:00.000Z",
    searchingExpiresAtIso: "2026-11-15T15:01:00.000Z",
    currentBroadcastEnabled: true,
  });
  assertEquals(patch.dispatch_mode, "instant");
  assertEquals(patch.scheduled_status, "converted_to_instant");
  assertEquals(patch.status, "searching");
  assertEquals(patch.confirmed_driver_id, null);
  assertEquals(patch.driver_id, null);
});

Deno.test("Bug #22: clear assignment state drops JIT + commitment stamps", () => {
  const cleared = clearScheduledAssignmentSpecificState();
  assertEquals(cleared.scheduled_jit_activate_at, null);
  assertEquals(cleared.scheduled_committed_at, null);
  assertEquals(cleared.pending_release_kind, null);
  assertEquals(cleared.current_offer_driver_id, null);
});

Deno.test("Bug #22: resolvePreActivationReleaseKind marketplace vs urgent", () => {
  assertEquals(
    resolvePreActivationReleaseKind({
      scheduledAtIso: "2026-11-15T15:00:00.000Z",
      nowMs: Date.parse("2026-11-15T12:00:00.000Z"),
      urgentTriggerMinutesBeforePickup: 9,
      broadcastEnabled: true,
    }),
    "marketplace_reopen",
  );
  assertEquals(
    resolvePreActivationReleaseKind({
      scheduledAtIso: "2026-11-15T15:00:00.000Z",
      nowMs: Date.parse("2026-11-15T14:55:00.000Z"),
      urgentTriggerMinutesBeforePickup: 9,
      broadcastEnabled: true,
    }),
    "urgent_convert",
  );
});

Deno.test("Bug #22 lock: cancel_confirmed uses urgent SSOT + marketplace patch", async () => {
  const src = await Deno.readTextFile(
    new URL("../scheduled-ride-action/index.ts", import.meta.url),
  );
  const block = src.slice(src.indexOf('action === "cancel_confirmed"'));
  assertStringIncludes(block, "shouldUrgentConvertOnPreActivationRelease");
  assertStringIncludes(block, "buildScheduledMarketplaceRematchPatch");
  assertStringIncludes(block, "buildScheduledUrgentRematchPatch");
  assertStringIncludes(block, "isUrgentConvert");
  // Must not convert on check-in window alone.
  assertEquals(block.includes("isCheckinOpen"), false);
  assertEquals(block.includes('status: isCheckinOpen ? "pending"'), false);
  assertEquals(
    block.includes('rematchBroadcastEnabled ? "offered" : "scheduled"'),
    false,
  );
  assertStringIncludes(
    block,
    'path: isUrgentConvert ? "/booking/finding-drivers" : "/account/rides"',
  );
});

Deno.test("Bug #22 lock: compliance Edge mirror uses marketplace SSOT", async () => {
  const src = await Deno.readTextFile(
    new URL("./scheduledJourneyComplianceGate.ts", import.meta.url),
  );
  assertStringIncludes(src, "buildScheduledMarketplaceRematchPatch");
  assertEquals(src.includes('status: rematchBroadcastEnabled ? "offered"'), false);
});

Deno.test("Bug #22 lock: SQL release stamps status=scheduled (not offered)", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20270225120000_bug22_scheduled_preactivation_release_status.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "status = 'scheduled'");
  assertEquals(src.includes("THEN 'offered'"), false);
});
