/**
 * Deno unit tests for trip communication SSOT (items 1–2).
 * Pure resolver/auth tests — no live DB, no secrets in assertions.
 *
 * Run: deno test --no-check --allow-read supabase/functions/_shared/tripCommunicationSsot.test.ts
 */
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isCallableTripStatus } from "./callMaskingConfig.ts";
import {
  buildCommunicationMethods,
  readCommunicationProviderReadinessFromEnv,
  resolveAuthoritativeAssignedDriverId,
  resolveTripCommunicationParticipant,
  resolveTripCommunicationSsot,
  resolveVoipTokenGate,
  toTripCommunicationConfigApiPayload,
  TRIP_COMMUNICATION_ERROR,
  TRIP_COMMUNICATION_SSOT,
} from "../../../shared/tripCommunicationSsot.ts";

const TRIP_ID = "22222222-2222-2222-2222-222222222222";
const SA_KAMPALA = "33333333-3333-3333-3333-333333333333";
const SA_OTHER = "44444444-4444-4444-4444-444444444444";
const DRIVER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DRIVER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CUSTOMER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_B = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const readyProviders = {
  livekitConfigured: true,
  msg91AuthConfigured: true,
  envCallerId: "+447700900123",
};

const kampalaOn = {
  is_enabled: true,
  voip_enabled: true,
  call_masking_enabled: true,
  default_method: "voip" as const,
  maximum_call_duration_seconds: 600,
  voip_rate_per_minute_minor: 4,
  masked_call_rate_per_minute_minor: 8,
  currency: "UGX",
};

const activeMasking = {
  outbound_caller_id: "+447700900999",
  is_active: true,
  provider_config_id: "11111111-1111-1111-1111-111111111111",
};

function ssotFor(overrides: Partial<Parameters<typeof resolveTripCommunicationSsot>[0]> = {}) {
  return resolveTripCommunicationSsot({
    tripId: TRIP_ID,
    publicTripReference: "KA-1001",
    serviceAreaId: SA_KAMPALA,
    actorRole: "driver",
    participantAuthorised: true,
    lifecycleEligible: true,
    settings: kampalaOn,
    maskingConfig: activeMasking,
    providerReadiness: readyProviders,
    ...overrides,
  });
}

Deno.test("1-2: assigned Driver via confirmed_driver_id is authorised", () => {
  const result = resolveTripCommunicationParticipant({
    authUserId: "user-driver-a",
    driverProfileId: DRIVER_A,
    trip: {
      confirmed_driver_id: DRIVER_A,
      driver_id: DRIVER_A,
      passenger_id: CUSTOMER_A,
    },
  });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.role, "driver");
});

Deno.test("2: confirmed_driver_id is preferred over stale driver_id", () => {
  assertEquals(
    resolveAuthoritativeAssignedDriverId({
      confirmed_driver_id: DRIVER_A,
      driver_id: DRIVER_B,
    }),
    DRIVER_A,
  );
  const prev = resolveTripCommunicationParticipant({
    authUserId: "user-driver-b",
    driverProfileId: DRIVER_B,
    trip: { confirmed_driver_id: DRIVER_A, driver_id: DRIVER_B, passenger_id: CUSTOMER_A },
  });
  assertEquals(prev.ok, false);
  if (!prev.ok) {
    assertEquals(prev.errorCode, TRIP_COMMUNICATION_ERROR.NOT_TRIP_PARTICIPANT);
  }
});

Deno.test("3: owning Customer is authorised", () => {
  const result = resolveTripCommunicationParticipant({
    authUserId: CUSTOMER_A,
    driverProfileId: null,
    trip: {
      confirmed_driver_id: DRIVER_A,
      driver_id: DRIVER_A,
      passenger_id: CUSTOMER_A,
    },
  });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.role, "customer");
});

Deno.test("4: unassigned Driver (offer-only) is rejected", () => {
  const result = resolveTripCommunicationParticipant({
    authUserId: "user-driver-a",
    driverProfileId: DRIVER_A,
    trip: {
      confirmed_driver_id: null,
      driver_id: null,
      passenger_id: CUSTOMER_A,
    },
  });
  assertEquals(result.ok, false);
});

Deno.test("5: previous/reassigned Driver is rejected", () => {
  const result = resolveTripCommunicationParticipant({
    authUserId: "user-driver-b",
    driverProfileId: DRIVER_B,
    trip: {
      confirmed_driver_id: DRIVER_A,
      driver_id: DRIVER_A,
      passenger_id: CUSTOMER_A,
    },
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.errorCode, TRIP_COMMUNICATION_ERROR.NOT_TRIP_PARTICIPANT);
  }
});

