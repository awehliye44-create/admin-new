/**
 * Deno tests: FCM → booking_delivery_log instrumentation (observability only).
 * Run: deno test supabase/functions/_shared/fcmPushDeliveryInstrumentation.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFcmPushDeliveryDetail,
  notificationChannelForPlatform,
  recordBookingDeliveryPhaseBestEffort,
  recordFcmPushOutcomeBestEffort,
  resolveBookingIdFromPushData,
  resolveFcmTerminalPhase,
  resolveOfferIdFromPushData,
  shouldRecordFcmPushOutcome,
} from "./fcmPushDeliveryInstrumentation.ts";

const BOOKING = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DRIVER = "11111111-2222-4333-8444-555555555555";
const OFFER = "99999999-8888-4777-8666-555555555555";

Deno.test("A: FCM success → push_sent terminal phase", () => {
  assertEquals(
    resolveFcmTerminalPhase([{ platform: "ios", success: true, providerResponse: "projects/x/messages/1" }]),
    "push_sent",
  );
});

Deno.test("B: FCM provider failure → push_failed terminal phase", () => {
  assertEquals(
    resolveFcmTerminalPhase([{ platform: "android", success: false, error: "UNREGISTERED" }]),
    "push_failed",
  );
});

Deno.test("C: no FCM attempt (no tokens) → null phase (no push_sent/failed)", () => {
  assertEquals(resolveFcmTerminalPhase([]), null);
});

Deno.test("mixed attempts: any success prefers push_sent (never both)", () => {
  assertEquals(
    resolveFcmTerminalPhase([
      { platform: "android", success: false, error: "fail" },
      { platform: "ios", success: true, providerResponse: "projects/x/messages/2" },
    ]),
    "push_sent",
  );
});

Deno.test("D/E: socket/ACK not implied — helpers only resolve FCM attempt results", () => {
  // Pure: socket_sent / booking_received are independent phases elsewhere.
  assertEquals(resolveFcmTerminalPhase([{ platform: "ios", success: true }]), "push_sent");
  assertEquals(
    shouldRecordFcmPushOutcome({
      bookingId: BOOKING,
      driverId: DRIVER,
      offerId: OFFER,
      notificationType: "NEW_RIDE_OFFER",
      results: [{ platform: "ios", success: true }],
    }),
    true,
  );
});

Deno.test("detail omits raw tokens; keeps provider_response shape", () => {
  const detail = buildFcmPushDeliveryDetail({
    bookingId: BOOKING,
    driverId: DRIVER,
    offerId: OFFER,
    notificationType: "NEW_RIDE_OFFER",
    title: "New ride offer",
    reminderIndex: null,
    atIso: "2026-08-16T06:00:00.000Z",
    results: [
      {
        platform: "ios",
        success: true,
        providerResponse: "projects/onecab/messages/123",
        notificationChannel: notificationChannelForPlatform("ios", true),
        error: null,
      },
    ],
  });
  assertEquals(detail.devices_ok, 1);
  assertEquals(detail.total_tokens, 1);
  assertEquals(detail.notification_type, "NEW_RIDE_OFFER");
  const row = (detail.results as Array<Record<string, unknown>>)[0];
  assertEquals(row.success, true);
  assertEquals(row.provider_response, "projects/onecab/messages/123");
  assertEquals(row.notification_channel, "apns_time_sensitive");
  assert(!("token" in row), "must not store FCM device token");
  assertEquals(row.token_present, true);
});

Deno.test("payload id resolution from historical keys", () => {
  assertEquals(
    resolveBookingIdFromPushData({ booking_id: BOOKING, offer_id: OFFER }),
    BOOKING,
  );
  assertEquals(
    resolveOfferIdFromPushData({ offerId: OFFER }),
    OFFER,
  );
  assertEquals(
    resolveOfferIdFromPushData({ change_request_id: OFFER }),
    OFFER,
  );
  assertEquals(resolveBookingIdFromPushData({ booking_id: "not-a-uuid" }), null);
});

Deno.test("F: telemetry RPC failure does not throw; delivery path unaffected", async () => {
  let rpcCalls = 0;
  const supabase = {
    rpc: async () => {
      rpcCalls++;
      return { error: { message: "simulated telemetry failure" } };
    },
  };
  const out = await recordFcmPushOutcomeBestEffort(supabase, {
    bookingId: BOOKING,
    driverId: DRIVER,
    offerId: OFFER,
    notificationType: "NEW_RIDE_OFFER",
    results: [{ platform: "android", success: true, providerResponse: "projects/x/messages/9" }],
  });
  assertEquals(rpcCalls, 1);
  assertEquals(out.phase, "push_sent");
  assertEquals(out.recorded, false);
});

Deno.test("G: successful record writes push_sent once via RPC", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const supabase = {
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { error: null };
    },
  };
  const out = await recordFcmPushOutcomeBestEffort(supabase, {
    bookingId: BOOKING,
    driverId: DRIVER,
    offerId: OFFER,
    notificationType: "NEW_RIDE_OFFER",
    title: "New ride offer",
    results: [
      {
        platform: "android",
        success: true,
        providerResponse: "projects/x/messages/1",
        notificationChannel: "onecab_driver_offers",
      },
    ],
  });
  assertEquals(out.recorded, true);
  assertEquals(out.phase, "push_sent");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].p_phase, "push_sent");
  assertEquals(calls[0].p_source, "edge");
  assertEquals(calls[0].p_booking_id, BOOKING);
  assertEquals(calls[0].p_offer_id, OFFER);
});

Deno.test("provider failure records push_failed exactly once (logical call)", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const supabase = {
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { error: null };
    },
  };
  const out = await recordFcmPushOutcomeBestEffort(supabase, {
    bookingId: BOOKING,
    driverId: DRIVER,
    offerId: OFFER,
    notificationType: "NEW_RIDE_OFFER",
    results: [{ platform: "ios", success: false, error: "UNREGISTERED" }],
  });
  assertEquals(out.phase, "push_failed");
  assertEquals(out.recorded, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].p_phase, "push_failed");
});

Deno.test("skip record when booking/driver missing (before FCM context)", () => {
  assertEquals(
    shouldRecordFcmPushOutcome({
      bookingId: null,
      driverId: DRIVER,
      notificationType: "NEW_RIDE_OFFER",
      results: [{ platform: "ios", success: true }],
    }),
    false,
  );
});

Deno.test("push_enqueued / skip_no_token phase writes are best-effort", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const supabase = {
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { error: null };
    },
  };
  const enq = await recordBookingDeliveryPhaseBestEffort(supabase, {
    bookingId: BOOKING,
    driverId: DRIVER,
    offerId: OFFER,
    phase: "push_enqueued",
    detail: { event_type: "trip_modified" },
  });
  assertEquals(enq.recorded, true);
  assertEquals(calls[0].p_phase, "push_enqueued");
  assertEquals(calls[0].p_offer_id, OFFER);

  const skip = await recordBookingDeliveryPhaseBestEffort(supabase, {
    bookingId: BOOKING,
    driverId: DRIVER,
    offerId: OFFER,
    phase: "push_enqueued_skip_no_token",
    detail: { reason: "no_authoritative_push_token" },
  });
  assertEquals(skip.recorded, true);
  assertEquals(calls[1].p_phase, "push_enqueued_skip_no_token");
});
