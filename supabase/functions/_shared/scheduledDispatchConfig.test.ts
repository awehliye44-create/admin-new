/**
 * Unit tests for Admin Scheduled Rides Dispatch anchors
 * (response window + urgent fallback from Auto-Dispatch Rules).
 */
import {
  computeScheduledDispatchAnchors,
  isOpenJobInstantRideOffer,
  isNoPreconfirmedConvertScheduledStatus,
  buildScheduledUrgentConversionPatch,
  nextAutoDispatchTripStatus,
  resolveScheduledDispatchConfig,
  shouldConvertScheduledToUrgent,
} from "./scheduledDispatchConfig.ts";

Deno.test("resolveScheduledDispatchConfig reads Admin screenshot values", () => {
  const cfg = resolveScheduledDispatchConfig({
    scheduled_response_window_minutes: 8,
    urgent_dispatch_trigger_minutes_before_pickup: 15,
    enable_scheduled_to_urgent_conversion: true,
    locked_driver_response_minutes: 2,
    scheduled_urgent_card_label: "Scheduled • Urgent",
  });
  if (cfg.responseWindowMinutes !== 8) {
    throw new Error(`expected response 8, got ${cfg.responseWindowMinutes}`);
  }
  if (cfg.urgentTriggerMinutesBeforePickup !== 15) {
    throw new Error(`expected urgent 15, got ${cfg.urgentTriggerMinutesBeforePickup}`);
  }
  if (cfg.lockedDriverResponseMinutes !== 2) {
    throw new Error(`expected locked response 2, got ${cfg.lockedDriverResponseMinutes}`);
  }
  if (cfg.scheduledUrgentCardLabel !== "Scheduled • Urgent") {
    throw new Error(`unexpected label ${cfg.scheduledUrgentCardLabel}`);
  }
});

Deno.test("computeScheduledDispatchAnchors: far-ahead booking opens before urgent fallback", () => {
  const pickup = Date.parse("2026-08-16T12:00:00.000Z");
  const nowMs = Date.parse("2026-08-16T08:00:00.000Z"); // 4h before
  const anchors = computeScheduledDispatchAnchors({
    scheduledAtIso: new Date(pickup).toISOString(),
    nowMs,
    urgentTriggerMinutesBeforePickup: 15,
    responseWindowMinutes: 8,
  });
  // Urgent at 11:45; broadcast opens at 11:45 - 8m = 11:37
  if (anchors.scheduledConvertAt !== "2026-08-16T11:45:00.000Z") {
    throw new Error(`convert ${anchors.scheduledConvertAt}`);
  }
  if (anchors.scheduledBroadcastAt !== "2026-08-16T11:37:00.000Z") {
    throw new Error(`broadcast ${anchors.scheduledBroadcastAt}`);
  }
});

Deno.test("computeScheduledDispatchAnchors: near booking never stamps past broadcast_at", () => {
  // MK-260815-030 class: book ~23m before pickup with urgent=15 / response=8
  const pickup = Date.parse("2026-08-15T23:30:00.000Z");
  const nowMs = Date.parse("2026-08-15T23:07:00.000Z");
  const anchors = computeScheduledDispatchAnchors({
    scheduledAtIso: new Date(pickup).toISOString(),
    nowMs,
    urgentTriggerMinutesBeforePickup: 15,
    responseWindowMinutes: 8,
  });
  if (anchors.scheduledBroadcastAt !== new Date(nowMs).toISOString()) {
    throw new Error(`expected broadcast=now, got ${anchors.scheduledBroadcastAt}`);
  }
  if (anchors.scheduledConvertAt !== "2026-08-15T23:15:00.000Z") {
    throw new Error(`convert ${anchors.scheduledConvertAt}`);
  }
  // Response window from now still yields a full 8 minutes before urgent
  const responseDeadline = nowMs + 8 * 60_000;
  if (responseDeadline !== Date.parse("2026-08-15T23:15:00.000Z")) {
    throw new Error("response window should meet urgent fallback at 23:15");
  }
});

Deno.test("shouldConvertScheduledToUrgent respects Admin 8m response + 15m urgent", () => {
  const cfg = resolveScheduledDispatchConfig({
    scheduled_response_window_minutes: 8,
    urgent_dispatch_trigger_minutes_before_pickup: 15,
    enable_scheduled_to_urgent_conversion: true,
  });
  const trip = {
    id: "t1",
    scheduled_at: "2026-08-15T23:30:00.000Z",
    scheduled_broadcast_at: "2026-08-15T23:07:00.000Z",
    scheduled_convert_at: "2026-08-15T23:15:00.000Z",
    driver_id: null,
  };
  const before = shouldConvertScheduledToUrgent({
    trip,
    config: cfg,
    nowMs: Date.parse("2026-08-15T23:10:00.000Z"),
    hasAcceptedOffer: false,
  });
  if (before.convert) throw new Error("should still be in Scheduled Jobs window at +3m");

  const afterResponse = shouldConvertScheduledToUrgent({
    trip,
    config: cfg,
    nowMs: Date.parse("2026-08-15T23:15:00.000Z"),
    hasAcceptedOffer: false,
  });
  if (!afterResponse.convert) throw new Error("should convert at response/urgent boundary");
});

