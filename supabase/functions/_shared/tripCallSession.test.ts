/**
 * Provider-neutral call session + LiveKit identity/duration helpers.
 * Run: deno test --no-check --allow-read supabase/functions/_shared/tripCallSession.test.ts
 */
import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
  resolveEffectiveMaxCallDurationSeconds,
} from "../../../shared/tripCommunicationSsot.ts";
import {
  capDurationSeconds,
  computeExpiresAtFromConnected,
  opaqueVoipRoomName,
  toActiveCallProjection,
  voipJoinTokenTtlSeconds,
  voipParticipantIdentity,
  type ProviderNeutralCallSession,
} from "./tripCallSession.ts";
import {
  isTerminalCallStatus,
  mapLiveKitWebhookEventType,
  mapMaskingLogStatus,
  mapVoipLogStatus,
} from "./tripCallStatus.ts";
import { pushTokenFingerprint } from "./incomingCallPush.ts";
import { DEFAULT_MAX_CALL_DURATION_SEC } from "./callMaskingConfig.ts";

Deno.test("max duration constant is exactly 240", () => {
  assertEquals(TRIP_COMMUNICATION_MAX_DURATION_SECONDS, 240);
  assertEquals(resolveEffectiveMaxCallDurationSeconds(600), 240);
  assertEquals(resolveEffectiveMaxCallDurationSeconds(null), 240);
  assertEquals(DEFAULT_MAX_CALL_DURATION_SEC, 240);
});

Deno.test("opaque room name never embeds trip id", () => {
  const tripId = "22222222-2222-2222-2222-222222222222";
  const room = opaqueVoipRoomName();
  assertMatch(room, /^onecab-call-[a-f0-9]{32}$/);
  assertEquals(room.includes(tripId), false);
  assertEquals(room.includes("trip-"), false);
});

Deno.test("participant identity is call-scoped HMAC opaque", async () => {
  Deno.env.set("LIVEKIT_API_SECRET", "unit-test-secret");
  const callId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const driver = await voipParticipantIdentity(callId, "driver");
  const customer = await voipParticipantIdentity(callId, "customer");
  assertEquals(driver.includes(callId), false);
  assertEquals(customer.includes("phone"), false);
  assertEquals(driver.startsWith("tc:driver:"), true);
  assertEquals(customer.startsWith("tc:customer:"), true);
});

Deno.test("join token TTL is short and respects expiry", () => {
  const now = Date.now();
  const expiresAt = new Date(now + 60_000).toISOString();
  const ttl = voipJoinTokenTtlSeconds({ expiresAt, nowMs: now });
  assertEquals(ttl <= 150, true);
  assertEquals(ttl >= 30, true);
  assertEquals(voipJoinTokenTtlSeconds({ expiresAt: new Date(now - 1000).toISOString(), nowMs: now }), 0);
});

Deno.test("duration is capped at 240", () => {
  assertEquals(capDurationSeconds(999), 240);
  assertEquals(capDurationSeconds(120), 120);
  assertEquals(capDurationSeconds(-5), 0);
});

Deno.test("expires_at is connected_at + 240s", () => {
  const connected = "2026-07-26T12:00:00.000Z";
  assertEquals(computeExpiresAtFromConnected(connected), "2026-07-26T12:04:00.000Z");
});

Deno.test("active call projection hides room and marks expired as not joinable", () => {
  const session: ProviderNeutralCallSession = {
    callId: "c1",
    tripId: "t1",
    serviceAreaId: "s1",
    method: "voip",
    provider: "livekit",
    status: "active",
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    connectedAt: new Date(Date.now() - 10_000).toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    endedAt: null,
    durationSeconds: null,
    endReason: null,
    roomName: "onecab-call-secret",
    initiatorRole: "driver",
    incomingPushSentAt: null,
  };
  const proj = toActiveCallProjection(session)!;
  assertEquals(proj.join_allowed, false);
  assertEquals(proj.status, "timed_out");
  assertEquals(JSON.stringify(proj).includes("roomName"), false);
  assertEquals(JSON.stringify(proj).includes("onecab-call"), false);
});

Deno.test("status mapping is provider-neutral", () => {
  assertEquals(mapVoipLogStatus("active"), "active");
  assertEquals(mapVoipLogStatus("disconnected", "CALL_DURATION_LIMIT_REACHED"), "timed_out");
  assertEquals(mapMaskingLogStatus("active"), "active");
  assertEquals(mapMaskingLogStatus("disconnected", "CALL_DURATION_LIMIT_REACHED"), "timed_out");
  assertEquals(isTerminalCallStatus("timed_out"), true);
  assertEquals(mapLiveKitWebhookEventType("participant_joined"), "participant_joined");
  assertEquals(mapLiveKitWebhookEventType("room_finished"), "room_finished");
});

Deno.test("push token fingerprint never equals full token", () => {
  const token = "ExponentPushToken[abcdefghijklmnopqrstuvwxyz]";
  const fp = pushTokenFingerprint(token);
  assertEquals(fp.includes(token), false);
  assertEquals(fp.startsWith("fp_"), true);
});
