/**
 * Lock: marketplace publication must never start the NRO response-window countdown.
 * Scenarios A–C (isolated, simulated clocks).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildMakeAvailableScheduledJobsPatch } from "./scheduledAdminReleaseSSOT.ts";
import {
  resolveScheduledDispatchConfig,
  shouldConvertScheduledToUrgent,
} from "./scheduledDispatchConfig.ts";

const cfg = resolveScheduledDispatchConfig({
  scheduled_response_window_minutes: 4,
  urgent_dispatch_trigger_minutes_before_pickup: 9,
  enable_scheduled_to_urgent_conversion: true,
});

Deno.test("Scenario A: publish immediately 12h before pickup — no convert after 4m", () => {
  const publishAt = "2026-11-12T18:40:47.972Z";
  const patch = buildMakeAvailableScheduledJobsPatch({ nowIso: publishAt });
  assertEquals(patch.scheduled_broadcast_at, publishAt);
  assertEquals(
    Object.prototype.hasOwnProperty.call(patch, "broadcast_started_at"),
    false,
  );

  const trip = {
    id: "a",
    scheduled_at: "2026-11-13T07:00:00.000Z",
    scheduled_broadcast_at: publishAt,
    scheduled_convert_at: "2026-11-13T06:51:00.000Z",
    broadcast_started_at: null as string | null,
    driver_id: null,
  };
  const after4m = shouldConvertScheduledToUrgent({
    trip,
    config: cfg,
    nowMs: Date.parse("2026-11-12T18:45:00.000Z"),
    hasAcceptedOffer: false,
  });
  assertEquals(after4m.convert, false);
});

Deno.test("Scenario B: response window starts only after legitimate fallback/NRO", () => {
  const trip = {
    id: "b",
    scheduled_at: "2026-11-13T07:00:00.000Z",
    scheduled_broadcast_at: "2026-11-12T18:40:47.972Z",
    scheduled_convert_at: "2026-11-13T06:51:00.000Z",
    broadcast_started_at: "2026-11-13T06:40:00.000Z",
    driver_id: null,
  };
  const beforeWindow = shouldConvertScheduledToUrgent({
    trip,
    config: cfg,
    nowMs: Date.parse("2026-11-13T06:42:00.000Z"),
    firstOfferAnchor: { offered_at: "2026-11-13T06:40:00.000Z" },
    hasAcceptedOffer: false,
  });
  assertEquals(beforeWindow.convert, false);

  const afterWindow = shouldConvertScheduledToUrgent({
    trip,
    config: cfg,
    nowMs: Date.parse("2026-11-13T06:44:00.000Z"),
    firstOfferAnchor: { offered_at: "2026-11-13T06:40:00.000Z" },
    hasAcceptedOffer: false,
  });
  assertEquals(afterWindow.convert, true);
  assertEquals(afterWindow.reason, "response_window_no_accept");
});

Deno.test("Scenario C: urgent convert at scheduled_convert_at / T−urgent with no accept", () => {
  const trip = {
    id: "c",
    scheduled_at: "2026-11-13T07:00:00.000Z",
    scheduled_broadcast_at: "2026-11-12T18:40:47.972Z",
    scheduled_convert_at: "2026-11-13T06:51:00.000Z",
    broadcast_started_at: null as string | null,
    driver_id: null,
  };
  const atUrgent = shouldConvertScheduledToUrgent({
    trip,
    config: cfg,
    nowMs: Date.parse("2026-11-13T06:51:00.000Z"),
    hasAcceptedOffer: false,
  });
  assertEquals(atUrgent.convert, true);
  assertEquals(atUrgent.reason, "urgent_pickup_window");
});