Deno.test("Two paths: confirmed driver never uses fixed urgent convert", () => {
  const cfg = resolveScheduledDispatchConfig({
    scheduled_response_window_minutes: 8,
    urgent_dispatch_trigger_minutes_before_pickup: 15,
    enable_scheduled_to_urgent_conversion: true,
  });
  // Past urgent window — would convert if unconfirmed
  const pastUrgent = Date.parse("2026-08-15T23:20:00.000Z");
  const confirmed = shouldConvertScheduledToUrgent({
    trip: {
      id: "t-confirmed",
      scheduled_at: "2026-08-15T23:30:00.000Z",
      scheduled_broadcast_at: "2026-08-15T23:07:00.000Z",
      scheduled_convert_at: "2026-08-15T23:15:00.000Z",
      driver_id: null,
      confirmed_driver_id: "drv-locked",
    },
    config: cfg,
    nowMs: pastUrgent,
    hasAcceptedOffer: false,
  });
  if (confirmed.convert) {
    throw new Error("confirmed driver must stay on Commitment Policy (not fixed urgent)");
  }

  const unconfirmed = shouldConvertScheduledToUrgent({
    trip: {
      id: "t-open",
      scheduled_at: "2026-08-15T23:30:00.000Z",
      scheduled_broadcast_at: "2026-08-15T23:07:00.000Z",
      scheduled_convert_at: "2026-08-15T23:15:00.000Z",
      driver_id: null,
      confirmed_driver_id: null,
    },
    config: cfg,
    nowMs: pastUrgent,
    hasAcceptedOffer: false,
  });
  if (!unconfirmed.convert) {
    throw new Error("no-preconfirmed path must convert past urgent fallback");
  }
});

Deno.test("MK-260817-004: customer scheduled_status converts at check-in / urgent", () => {
  const cfg = resolveScheduledDispatchConfig({
    scheduled_response_window_minutes: 8,
    urgent_dispatch_trigger_minutes_before_pickup: 15,
    enable_scheduled_to_urgent_conversion: true,
  });
  const trip = {
    id: "mk-260817-004",
    scheduled_at: "2026-08-17T08:20:00.000Z",
    scheduled_broadcast_at: "2026-08-17T07:57:00.000Z",
    scheduled_convert_at: "2026-08-17T08:05:00.000Z",
    driver_id: null,
    confirmed_driver_id: null,
  };
  const atCheckIn = shouldConvertScheduledToUrgent({
    trip,
    config: cfg,
    nowMs: Date.parse("2026-08-17T08:05:00.000Z"),
    hasAcceptedOffer: false,
  });
  if (!atCheckIn.convert) {
    throw new Error("no-accept job must convert when check-in / urgent fallback is reached");
  }

  const staleAccepted = shouldConvertScheduledToUrgent({
    trip,
    config: cfg,
    nowMs: Date.parse("2026-08-17T08:05:00.000Z"),
    hasAcceptedOffer: true,
  });
  if (!staleAccepted.convert) {
    throw new Error("stale accepted offer with no driver_id must not block convert");
  }

  if (!isNoPreconfirmedConvertScheduledStatus("scheduled")) {
    throw new Error("customer scheduled_status=scheduled must be a convert candidate");
  }

  const patch = buildScheduledUrgentConversionPatch({
    nowIso: "2026-08-17T08:05:00.000Z",
    searchingExpiresAtIso: "2026-08-17T08:08:00.000Z",
  });
  if (patch.dispatch_mode !== "instant") throw new Error("convert must set dispatch_mode instant");
  if (patch.scheduled_status !== "converted_to_instant") {
    throw new Error("convert must set scheduled_status converted_to_instant");
  }
  if (patch.status !== "searching") throw new Error("convert must set status searching");
  if (patch.current_broadcast_round !== 0) {
    throw new Error("convert must reset current_broadcast_round so instant waves start at 1");
  }

  const overdue = shouldConvertScheduledToUrgent({
    trip,
    config: cfg,
    nowMs: Date.parse("2026-08-17T08:50:00.000Z"),
    hasAcceptedOffer: false,
  });
  if (!overdue.convert) {
    throw new Error("past-pickup no-accept job must still convert, not be left scheduled");
  }
});

Deno.test("MK-260817 open-job broadcasting is an instant ride offer", () => {
  const broadcasting = isOpenJobInstantRideOffer({
    dispatch_mode: "scheduled",
    scheduled_status: "broadcasting",
    status: "searching",
  });
  if (!broadcasting) throw new Error("heatmap searching scheduled job must be instant offer");

  const offered = isOpenJobInstantRideOffer({
    dispatch_mode: "scheduled",
    scheduled_status: "broadcasting",
    status: "offered",
  });
  if (!offered) throw new Error("broadcast offered scheduled job must be instant offer");

  const converted = isOpenJobInstantRideOffer({
    dispatch_mode: "instant",
    scheduled_status: "converted_to_instant",
    status: "searching",
  });
  if (!converted) throw new Error("converted_to_instant must be instant offer");

  const preBroadcast = isOpenJobInstantRideOffer({
    dispatch_mode: "scheduled",
    scheduled_status: "scheduled",
    status: "scheduled",
  });
  if (preBroadcast) throw new Error("pre-broadcast scheduled must stay Scheduled Jobs");
});

Deno.test("auto-dispatch does not stomp scheduled marketplace to searching", () => {
  const kept = nextAutoDispatchTripStatus({
    status: "offered",
    dispatch_mode: "scheduled",
    scheduled_status: "broadcasting",
  });
  if (kept !== "offered") throw new Error(`expected offered, got ${kept}`);

  const unstomp = nextAutoDispatchTripStatus({
    status: "searching",
    dispatch_mode: "scheduled",
    scheduled_status: "broadcasting",
  });
  if (unstomp !== "offered") throw new Error(`expected offered unstomp, got ${unstomp}`);

  const instant = nextAutoDispatchTripStatus({
    status: "offered",
    dispatch_mode: "instant",
    scheduled_status: "converted_to_instant",
  });
  if (instant !== "searching") throw new Error(`expected searching after convert, got ${instant}`);
});