Deno.test("6: wrong Customer is rejected", () => {
  const result = resolveTripCommunicationParticipant({
    authUserId: CUSTOMER_B,
    driverProfileId: null,
    trip: {
      confirmed_driver_id: DRIVER_A,
      driver_id: DRIVER_A,
      passenger_id: CUSTOMER_A,
    },
  });
  assertEquals(result.ok, false);
});

Deno.test("7: missing auth user is rejected", () => {
  const result = resolveTripCommunicationParticipant({
    authUserId: "",
    driverProfileId: DRIVER_A,
    trip: { confirmed_driver_id: DRIVER_A, passenger_id: CUSTOMER_A },
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.errorCode, TRIP_COMMUNICATION_ERROR.AUTH_REQUIRED);
});

Deno.test("8: service area comes from resolver input (trip), not client SA", () => {
  const kampala = ssotFor({ serviceAreaId: SA_KAMPALA });
  const other = ssotFor({
    serviceAreaId: SA_OTHER,
    settings: { ...kampalaOn, is_enabled: false },
  });
  assertEquals(kampala.serviceAreaId, SA_KAMPALA);
  assertEquals(kampala.allowed, true);
  assertEquals(other.serviceAreaId, SA_OTHER);
  assertEquals(other.allowed, false);
  assertEquals(other.communicationEnabled, false);
});

Deno.test("9: Kampala ON returns communication enabled", () => {
  const result = ssotFor();
  assertEquals(result.communicationEnabled, true);
  assertEquals(result.allowed, true);
  assertEquals(result.defaultMethod, "voip");
});

Deno.test("10: master toggle OFF returns both methods unavailable", () => {
  const result = ssotFor({
    settings: { ...kampalaOn, is_enabled: false },
  });
  assertEquals(result.communicationEnabled, false);
  assertEquals(result.options.voip.available, false);
  assertEquals(result.options.callMasking.available, false);
  assertEquals(result.blockedReason, TRIP_COMMUNICATION_SSOT.disabledMessage);
  const gate = resolveVoipTokenGate(result);
  assertEquals(gate.ok, false);
  if (!gate.ok) {
    assertEquals(gate.errorCode, TRIP_COMMUNICATION_ERROR.COMMUNICATION_DISABLED);
  }
});

Deno.test("11: VoIP enabled + secrets ready => voip available", () => {
  const result = ssotFor();
  assertEquals(result.options.voip.enabled, true);
  assertEquals(result.options.voip.ready, true);
  assertEquals(result.options.voip.available, true);
});

Deno.test("12: missing LiveKit config => VoIP unavailable safely", () => {
  const result = ssotFor({
    providerReadiness: {
      livekitConfigured: false,
      msg91AuthConfigured: true,
      envCallerId: "+447700900123",
    },
  });
  assertEquals(result.options.voip.available, false);
  assertEquals(result.options.callMasking.available, true);
  const gate = resolveVoipTokenGate(result);
  assertEquals(gate.ok, false);
  if (!gate.ok) {
    assertEquals(gate.errorCode, TRIP_COMMUNICATION_ERROR.VOIP_NOT_CONFIGURED);
  }
});

Deno.test("13: call masking enabled + assignment/caller ID => ready", () => {
  const result = ssotFor();
  assertEquals(result.options.callMasking.enabled, true);
  assertEquals(result.options.callMasking.ready, true);
  assertEquals(result.options.callMasking.available, true);
});

Deno.test("14: missing MSG91 readiness => call masking unavailable", () => {
  const result = ssotFor({
    providerReadiness: {
      livekitConfigured: true,
      msg91AuthConfigured: false,
      envCallerId: null,
    },
    maskingConfig: {
      outbound_caller_id: "+441908000000",
      is_active: true,
      provider_config_id: "11111111-1111-1111-1111-111111111111",
    },
  });
  assertEquals(result.options.callMasking.available, false);
  assertEquals(result.options.voip.available, true);
});

Deno.test("15: terminal trip not callable", () => {
  assertEquals(isCallableTripStatus("cancelled"), false);
  assertEquals(isCallableTripStatus("no_show"), false);
  assertEquals(isCallableTripStatus("completed"), false);
  const result = ssotFor({ lifecycleEligible: false });
  assertEquals(result.allowed, false);
  const gate = resolveVoipTokenGate(result);
  assertEquals(gate.ok, false);
  if (!gate.ok) {
    assertEquals(gate.errorCode, TRIP_COMMUNICATION_ERROR.COMMUNICATION_NOT_ALLOWED);
  }
});

Deno.test("16: searching/unassigned statuses not callable", () => {
  assertEquals(isCallableTripStatus("searching"), false);
  assertEquals(isCallableTripStatus("pending"), false);
  assertEquals(isCallableTripStatus("offered"), false);
  assertEquals(isCallableTripStatus("driver_assigned"), true);
  assertEquals(isCallableTripStatus("en_route_to_pickup"), true);
});

Deno.test("17: voip token gate rejects unauthorised participants", () => {
  const result = ssotFor({
    participantAuthorised: false,
    actorRole: null,
  });
  const gate = resolveVoipTokenGate(result);
  assertEquals(gate.ok, false);
  if (!gate.ok) {
    assertEquals(gate.errorCode, TRIP_COMMUNICATION_ERROR.NOT_TRIP_PARTICIPANT);
  }
});

Deno.test("18: voip token gate rejects when VoIP disabled", () => {
  const result = ssotFor({
    settings: { ...kampalaOn, voip_enabled: false },
  });
  const gate = resolveVoipTokenGate(result);
  assertEquals(gate.ok, false);
  if (!gate.ok) {
    assertEquals(gate.errorCode, TRIP_COMMUNICATION_ERROR.VOIP_DISABLED);
  }
});

Deno.test("19: RLS policy text remains staff-only (migration contract)", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260714075811_78a94d53-6566-4ce5-89eb-a3035a31de9c.sql",
      import.meta.url,
    ),
  );
  assertEquals(sql.includes("Service area communication settings readable by staff"), true);
  assertEquals(sql.includes("has_role(auth.uid(), 'admin'"), true);
  assertEquals(
    /CREATE POLICY "Service area communication settings readable by authenticated"/.test(sql),
    false,
  );
});

