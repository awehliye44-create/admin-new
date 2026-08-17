/**
 * MK-260817-006 scheduled handover lock — instant TTL + hold-release exclusion.
 *
 * Run: deno test --allow-read supabase/functions/_shared/scheduledHandoverHoldLock.test.ts
 */
import {
  assertEquals,
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isScheduledHandoverOpenJobStatus,
  isScheduledInstantConversionPending,
  shouldBlockPrematureScheduledSearchHoldRelease,
} from "./scheduledHandoverHoldLock.ts";
import {
  isCustomerSearchWindowActive,
  resolveCustomerSearchDeadlineMs,
  shouldExpireTripAfterWavesExhausted,
} from "./dispatchSearchWindow.ts";
import { classifyTerminalHoldDisposition } from "./terminalTripPaymentDisposition.ts";
import {
  buildScheduledUrgentConversionPatch,
  resolveScheduledDispatchConfig,
  shouldConvertScheduledToUrgent,
} from "./scheduledDispatchConfig.ts";

const SETTINGS = { max_driver_find_time_minutes: 6 };

const MK006 = {
  created_at: "2026-08-17T11:55:53.134Z",
  dispatch_mode: "scheduled",
  scheduled_status: "broadcasting",
  searching_expires_at: null as string | null,
};

Deno.test("MK-260817-006: Admin 8m/15m convert; broadcast must not convert or expire", () => {
  const cfg = resolveScheduledDispatchConfig({
    enable_scheduled_to_urgent_conversion: true,
    scheduled_response_window_minutes: 8,
    urgent_dispatch_trigger_minutes_before_pickup: 15,
    max_driver_find_time_minutes: 6,
  });
  assertEquals(cfg.responseWindowMinutes, 8);
  assertEquals(cfg.urgentTriggerMinutesBeforePickup, 15);
  assertEquals(cfg.maxFindDriverMinutes, 6);
  assertEquals(cfg.enableScheduledToUrgentConversion, true);

  const trip = {
    id: "82cbd6a4-d933-43d3-811c-92296436c99d",
    created_at: MK006.created_at,
    scheduled_at: "2026-08-17T12:25:00.000Z",
    scheduled_broadcast_at: "2026-08-17T12:02:00.000Z",
    scheduled_convert_at: "2026-08-17T12:10:00.000Z",
    driver_id: null as string | null,
    confirmed_driver_id: null as string | null,
    dispatch_mode: "scheduled",
    scheduled_status: "broadcasting",
    searching_expires_at: null as string | null,
  };

  const atBroadcast = Date.parse("2026-08-17T12:02:02.000Z");
  assertEquals(
    shouldConvertScheduledToUrgent({
      trip,
      config: cfg,
      nowMs: atBroadcast,
      hasAcceptedOffer: false,
    }).convert,
    false,
  );
  assertEquals(isScheduledInstantConversionPending(trip), true);
  assertEquals(isCustomerSearchWindowActive(trip, SETTINGS, atBroadcast), true);
  assertEquals(
    resolveCustomerSearchDeadlineMs(
      { ...trip, searching_expires_at: "2026-08-17T12:01:53.000Z" },
      SETTINGS,
      atBroadcast,
    ),
    null,
  );
  assertEquals(shouldExpireTripAfterWavesExhausted(trip, SETTINGS, atBroadcast), false);
  assertEquals(
    shouldBlockPrematureScheduledSearchHoldRelease({
      tripStatus: "expired",
      cancelledBy: null,
      cancellationReason: null,
      dispatchMode: "scheduled",
      scheduledStatus: "broadcasting",
      isScheduled: true,
      scheduledAt: trip.scheduled_at,
      dispositionReason: "search_expired",
      feePence: 0,
    }),
    true,
  );
  assertEquals(
    shouldBlockPrematureScheduledSearchHoldRelease({
      tripStatus: "offered",
      cancelledBy: null,
      cancellationReason: null,
      dispatchMode: "scheduled",
      scheduledStatus: "broadcasting",
      isScheduled: true,
      scheduledAt: trip.scheduled_at,
      dispositionReason: "no_driver_search_exhausted",
      feePence: 0,
    }),
    true,
  );
  const atConvert = Date.parse("2026-08-17T12:10:00.000Z");
  const decision = shouldConvertScheduledToUrgent({
    trip,
    config: cfg,
    nowMs: atConvert,
    hasAcceptedOffer: false,
  });
  assertEquals(decision.convert, true);
  const ttl = new Date(atConvert + cfg.maxFindDriverMinutes * 60_000).toISOString();
  assertEquals(ttl, "2026-08-17T12:16:00.000Z");
});

