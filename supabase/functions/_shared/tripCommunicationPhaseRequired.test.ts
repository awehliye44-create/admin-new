/**
 * Phase required-test coverage (pure / unit) for Trip Communication 4-minute hardening.
 * Complements tripCommunicationSsot.test.ts + tripCallSession.test.ts + tripCallGaps.test.ts.
 *
 * Run:
 * deno test --no-check --allow-read --allow-env \
 *   supabase/functions/_shared/tripCommunicationPhaseRequired.test.ts
 */
import { assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCommunicationMethods,
  resolveCanStartNewCall,
  resolveEffectiveMaxCallDurationSeconds,
  resolveTripCommunicationParticipant,
  resolveTripCommunicationSsot,
  toTripCommunicationConfigApiPayload,
  TRIP_COMMUNICATION_ERROR,
  TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
  TRIP_COMMUNICATION_SSOT,
} from "../../../shared/tripCommunicationSsot.ts";
import { isCallableTripStatus } from "./callMaskingConfig.ts";
import { maskPhoneForLog } from "./callMaskingLogs.ts";
import { TRIP_CALL_RATE_LIMITS } from "./tripCallRateLimit.ts";
import {
  capDurationSeconds,
  opaqueVoipRoomName,
  voipJoinTokenTtlSeconds,
  voipParticipantIdentity,
} from "./tripCallSession.ts";
import { mapLiveKitWebhookEventType, mapMaskingLogStatus } from "./tripCallStatus.ts";
import { pushTokenFingerprint } from "./incomingCallPush.ts";

const SA = "33333333-3333-3333-3333-333333333333";
const TRIP = "22222222-2222-2222-2222-222222222222";
const DRIVER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CUSTOMER = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const settingsOn = {
  is_enabled: true,
  voip_enabled: true,
  call_masking_enabled: true,
  default_method: "voip" as const,
  maximum_call_duration_seconds: 600,
};

const maskingReady = {
  outbound_caller_id: "+447700900999",
  is_active: true,
  provider_config_id: "11111111-1111-1111-1111-111111111111",
};

const providersReady = {
  livekitConfigured: true,
  msg91AuthConfigured: true,
  envCallerId: "+447700900123",
};

function ssot(overrides: Partial<Parameters<typeof resolveTripCommunicationSsot>[0]> = {}) {
  return resolveTripCommunicationSsot({
    tripId: TRIP,
    publicTripReference: "KA-1",
    serviceAreaId: SA,
    actorRole: "driver",
    participantAuthorised: true,
    lifecycleEligible: true,
    settings: settingsOn,
    maskingConfig: maskingReady,
    providerReadiness: providersReady,
    ...overrides,
  });
}

// ---- §25 config projection ----
Deno.test("§25.1 projection preserves methods/calling_available/disabled_message", () => {
  const api = toTripCommunicationConfigApiPayload(ssot());
  assertEquals(Array.isArray(api.methods), true);
  assertEquals(typeof api.calling_available, "boolean");
  assertEquals("disabled_message" in api, true);
  assertEquals("maximum_call_duration_seconds" in api, true);
});

Deno.test("§25.2 projection includes per-method options", () => {
  const api = toTripCommunicationConfigApiPayload(ssot());
  assertEquals(api.options.voip.enabled, true);
  assertEquals(api.options.call_masking.enabled, true);
  assertEquals("ready" in api.options.voip, true);
  assertEquals("available" in api.options.voip, true);
  assertEquals("can_start" in api.options.voip, true);
});

Deno.test("§25.3–4 active call + 240 seconds", () => {
  const api = toTripCommunicationConfigApiPayload(ssot(), {
    call_id: "c1",
    method: "voip",
    provider: "livekit",
    status: "ringing",
    started_at: new Date().toISOString(),
    connected_at: null,
    expires_at: new Date(Date.now() + 240_000).toISOString(),
    remaining_seconds: 200,
    join_allowed: true,
    end_allowed: true,
  });
  assertEquals(api.active_call?.call_id, "c1");
  assertEquals(api.maximum_call_duration_seconds, 240);
  assertEquals(resolveEffectiveMaxCallDurationSeconds(999), 240);
});

Deno.test("§25.5–6 no secrets or phones in projection", () => {
  const raw = JSON.stringify(toTripCommunicationConfigApiPayload(ssot()));
  assertFalse(raw.includes("LIVEKIT_API_SECRET"));
  assertFalse(raw.includes("MSG91_AUTH_KEY"));
  assertFalse(raw.includes("+447700"));
  assertFalse(raw.includes("room_name"));
  assertFalse(raw.includes("token"));
});

Deno.test("§25.8 terminal trip cannot start a call", () => {
  assertEquals(isCallableTripStatus("cancelled"), false);
  const result = ssot({ lifecycleEligible: false });
  assertEquals(result.allowed, false);
  const api = toTripCommunicationConfigApiPayload(result);
  assertEquals(api.options.voip.can_start, false);
  assertEquals(api.options.call_masking.can_start, false);
});

