/**
 * Gap-close tests: rate limits, HMAC identity, status mapping, cross-provider helpers.
 * Run: deno test --no-check --allow-read --allow-env supabase/functions/_shared/tripCallGaps.test.ts
 */
import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
  toTripCommunicationConfigApiPayload,
  resolveTripCommunicationSsot,
  TRIP_COMMUNICATION_ERROR,
} from "../../../shared/tripCommunicationSsot.ts";
import { voipParticipantIdentity, opaqueVoipRoomName } from "./tripCallSession.ts";
import {
  mapMaskingLogStatus,
  mapLiveKitWebhookEventType,
  mapVoipLogStatus,
} from "./tripCallStatus.ts";
import { TRIP_CALL_RATE_LIMITS } from "./tripCallRateLimit.ts";
import { DEFAULT_MAX_CALL_DURATION_SEC } from "./callMaskingConfig.ts";

Deno.test("rate limit constants are defined", () => {
  assertEquals(TRIP_CALL_RATE_LIMITS.cooldownAfterTerminalSeconds, 30);
  assertEquals(TRIP_CALL_RATE_LIMITS.maxAttemptsPerWindow, 20);
  assertEquals(TRIP_CALL_RATE_LIMITS.attemptWindowSeconds, 3600);
});

Deno.test("HMAC identity does not embed raw call UUID", async () => {
  const callId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  Deno.env.set("LIVEKIT_API_SECRET", "test-secret-for-hmac-identity-gap-close");
  const identity = await voipParticipantIdentity(callId, "driver");
  assertEquals(identity.includes(callId), false);
  assertMatch(identity, /^tc:driver:[a-f0-9]{24}$/);
  const customer = await voipParticipantIdentity(callId, "customer");
  assertEquals(customer === identity, false);
  assertMatch(customer, /^tc:customer:[a-f0-9]{24}$/);
});

Deno.test("masking timed_out status maps neutrally", () => {
  assertEquals(mapMaskingLogStatus("timed_out"), "timed_out");
  assertEquals(mapMaskingLogStatus("disconnected", "CALL_DURATION_LIMIT_REACHED"), "timed_out");
  assertEquals(mapVoipLogStatus("timed_out"), "timed_out");
});

Deno.test("webhook maps track_published", () => {
  assertEquals(mapLiveKitWebhookEventType("track_published"), "track_published");
  assertEquals(mapLiveKitWebhookEventType("participant_left"), "participant_left");
});

Deno.test("MSG91 and VoIP share 240s SSOT", () => {
  assertEquals(DEFAULT_MAX_CALL_DURATION_SEC, TRIP_COMMUNICATION_MAX_DURATION_SECONDS);
  assertEquals(TRIP_COMMUNICATION_MAX_DURATION_SECONDS, 240);
});

Deno.test("active voip blocks can_start for both methods in projection", () => {
  const ssot = resolveTripCommunicationSsot({
    tripId: "22222222-2222-2222-2222-222222222222",
    serviceAreaId: "33333333-3333-3333-3333-333333333333",
    actorRole: "driver",
    participantAuthorised: true,
    lifecycleEligible: true,
    settings: {
      is_enabled: true,
      voip_enabled: true,
      call_masking_enabled: true,
      default_method: "voip",
      maximum_call_duration_seconds: 600,
    },
    maskingConfig: {
      outbound_caller_id: "+447700900999",
      is_active: true,
      provider_config_id: "11111111-1111-1111-1111-111111111111",
    },
    providerReadiness: {
      livekitConfigured: true,
      msg91AuthConfigured: true,
      envCallerId: "+447700900123",
    },
  });
  const api = toTripCommunicationConfigApiPayload(ssot, {
    call_id: "c1",
    method: "voip",
    provider: "livekit",
    status: "active",
    started_at: new Date().toISOString(),
    connected_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    remaining_seconds: 120,
    join_allowed: true,
    end_allowed: true,
  });
  assertEquals(api.options.voip.can_start, false);
  assertEquals(api.options.call_masking.can_start, false);
  assertEquals(api.maximum_call_duration_seconds, 240);
  assertEquals(TRIP_COMMUNICATION_ERROR.RATE_LIMITED, "RATE_LIMITED");
  assertEquals(opaqueVoipRoomName().startsWith("onecab-call-"), true);
});