Deno.test("A: scheduled booking 30 min before pickup does not expire after created_at + 6 min", () => {
  const created = Date.parse(MK006.created_at);
  const sixMinLater = created + 6 * 60_000;
  assertEquals(
    resolveCustomerSearchDeadlineMs(MK006, SETTINGS, sixMinLater + 1_000),
    null,
  );
  assertEquals(
    isCustomerSearchWindowActive(MK006, SETTINGS, sixMinLater + 1_000),
    true,
  );
  assertEquals(
    shouldExpireTripAfterWavesExhausted(MK006, SETTINGS, sixMinLater + 1_000),
    false,
  );
});

Deno.test("B: scheduled broadcast before conversion is not SEARCH_WINDOW_ENDED", () => {
  const broadcastMs = Date.parse("2026-08-17T12:02:02.000Z");
  assert(isScheduledInstantConversionPending(MK006));
  assertEquals(isCustomerSearchWindowActive(MK006, SETTINGS, broadcastMs), true);
  assertEquals(shouldExpireTripAfterWavesExhausted(MK006, SETTINGS, broadcastMs), false);
});

Deno.test("C: no scheduled accept — conversion pending until converted_to_instant", () => {
  assertEquals(
    isScheduledInstantConversionPending({
      dispatch_mode: "scheduled",
      scheduled_status: "scheduled",
    }),
    true,
  );
  assertEquals(
    isScheduledInstantConversionPending({
      dispatch_mode: "scheduled",
      scheduled_status: "broadcasting",
    }),
    true,
  );
  assertEquals(
    isScheduledInstantConversionPending({
      dispatch_mode: "instant",
      scheduled_status: "converted_to_instant",
    }),
    false,
  );
  assertEquals(
    isScheduledInstantConversionPending({
      is_scheduled: true,
      scheduled_at: MK006.created_at,
    }),
    true,
  );
});

Deno.test("C2: fare-offer negotiating stays an open scheduled job", () => {
  assertEquals(isScheduledHandoverOpenJobStatus("negotiating"), true);
  assertEquals(isScheduledHandoverOpenJobStatus("dispatching"), true);
  assertEquals(isScheduledHandoverOpenJobStatus("en_route_to_pickup"), false);
});

Deno.test("D: conversion stamps searching_expires_at from instant-search start, not created_at", () => {
  const convertAt = "2026-08-17T12:10:00.000Z";
  const ttl = new Date(Date.parse(convertAt) + 6 * 60_000).toISOString();
  const patch = buildScheduledUrgentConversionPatch({
    nowIso: convertAt,
    searchingExpiresAtIso: ttl,
  });
  assertEquals(patch.dispatch_mode, "instant");
  assertEquals(patch.scheduled_status, "converted_to_instant");
  assertEquals(patch.status, "searching");
  assertEquals(patch.searching_expires_at, "2026-08-17T12:16:00.000Z");
  assertEquals(patch.current_broadcast_round, 0);
  assertEquals(patch.searching_expires_at === MK006.created_at, false);

  const converted = {
    created_at: MK006.created_at,
    dispatch_mode: patch.dispatch_mode,
    scheduled_status: patch.scheduled_status,
    searching_expires_at: patch.searching_expires_at,
  };
  const convertMs = Date.parse(convertAt);
  assertEquals(
    resolveCustomerSearchDeadlineMs(converted, SETTINGS, convertMs),
    Date.parse(ttl),
  );
  assertEquals(isCustomerSearchWindowActive(converted, SETTINGS, convertMs), true);
  assertEquals(
    isCustomerSearchWindowActive(converted, SETTINGS, Date.parse(ttl) + 1),
    false,
  );
});