Deno.test("20-21: API payload contains no secrets or phone numbers", () => {
  const api = toTripCommunicationConfigApiPayload(ssotFor());
  const raw = JSON.stringify(api);
  assertEquals(raw.includes("LIVEKIT_API_SECRET"), false);
  assertEquals(raw.includes("MSG91_AUTH_KEY"), false);
  assertEquals(raw.includes("+447700"), false);
  assertEquals(raw.includes("voip_rate"), false);
  assertEquals(raw.includes("room_name"), false);
  assertEquals(api.options.voip.available, true);
  assertEquals(api.options.voip.can_start, true);
  assertEquals(api.options.call_masking.can_start, true);
  assertExists(api.methods);
  assertEquals(api.calling_available, true);
  assertEquals(api.active_call, null);
  assertEquals(api.maximum_call_duration_seconds, 240);
  assertEquals(api.maximum_duration_seconds, 240);
});

Deno.test("runtime duration SSOT is always 240 regardless of settings row", () => {
  const result = ssotFor({
    settings: { ...kampalaOn, maximum_call_duration_seconds: 600 },
  });
  assertEquals(result.maximumDurationSeconds, 240);
  const api = toTripCommunicationConfigApiPayload(result, {
    call_id: "call-1",
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
  assertEquals(api.active_call?.call_id, "call-1");
  assertEquals(api.active_call?.method, "voip");
  assertEquals(api.options.voip.can_start, false);
  assertEquals(api.options.call_masking.can_start, false);
  assertEquals(JSON.stringify(api).includes("room_name"), false);
});

Deno.test("labels and default ordering preserved from recovered SSOT", () => {
  const methods = buildCommunicationMethods({
    is_enabled: true,
    voip_enabled: true,
    call_masking_enabled: true,
    default_method: "call_masking",
  });
  assertEquals(methods[0]?.method, "call_masking");
  assertEquals(methods[0]?.label, TRIP_COMMUNICATION_SSOT.labels.call_masking);
});

Deno.test("provider readiness helper never returns secret values", () => {
  const env = new Map([
    ["LIVEKIT_URL", "wss://example.livekit.cloud"],
    ["LIVEKIT_API_KEY", "APIkey"],
    ["LIVEKIT_API_SECRET", "super-secret"],
    ["MSG91_AUTH_KEY", "msg-secret"],
    ["MSG91_CALLER_ID", "+447700900123"],
  ]);
  const readiness = readCommunicationProviderReadinessFromEnv({
    get: (k) => env.get(k),
  });
  assertEquals(readiness.livekitConfigured, true);
  assertEquals(readiness.msg91AuthConfigured, true);
  assertEquals(Object.keys(readiness).sort(), [
    "envCallerId",
    "livekitConfigured",
    "msg91AuthConfigured",
  ]);
});