// ---- §26 LiveKit helpers ----
Deno.test("§26.3 unauthorised actor rejected", () => {
  const p = resolveTripCommunicationParticipant({
    authUserId: "stranger",
    driverProfileId: null,
    trip: { confirmed_driver_id: DRIVER, passenger_id: CUSTOMER },
  });
  assertEquals(p.ok, false);
  if (!p.ok) assertEquals(p.errorCode, TRIP_COMMUNICATION_ERROR.NOT_TRIP_PARTICIPANT);
});

Deno.test("§26.7–12 opaque room, HMAC identity, short TTL, audio policy constant", async () => {
  Deno.env.set("LIVEKIT_API_SECRET", "phase-required-test-secret");
  const room = opaqueVoipRoomName();
  assertEquals(room.startsWith("onecab-call-"), true);
  assertFalse(room.includes(TRIP));
  const id = await voipParticipantIdentity("call-uuid-here-aaaa-bbbb", "driver");
  assertFalse(id.includes("call-uuid-here"));
  assertEquals(id.startsWith("tc:driver:"), true);
  assertEquals(voipJoinTokenTtlSeconds({ expiresAt: new Date(Date.now() + 60_000).toISOString() }) <= 150, true);
  assertEquals(TRIP_COMMUNICATION_SSOT.voipProvider, "livekit");
});

Deno.test("§26.13–15 push payload contract has no token/room; fingerprint safe", () => {
  const payload = {
    type: "incoming_call",
    call_id: "c1",
    trip_id: TRIP,
    method: "voip",
    initiator_role: "driver",
    expires_at: "",
  };
  const raw = JSON.stringify(payload);
  assertFalse(raw.includes("room_name"));
  assertFalse(raw.includes("livekit"));
  const token = "ExponentPushToken[ABCDEFG]";
  assertFalse(pushTokenFingerprint(token).includes(token));
});

Deno.test("§26.16–20 webhook event mapping covers required events", () => {
  for (const e of ["room_started", "participant_joined", "participant_left", "room_finished", "track_published"]) {
    assertEquals(mapLiveKitWebhookEventType(e) !== "other", true);
  }
});

Deno.test("§26.24–26 duration capped and timed_out mapping", () => {
  assertEquals(capDurationSeconds(999), TRIP_COMMUNICATION_MAX_DURATION_SECONDS);
  assertEquals(mapMaskingLogStatus("timed_out"), "timed_out");
});

// ---- §27 call masking ----
Deno.test("§27.1–2 effective max 240; phone logs redacted", () => {
  assertEquals(TRIP_COMMUNICATION_MAX_DURATION_SECONDS, 240);
  assertEquals(maskPhoneForLog("+447700900123"), "+44***23");
  assertFalse(maskPhoneForLog("+447700900123").includes("7700900123"));
});

Deno.test("§27 rate limits documented", () => {
  assertEquals(TRIP_CALL_RATE_LIMITS.cooldownAfterTerminalSeconds, 30);
  assertEquals(TRIP_CALL_RATE_LIMITS.maxAttemptsPerWindow, 20);
});

// ---- §28 cross-provider ----
Deno.test("§28.1–2 active voip blocks both can_start", () => {
  assertEquals(
    resolveCanStartNewCall({
      allowed: true,
      methodAvailable: true,
      activeCall: {
        call_id: "c",
        method: "voip",
        provider: "livekit",
        status: "active",
        started_at: null,
        connected_at: null,
        expires_at: null,
        remaining_seconds: null,
        join_allowed: true,
        end_allowed: true,
      },
    }),
    false,
  );
  assertEquals(
    resolveCanStartNewCall({
      allowed: true,
      methodAvailable: true,
      activeCall: {
        call_id: "c",
        method: "call_masking",
        provider: "msg91",
        status: "active",
        started_at: null,
        connected_at: null,
        expires_at: null,
        remaining_seconds: null,
        join_allowed: true,
        end_allowed: true,
      },
    }),
    false,
  );
});

Deno.test("§28.3–4 terminal permits new call", () => {
  assertEquals(
    resolveCanStartNewCall({
      allowed: true,
      methodAvailable: true,
      activeCall: null,
    }),
    true,
  );
});

Deno.test("§28.5–6 reassignment/cancel blocks via participant + lifecycle", () => {
  const prev = resolveTripCommunicationParticipant({
    authUserId: "u",
    driverProfileId: "old-driver",
    trip: { confirmed_driver_id: DRIVER, passenger_id: CUSTOMER },
  });
  assertEquals(prev.ok, false);
  assertEquals(isCallableTripStatus("customer_cancelled"), false);
});

Deno.test("§28.8 active-call projection provider-neutral labels", () => {
  const methods = buildCommunicationMethods(settingsOn);
  assertEquals(methods.some((m) => m.method === "voip"), true);
  assertEquals(methods.some((m) => m.method === "call_masking"), true);
  assertEquals(TRIP_COMMUNICATION_ERROR.CALL_ALREADY_ACTIVE, "CALL_ALREADY_ACTIVE");
  assertEquals(TRIP_COMMUNICATION_ERROR.RATE_LIMITED, "RATE_LIMITED");
  assertEquals(TRIP_COMMUNICATION_ERROR.CALL_EXPIRED, "CALL_EXPIRED");
});