Deno.test("D2: converted job missing stamp does not use booking created_at TTL", () => {
  const afterCreatedTtl = Date.parse(MK006.created_at) + 6 * 60_000 + 1_000;
  const convertedMissingStamp = {
    created_at: MK006.created_at,
    dispatch_mode: "instant" as const,
    scheduled_status: "converted_to_instant",
    is_scheduled: true,
    searching_expires_at: null as string | null,
  };
  const deadline = resolveCustomerSearchDeadlineMs(
    convertedMissingStamp,
    SETTINGS,
    afterCreatedTtl,
  );
  assert(deadline != null && deadline > afterCreatedTtl);
  assertEquals(
    isCustomerSearchWindowActive(convertedMissingStamp, SETTINGS, afterCreatedTtl),
    true,
  );
});

Deno.test("E/F: premature scheduled no-driver expiry must not classify hold release", () => {
  const blocked = shouldBlockPrematureScheduledSearchHoldRelease({
    tripStatus: "expired",
    cancelledBy: null,
    cancellationReason: null,
    dispatchMode: "scheduled",
    scheduledStatus: "no_driver_found",
    isScheduled: true,
    scheduledAt: "2026-08-17T12:25:00.000Z",
    dispositionReason: "search_expired",
    feePence: 0,
  });
  assertEquals(blocked, true);

  const classified = classifyTerminalHoldDisposition({
    tripStatus: "expired",
    startedAt: null,
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
    cancelledBy: null,
    cancellationReason: null,
    dispatchMode: "scheduled",
    scheduledStatus: "broadcasting",
    isScheduled: true,
    scheduledAt: "2026-08-17T12:25:00.000Z",
    dispositionReason: "search_expired",
  });
  assertEquals(classified.action, "skip");
  assertEquals(classified.outcome, "SKIPPED_SCHEDULED_HANDOVER_PENDING");
});

Deno.test("E: do not infer customer cancel from expired / payment cancelled", () => {
  assertEquals(
    shouldBlockPrematureScheduledSearchHoldRelease({
      tripStatus: "expired",
      cancelledBy: null,
      cancellationReason: null,
      dispatchMode: "scheduled",
      scheduledStatus: "no_driver_found",
      isScheduled: true,
      dispositionReason: "search_expired",
    }),
    true,
  );
});

Deno.test("G: customer explicit cancel still voids hold", () => {
  assertEquals(
    shouldBlockPrematureScheduledSearchHoldRelease({
      tripStatus: "cancelled",
      cancelledBy: "customer",
      cancellationReason: "customer_cancelled",
      dispatchMode: "scheduled",
      scheduledStatus: "scheduled",
      isScheduled: true,
      dispositionReason: "customer_cancel",
      feePence: 0,
    }),
    false,
  );
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "cancelled",
      feePence: 0,
      hasProviderOrder: true,
      provider: "revolut",
      cancelledBy: "customer",
      dispositionReason: "customer_cancel",
      dispatchMode: "scheduled",
      scheduledStatus: "scheduled",
      isScheduled: true,
    }).action,
    "void_full",
  );
});

Deno.test("H: admin explicit cancel still voids hold", () => {
  assertEquals(
    shouldBlockPrematureScheduledSearchHoldRelease({
      tripStatus: "cancelled",
      cancelledBy: "admin",
      dispatchMode: "scheduled",
      scheduledStatus: "scheduled",
      isScheduled: true,
      dispositionReason: "admin_cancel",
      feePence: 0,
    }),
    false,
  );
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "cancelled",
      feePence: 0,
      hasProviderOrder: true,
      provider: "revolut",
      cancelledBy: "admin",
      dispositionReason: "admin_cancel",
      dispatchMode: "scheduled",
      isScheduled: true,
    }).action,
    "void_full",
  );
});

