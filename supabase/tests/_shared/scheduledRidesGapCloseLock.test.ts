/**
 * Gap-close lock: activation NRO net fare, rescue, T−9 default, list HELD filter,
 * check_in vs activation Accept, convert CAS, arm-after-insert.
 * Run: deno test --allow-read supabase/tests/_shared/scheduledRidesGapCloseLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveScheduledDispatchConfig } from "../../functions/_shared/scheduledDispatchConfig.ts";

Deno.test("T−urgent code default is 9 minutes (Hard Rule #2 config)", () => {
  const cfg = resolveScheduledDispatchConfig(null);
  assertEquals(cfg.urgentTriggerMinutesBeforePickup, 9);
});

Deno.test("activation NRO insert stamps offered_driver_net_pence + arm after insert", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "offered_driver_net_pence: netPence");
  assertStringIncludes(src, 'scheduled_status: "awaiting_activation_accept"');
  assertStringIncludes(src, "SCHEDULED_ACTIVATION_NRO_RESCUE");
  assertStringIncludes(src, "awaiting_activation_accept");
  assertStringIncludes(src, "releaseAndRebroadcast");
  // Arm only after successful offer insert (no same-tick false rescue).
  const insertIdx = src.indexOf('.from("ride_offers")');
  const armIdx = src.indexOf('scheduled_status: "awaiting_activation_accept"', insertIdx);
  assert(armIdx > insertIdx, "trip arm must follow ride_offers insert");
});

Deno.test("releaseAndRebroadcast covers awaiting_activation_accept", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, '"awaiting_activation_accept"');
  const releaseIdx = src.indexOf("async function releaseAndRebroadcast");
  const statusIdx = src.indexOf('"awaiting_activation_accept"', releaseIdx);
  assert(statusIdx > releaseIdx);
});

Deno.test("STEP 3 convert CAS requires confirmed_driver_id null + matched rows", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, '.is("confirmed_driver_id", null)');
  assertStringIncludes(src, "convertedRows");
  assertStringIncludes(src, "convertedRows.length === 0");
});

Deno.test("STEP 0 pending release skips after T−urgent convert / live search", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, 'schedStatusLower === "converted_to_instant"');
  assertStringIncludes(src, 'statusLower === "searching"');
});

Deno.test("list_driver jobs migration excludes admin_held and Start journey CTA", async () => {
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20261124130000_list_driver_scheduled_jobs_held_activation_lock.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(mig, "admin_held");
  assertStringIncludes(mig, "awaiting_activation_accept");
  assertStringIncludes(mig, "scheduled_broadcast_at IS NOT NULL");
  assert(!/THEN 'start_journey'/.test(mig));
  assert(!/THEN 'Start journey'/.test(mig));
});

Deno.test("scheduled-checkin check_in never activates; only awaiting_activation does", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-checkin/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "SCHEDULED_CHECKIN_STAMPED");
  assertStringIncludes(src, "activated: false");
  assertStringIncludes(src, "SCHEDULED_ACTIVATION_ACCEPT_SUCCESS");
  assertStringIncludes(src, 'eq("scheduled_status", "awaiting_activation_accept")');
  assertStringIncludes(src, 'action === "start_journey"');
  assertStringIncludes(src, "activatedRows");
  assertStringIncludes(src, 'status: "accepted"');
  assert(!/isActivationAccept/.test(src));
});

Deno.test("Return Job cancel_confirmed treats awaiting_activation as committed + clears offers", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-ride-action/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "awaiting_activation_accept");
  assertStringIncludes(src, 'action === "cancel_confirmed"');
  const cancelIdx = src.indexOf('action === "cancel_confirmed"');
  const awaitIdx = src.indexOf("awaiting_activation_accept", cancelIdx);
  assert(awaitIdx > cancelIdx);
  assertStringIncludes(src, '.from("ride_offers")');
  // Assign Now HELD never had broadcast_at — Return Job must reopen marketplace.
  assertStringIncludes(src, "scheduled_broadcast_at: broadcastAt");
  assertStringIncludes(src, "pre-window scheduled-dispatch kick failed");
  // Marketplace Accept must normalize to preconfirm (no live driver_id).
  assertStringIncludes(src, "accept preconfirm normalize");
  assertStringIncludes(src, "driver_id: null");
});

Deno.test("releaseAndRebroadcast stamps broadcast_at when missing", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  const releaseIdx = src.indexOf("async function releaseAndRebroadcast");
  assert(releaseIdx >= 0);
  const slice = src.slice(releaseIdx, releaseIdx + 3500);
  assertStringIncludes(slice, "scheduled_broadcast_at: broadcastAt");
  assertStringIncludes(slice, "awaiting_activation_accept");
  // Urgent path converts to instant then auto-dispatch; non-urgent stays marketplace.
  assertStringIncludes(slice, "buildScheduledUrgentConversionPatch");
  assertStringIncludes(slice, "if (urgent)");
  assertStringIncludes(slice, "triggerAutoDispatch");
});

Deno.test("get_available excludes admin_held from driver marketplace", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-ride-action/index.ts", import.meta.url),
  );
  assertStringIncludes(src, '=== "admin_held"');
  assertStringIncludes(src, "scheduled_broadcast_at");
  assertStringIncludes(src, "broadcastAtMs > Date.now()");
});

Deno.test("accept + check_eligibility reject Admin HELD / undued broadcast", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-ride-action/index.ts", import.meta.url),
  );
  assertStringIncludes(src, 'sched === "admin_held"');
  assertStringIncludes(src, "not open on the marketplace yet");
  assertStringIncludes(src, "broadcastDue");
  assertStringIncludes(src, '["broadcasting", "scheduled", "pending"]');
});

Deno.test("activeTripRestoreCore ignores HELD/preconfirm convert clock", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/activeTripRestoreCore.ts", import.meta.url),
  );
  assertStringIncludes(src, 'scheduledStatus === "admin_held"');
  assertStringIncludes(src, 'scheduledStatus === "awaiting_activation_accept"');
  assertStringIncludes(src, "return false");
});

Deno.test("create-ride scheduled stamps admin_held + null broadcast_at", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/create-ride/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "scheduled_status: isScheduled ? 'admin_held' : null");
  assertStringIncludes(src, "scheduledBroadcastAt = null");
  assertStringIncludes(src, 'const initialStatus = isScheduled ? "scheduled" : "searching"');
});

Deno.test("activation NRO never arms while still admin_held", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  // Step 1 candidate + arm CAS: never admin_held (legacy scheduled_committed OK).
  assertStringIncludes(
    src,
    '.in("scheduled_status", ["scheduled", "driver_assigned", "scheduled_committed"])',
  );
  assert(!/\.in\("scheduled_status", \["scheduled", "driver_assigned", "admin_held"\]\)/.test(src));
  assertStringIncludes(src, '=== "admin_held"');
});

Deno.test("Assign At cron notifies customer with /account/rides + CAS row check", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "admin_pending_assign_executed");
  assertStringIncludes(src, 'path: "/account/rides"');
  assertStringIncludes(src, "scheduled_assign_at");
  assertStringIncludes(src, "assignRows");
  assertStringIncludes(src, "broadcastRows");
  assertStringIncludes(src, "!assignRows?.length");
  assertStringIncludes(src, "!broadcastRows?.length");
});

Deno.test("auto-dispatch blocks Admin HELD / preconfirm / activation even with force_rebroadcast", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/auto-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "SCHEDULED_HELD_OR_PRECONFIRM");
  assertStringIncludes(src, 'mode === "scheduled"');
  assertStringIncludes(src, 'sched === "admin_held"');
  assertStringIncludes(src, 'sched === "awaiting_activation_accept"');
  assertStringIncludes(src, 'sched === "driver_assigned"');
  assertStringIncludes(src, "scheduled_held_or_preconfirm: true");
  // Must audit inline — abortDispatch is defined after vehicle-type resolve.
  const heldIdx = src.indexOf('reason: "SCHEDULED_HELD_OR_PRECONFIRM"');
  const abortDefIdx = src.indexOf("const abortDispatch =");
  assert(heldIdx >= 0 && abortDefIdx > heldIdx, "HELD gate must run before abortDispatch def");
});

Deno.test("cancel_confirmed customer notify deep-links by check-in window", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-ride-action/index.ts", import.meta.url),
  );
  assertStringIncludes(
    src,
    'path: isCheckinOpen ? "/booking/finding-drivers" : "/account/rides"',
  );
});

Deno.test("get-active-trip never treats HELD/preconfirm clocks as live", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/get-active-trip/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "SCHEDULED_PREACTIVATION_STATUSES");
  assertStringIncludes(src, '"admin_held"');
  assertStringIncludes(src, '"awaiting_activation_accept"');
  assertStringIncludes(src, '"driver_assigned"');
  assertStringIncludes(src, '"scheduled_committed"');
  assertStringIncludes(src, "Preconfirm / HELD / activation-armed stay on Rides→Scheduled");
});

Deno.test("Assign Now Admin UI pins status=scheduled with preconfirm", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../src/pages/ScheduledRides.tsx", import.meta.url),
  );
  assertStringIncludes(src, "scheduled_status: 'driver_assigned'");
  assertStringIncludes(src, "status: 'scheduled'");
  assertStringIncludes(src, "driver_id: null");
});

Deno.test("customerBusyGate ignores HELD/preconfirm clocks for Help busy", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/onecab-assistant/customerBusyGate.ts", import.meta.url),
  );
  assertStringIncludes(src, "SCHEDULED_PREACTIVATION_STATUSES");
  assertStringIncludes(src, '"admin_held"');
  assertStringIncludes(src, "Upcoming HELD / reserved / activation-armed");
});

Deno.test("driverBusyGate treats awaiting_activation as activating; HELD/preconfirm not", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/onecab-assistant/driverBusyGate.ts", import.meta.url),
  );
  assertStringIncludes(src, 'scheduledStatus === "awaiting_activation_accept"');
  assertStringIncludes(src, 'scheduledStatus === "admin_held"');
  assertStringIncludes(src, 'scheduledStatus === "driver_assigned"');
});

Deno.test("create-ride scheduled booking push deep-links to /account/rides", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/create-ride/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "SCHEDULED_BOOKING_CONFIRMED");
  assertStringIncludes(src, 'path: "/account/rides"');
  assertStringIncludes(src, 'screen: "/account/rides"');
});
