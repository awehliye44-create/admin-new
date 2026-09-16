/**
 * MK-260916-038 RC4: scheduled dispatch anchors persist on the canonical booking write path.
 *
 * Run: deno test --allow-read --allow-env supabase/tests/_shared/scheduledDispatchAnchorPersist.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildMinimalTripInsertRow,
  type BookingCommitBody,
} from "../../functions/_shared/bookingSSOT.ts";
import {
  computeScheduledDispatchAnchors,
  resolveScheduledDispatchConfig,
} from "../../functions/_shared/scheduledDispatchConfig.ts";

const ANCHOR_MIGRATION = new URL(
  "../../migrations/20261116231000_scheduled_dispatch_anchor_persist.sql",
  import.meta.url,
);
const BOOKING_SSOT = new URL(
  "../../functions/_shared/bookingSSOT.ts",
  import.meta.url,
);
const CTAP = new URL(
  "../../functions/create-trip-after-payment/index.ts",
  import.meta.url,
);

const cfg = resolveScheduledDispatchConfig({
  scheduled_response_window_minutes: 8,
  urgent_dispatch_trigger_minutes_before_pickup: 15,
});

function scheduledBody(scheduledAt: string): BookingCommitBody {
  return {
    client_action_id: "phase2-scheduled-anchor",
    pickup: { address: "Pickup", lat: 52.04, lng: -0.76 },
    dropoff: { address: "Dropoff", lat: 52.05, lng: -0.75 },
    when: "SCHEDULED",
    scheduled_at: scheduledAt,
    estimated_fare: 12.5,
    payment_method: "card",
  };
}

function nowBody(): BookingCommitBody {
  return {
    client_action_id: "phase2-now-anchor",
    pickup: { address: "Pickup", lat: 52.04, lng: -0.76 },
    dropoff: { address: "Dropoff", lat: 52.05, lng: -0.75 },
    when: "NOW",
    estimated_fare: 12.5,
    payment_method: "card",
  };
}

const baseInput = {
  customerId: "11111111-1111-1111-1111-111111111111",
  serviceAreaId: "cb58f1bd-8b6f-45b9-ad31-b3140309892c",
  serviceAreaCode: "MK",
  regionId: null,
  regionCurrencyCode: "GBP",
  regionDistanceUnit: "miles",
  paymentProvider: "revolut" as const,
  paymentRefId: "rev_test",
  preauthAmountPence: 1500,
  scheduledDispatchConfig: cfg,
};

Deno.test("RC4: bookingSSOT writes broadcast/convert anchors for future scheduled booking", () => {
  const pickupIso = "2026-09-17T12:00:00.000Z";
  const nowMs = Date.parse("2026-09-16T08:00:00.000Z");
  const row = buildMinimalTripInsertRow({
    ...baseInput,
    body: scheduledBody(pickupIso),
    nowMs,
  });
  const expected = computeScheduledDispatchAnchors({
    scheduledAtIso: pickupIso,
    nowMs,
    urgentTriggerMinutesBeforePickup: 15,
    responseWindowMinutes: 8,
  });
  assertEquals(row.scheduled_at, pickupIso);
  assertEquals(row.scheduled_broadcast_at, expected.scheduledBroadcastAt);
  assertEquals(row.scheduled_convert_at, expected.scheduledConvertAt);
  assertEquals(row.scheduled_status, "scheduled");
  assertEquals(row.status, "scheduled");
  assertEquals(row.is_scheduled, true);
  assertEquals(row.dispatch_mode, "scheduled");
  assertEquals(row.trip_type, "scheduled");

  const createdMs = nowMs;
  const broadcastMs = Date.parse(String(row.scheduled_broadcast_at));
  const convertMs = Date.parse(String(row.scheduled_convert_at));
  const pickupMs = Date.parse(String(row.scheduled_at));
  assert(createdMs < broadcastMs, "created_at < scheduled_broadcast_at");
  assert(broadcastMs <= convertMs, "scheduled_broadcast_at <= scheduled_convert_at");
  assert(convertMs < pickupMs, "scheduled_convert_at < scheduled_at");
});

Deno.test("RC4: immediate NOW booking does not persist scheduled anchors", () => {
  const row = buildMinimalTripInsertRow({
    ...baseInput,
    body: nowBody(),
    nowMs: Date.parse("2026-09-16T08:00:00.000Z"),
  });
  assertEquals(row.is_scheduled, false);
  assertEquals(row.scheduled_at, null);
  assertEquals(row.scheduled_broadcast_at, null);
  assertEquals(row.scheduled_convert_at, null);
  assertEquals(row.scheduled_status, null);
  assertEquals(row.status, "searching");
  assertEquals(row.dispatch_mode, "instant");
});

Deno.test("RC4: SQL persist uses the same computeScheduledDispatchAnchors policy knobs", async () => {
  const src = await Deno.readTextFile(ANCHOR_MIGRATION);
  assertStringIncludes(src, "CREATE OR REPLACE FUNCTION public.compute_scheduled_dispatch_anchors");
  assertStringIncludes(src, "urgent_dispatch_trigger_minutes_before_pickup");
  assertStringIncludes(src, "scheduled_response_window_minutes");
  assertStringIncludes(src, "NEW.scheduled_broadcast_at := v_broadcast");
  assertStringIncludes(src, "NEW.scheduled_convert_at := v_convert");
  assertStringIncludes(src, "NEW.scheduled_status := 'scheduled'");
  assertEquals(
    src.includes("NEW.scheduled_status := 'broadcasting'"),
    false,
    "INSERT trigger must still not open the marketplace",
  );
});

Deno.test("RC4: create-trip-after-payment still uses bookingSSOT + scheduledDispatchConfig", async () => {
  const bookingSrc = await Deno.readTextFile(BOOKING_SSOT);
  const ctapSrc = await Deno.readTextFile(CTAP);
  assertStringIncludes(bookingSrc, "scheduled_broadcast_at: scheduledBroadcastAt");
  assertStringIncludes(bookingSrc, "computeScheduledDispatchAnchors");
  assertStringIncludes(ctapSrc, "buildMinimalTripInsertRow");
  assertStringIncludes(ctapSrc, "scheduledDispatchConfig");
});