Deno.test("I: no-show / fee cancellation policy unchanged", () => {
  assertEquals(
    shouldBlockPrematureScheduledSearchHoldRelease({
      tripStatus: "no_show",
      cancelledBy: null,
      dispatchMode: "scheduled",
      scheduledStatus: "scheduled",
      isScheduled: true,
      feePence: 800,
    }),
    false,
  );
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "no_show",
      feePence: 800,
      hasProviderOrder: true,
      provider: "revolut",
      dispatchMode: "scheduled",
      isScheduled: true,
    }).action,
    "partial_capture_fee",
  );
});

Deno.test("J: converted instant search exhaustion allows terminal release", () => {
  assertEquals(
    shouldBlockPrematureScheduledSearchHoldRelease({
      tripStatus: "expired",
      cancelledBy: null,
      dispatchMode: "instant",
      scheduledStatus: "converted_to_instant",
      isScheduled: true,
      dispositionReason: "search_expired",
      feePence: 0,
    }),
    false,
  );
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "expired",
      feePence: 0,
      hasProviderOrder: true,
      provider: "revolut",
      dispatchMode: "instant",
      scheduledStatus: "converted_to_instant",
      isScheduled: true,
      dispositionReason: "search_expired",
    }).action,
    "void_full",
  );
});

Deno.test("K/L: conversion patch keeps same-trip instant fields; no second trip/order invented", () => {
  const patch = buildScheduledUrgentConversionPatch({
    nowIso: "2026-08-17T12:10:00.000Z",
    searchingExpiresAtIso: "2026-08-17T12:16:00.000Z",
  });
  assertEquals("id" in patch, false);
  assertEquals("payment_session_id" in patch, false);
  assertEquals("provider_order_id" in patch, false);
  assertEquals(patch.current_broadcast_round, 0);
  assertEquals(patch.dispatch_mode, "instant");
  assertEquals(patch.scheduled_status, "converted_to_instant");
});

Deno.test("source lock: auto-dispatch skips expire while scheduled handover pending", async () => {
  const src = await Deno.readTextFile(
    new URL("../auto-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "isScheduledInstantConversionPending");
  assertStringIncludes(src, "SCHEDULED_HANDOVER_PENDING");
  assert(
    src.indexOf("isScheduledInstantConversionPending(trip)") <
      src.indexOf('rpc("expire_trip_when_search_exhausted"'),
  );
});

Deno.test("source lock: scheduled-dispatch Step 4 only expires converted_to_instant", async () => {
  const src = await Deno.readTextFile(
    new URL("../scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, '.eq("scheduled_status", "converted_to_instant")');
  assertEquals(src.includes('.in("scheduled_status", ["broadcasting", "dispatching", "converted_to_instant"])'), false);
  assertStringIncludes(src, "buildScheduledUrgentConversionPatch");
  assertStringIncludes(src, "NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES");
  assertStringIncludes(src, "searchingExpiresAtIso: searchingExpiresAt");
  assertStringIncludes(
    src,
    "new Date(nowMs + maxFindDriverMinutes * 60_000).toISOString()",
  );
  assertStringIncludes(src, "triggerReason: `scheduled_convert_to_instant:");
});

Deno.test("source lock: schedule-dispatch converts via Admin SSOT then auto-dispatch", async () => {
  const src = await Deno.readTextFile(
    new URL("../schedule-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "shouldConvertScheduledToUrgent");
  assertStringIncludes(src, "buildScheduledUrgentConversionPatch");
  assertStringIncludes(src, "NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES");
  assertStringIncludes(src, "/functions/v1/auto-dispatch");
  assertEquals(src.includes("dispatch_trip_offers"), false);
});

Deno.test("source lock: later expire replacements keep scheduled handover pending", async () => {
  const later = await Deno.readTextFile(
    new URL(
      "../../migrations/20260916120000_retire_scan_go_dispatch_hotfix.sql",
      import.meta.url,
    ),
  );
  const lock = await Deno.readTextFile(
    new URL(
      "../../migrations/20260921140000_scheduled_handover_expire_ttl_lock.sql",
      import.meta.url,
    ),
  );
  const jsMatch = await Deno.readTextFile(
    new URL(
      "../../migrations/20260921142000_scheduled_handover_pending_matches_js.sql",
      import.meta.url,
    ),
  );
  const rematch = await Deno.readTextFile(
    new URL(
      "../../migrations/20260921143000_scheduled_handover_pending_ignores_rematch_actor.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(later, "v_scheduled_handover_pending");
  assert(
    later.indexOf("IF v_scheduled_handover_pending THEN") <
      later.indexOf("v_trip.created_at + make_interval"),
  );
  assertStringIncludes(lock, "v_scheduled_handover_pending");
  assertStringIncludes(lock, "trg_scheduled_handover_block_premature_search_ttl");
  assert(
    lock.indexOf("IF v_scheduled_handover_pending THEN") <
      lock.indexOf("IF v_trip.searching_expires_at IS NOT NULL THEN"),
  );
  assertStringIncludes(jsMatch, "is_scheduled_instant_conversion_pending");
  assertStringIncludes(jsMatch, "p_is_scheduled boolean");
  assertStringIncludes(jsMatch, "p_scheduled_at timestamptz");
  assert(
    jsMatch.indexOf("public.is_scheduled_instant_conversion_pending(") <
      jsMatch.indexOf("IF v_scheduled_handover_pending THEN"),
  );
  assertStringIncludes(rematch, "searching_new_driver rematch");
  assertEquals(
    rematch.includes("AND COALESCE(NULLIF(trim(COALESCE(v_trip.cancelled_by, '')), ''), '') = ''"),
    false,
  );
  assertEquals(
    rematch.includes("AND COALESCE(NULLIF(trim(COALESCE(NEW.cancelled_by, '')), ''), '') = ''"),
    false,
  );
  const rematchStatus = await Deno.readTextFile(
    new URL(
      "../../migrations/20260921143100_scheduled_handover_pending_keeps_driver_cancelled_rematch.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(rematchStatus, "status=driver_cancelled");
  assertEquals(
    rematchStatus.includes("'driver_cancelled', 'no_show'"),
    false,
  );
  assertStringIncludes(
    rematchStatus,
    "'cancelled', 'canceled', 'customer_cancelled', 'no_show'",
  );
});

Deno.test("source lock: dispatch_trip_offers skips created_at TTL during scheduled handover", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260921130000_dispatch_gap_close.sql",
      import.meta.url,
    ),
  );
  const later = await Deno.readTextFile(
    new URL(
      "../../migrations/20260921141000_dispatch_trip_offers_scheduled_handover_skip.sql",
      import.meta.url,
    ),
  );
  const jsMatch = await Deno.readTextFile(
    new URL(
      "../../migrations/20260921142100_dispatch_trip_offers_pending_matches_js.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "scheduled_handover_pending");
  assert(
    sql.indexOf("reason', 'scheduled_handover_pending'") <
      sql.indexOf("v_trip.created_at + make_interval"),
  );
  assertStringIncludes(later, "scheduled_handover_pending");
  assertStringIncludes(jsMatch, "is_scheduled_instant_conversion_pending");
  assertEquals(
    jsMatch.split("public.is_scheduled_instant_conversion_pending(").length - 1,
    3,
  );
});

Deno.test("source lock: expire-trip / expire-offers / holdRelease skip scheduled handover", async () => {
  const expireTrip = await Deno.readTextFile(
    new URL("../expire-trip/index.ts", import.meta.url),
  );
  const expireOffers = await Deno.readTextFile(
    new URL("../expire-offers/index.ts", import.meta.url),
  );
  const holdRelease = await Deno.readTextFile(
    new URL("./holdReleaseSSOT.ts", import.meta.url),
  );
  assertStringIncludes(expireTrip, "isScheduledInstantConversionPending");
  assertStringIncludes(expireOffers, "isScheduledInstantConversionPending");
  assertStringIncludes(expireOffers, "isScheduledWorkflowOrigin");
  assertStringIncludes(holdRelease, "shouldBlockPrematureScheduledSearchHoldRelease");
  const driverCancel = await Deno.readTextFile(
    new URL("../driver-cancel-before-pickup/index.ts", import.meta.url),
  );
  assertStringIncludes(driverCancel, "isScheduledInstantConversionPending");
  assertStringIncludes(driverCancel, "handoverPending");
  const customerResume = await Deno.readTextFile(
    new URL("../customer-resume-driver-search/index.ts", import.meta.url),
  );
  assertStringIncludes(customerResume, "isScheduledInstantConversionPending");
  assertStringIncludes(customerResume, "handoverPending");
  assertStringIncludes(customerResume, "isScheduledWorkflowOrigin(trip)");
  const scheduledRideAction = await Deno.readTextFile(
    new URL("../scheduled-ride-action/index.ts", import.meta.url),
  );
  assertStringIncludes(scheduledRideAction, "buildScheduledUrgentConversionPatch");
  assertStringIncludes(scheduledRideAction, "searchingExpiresAtIso");
  assertEquals(scheduledRideAction.includes("is_scheduled: false"), false);
});

Deno.test("source lock: SQL expire does not use created_at TTL for scheduled handover", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260817152000_scheduled_handover_search_ttl_hold_lock.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "v_scheduled_handover_pending");
  assertStringIncludes(sql, "converted_to_instant");
  assertStringIncludes(sql, "premature scheduled system expiry must not void the hold");
  assertStringIncludes(sql, "trg_trips_terminal_payment_disposition");
});

Deno.test("source lock: restore / get-active-trip ignore stale TTL during scheduled handover", async () => {
  const restore = await Deno.readTextFile(
    new URL("./activeTripRestoreCore.ts", import.meta.url),
  );
  const getActive = await Deno.readTextFile(
    new URL("../get-active-trip/index.ts", import.meta.url),
  );
  assertStringIncludes(restore, "isScheduledHandoverOpenJobStatus");
  assertStringIncludes(restore, "isScheduledWorkflowOrigin(row)");
  assert(
    restore.indexOf("SEARCHING_STATUSES.has(status) && !isScheduledInstantConversionPending(row)") >
      0,
  );
  assertStringIncludes(getActive, "isScheduledInstantConversionPending(row)");
  assertStringIncludes(getActive, "isScheduledHandoverOpenJobStatus");
  assertStringIncludes(getActive, "isScheduledWorkflowOrigin(row)");
  assertStringIncludes(getActive, "converted_to_instant");
  assertStringIncludes(getActive, "SEARCH_WINDOW_STILL_ACTIVE_KEEP_LIVE");
  assert(
    getActive.split("if (isScheduledWorkflowOrigin(row)) return false;").length - 1 >= 2,
  );
  assert(
    restore.indexOf(
      "isScheduledInstantConversionPending(row) &&",
    ) > 0,
  );
  assertStringIncludes(restore, ".limit(10)");
  assertStringIncludes(restore, "isCustomerRestoreCandidate(candidate, nowMs)");
  assertStringIncludes(getActive, "isCustomerLiveTrip(candidate as TripRow, nowMs)");
});

Deno.test("source lock: dispose selects scheduled lifecycle fields, not payment_status as cancel actor", async () => {
  const src = await Deno.readTextFile(
    new URL("./terminalTripPaymentDisposition.ts", import.meta.url),
  );
  assertStringIncludes(src, "shouldBlockPrematureScheduledSearchHoldRelease");
  assertStringIncludes(src, "dispatch_mode, scheduled_status, is_scheduled");
  assertStringIncludes(src, "SKIPPED_SCHEDULED_HANDOVER_PENDING");
});
