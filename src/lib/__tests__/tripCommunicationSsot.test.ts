import { describe, expect, it } from 'vitest';
import {
  buildCommunicationMethods,
  isPlaceholderOutboundCallerId,
  isUsableOutboundCallerId,
  readCommunicationProviderReadinessFromEnv,
  resolveAuthoritativeAssignedDriverId,
  resolveTripCommunicationParticipant,
  resolveTripCommunicationSsot,
  resolveVoipTokenGate,
  toTripCommunicationConfigApiPayload,
  TRIP_COMMUNICATION_ERROR,
  TRIP_COMMUNICATION_SSOT,
} from '../../../shared/tripCommunicationSsot';

const readyProviders = {
  livekitConfigured: true,
  msg91AuthConfigured: true,
  envCallerId: '+447700900123',
};

const kampalaSettings = {
  is_enabled: true,
  voip_enabled: true,
  call_masking_enabled: true,
  default_method: 'voip' as const,
  maximum_call_duration_seconds: 600,
};

const activeMasking = {
  outbound_caller_id: '+447700900999',
  is_active: true,
  provider_config_id: '11111111-1111-1111-1111-111111111111',
};

describe('tripCommunicationSsot (recovered + capability projection)', () => {
  it('preserves production method labels and default ordering', () => {
    const methods = buildCommunicationMethods({
      is_enabled: true,
      voip_enabled: true,
      call_masking_enabled: true,
      default_method: 'call_masking',
    });
    expect(methods.map((m) => m.method)).toEqual(['call_masking', 'voip']);
    expect(methods[0]?.label).toBe(TRIP_COMMUNICATION_SSOT.labels.call_masking);
    expect(methods[1]?.label).toBe(TRIP_COMMUNICATION_SSOT.labels.voip);
  });

  it('hides all methods when communication module is off', () => {
    expect(
      buildCommunicationMethods({
        is_enabled: false,
        voip_enabled: true,
        call_masking_enabled: true,
        default_method: 'voip',
      }),
    ).toEqual([]);
  });

  it('rejects placeholder caller IDs', () => {
    expect(isPlaceholderOutboundCallerId('+441908000000')).toBe(true);
    expect(isUsableOutboundCallerId('+441908000000')).toBe(false);
    expect(isUsableOutboundCallerId('+447700900123')).toBe(true);
  });

  it('allows VoIP + call masking when authorised and providers ready', () => {
    const result = resolveTripCommunicationSsot({
      tripId: '22222222-2222-2222-2222-222222222222',
      publicTripReference: 'OC-1001',
      serviceAreaId: '33333333-3333-3333-3333-333333333333',
      actorRole: 'driver',
      participantAuthorised: true,
      lifecycleEligible: true,
      settings: kampalaSettings,
      maskingConfig: activeMasking,
      providerReadiness: readyProviders,
    });

    expect(result.allowed).toBe(true);
    expect(result.communicationEnabled).toBe(true);
    expect(result.maximumDurationSeconds).toBe(240);
    expect(result.defaultMethod).toBe('voip');
    expect(result.options.voip.available).toBe(true);
    expect(result.options.callMasking.available).toBe(true);
    expect(result.blockedReason).toBeUndefined();

    const api = toTripCommunicationConfigApiPayload(result);
    expect(api.trip_id).toBe(result.tripId);
    expect(api.maximum_call_duration_seconds).toBe(240);
    expect(api.options.voip.available).toBe(true);
    expect(api.options.voip.can_start).toBe(true);
    expect(api.options.call_masking.available).toBe(true);
    expect(api.active_call).toBeNull();
    expect(JSON.stringify(api)).not.toMatch(/LIVEKIT_API_SECRET|MSG91_AUTH_KEY|\+447700|room_name/);
  });

  it('blocks when participant is not authorised even if settings exist', () => {
    const result = resolveTripCommunicationSsot({
      tripId: '22222222-2222-2222-2222-222222222222',
      serviceAreaId: '33333333-3333-3333-3333-333333333333',
      actorRole: null,
      participantAuthorised: false,
      lifecycleEligible: true,
      settings: kampalaSettings,
      maskingConfig: activeMasking,
      providerReadiness: readyProviders,
    });
    expect(result.allowed).toBe(false);
    expect(result.options.voip.available).toBe(false);
    expect(result.blockedReason).toBe(TRIP_COMMUNICATION_SSOT.notAuthorisedMessage);
  });

  it('marks VoIP unavailable when LiveKit is not configured', () => {
    const result = resolveTripCommunicationSsot({
      tripId: '22222222-2222-2222-2222-222222222222',
      serviceAreaId: '33333333-3333-3333-3333-333333333333',
      actorRole: 'customer',
      participantAuthorised: true,
      lifecycleEligible: true,
      settings: kampalaSettings,
      maskingConfig: activeMasking,
      providerReadiness: {
        livekitConfigured: false,
        msg91AuthConfigured: true,
        envCallerId: '+447700900123',
      },
    });
    expect(result.options.voip.enabled).toBe(true);
    expect(result.options.voip.ready).toBe(false);
    expect(result.options.voip.available).toBe(false);
    expect(result.options.callMasking.available).toBe(true);
    expect(result.allowed).toBe(true);
  });

  it('marks call masking unavailable for placeholder-only caller ID', () => {
    const result = resolveTripCommunicationSsot({
      tripId: '22222222-2222-2222-2222-222222222222',
      serviceAreaId: '33333333-3333-3333-3333-333333333333',
      actorRole: 'customer',
      participantAuthorised: true,
      lifecycleEligible: true,
      settings: kampalaSettings,
      maskingConfig: {
        outbound_caller_id: '+441234567890',
        is_active: true,
        provider_config_id: '11111111-1111-1111-1111-111111111111',
      },
      providerReadiness: {
        livekitConfigured: true,
        msg91AuthConfigured: true,
        envCallerId: '+441908000000',
      },
    });
    expect(result.options.callMasking.available).toBe(false);
    expect(result.options.voip.available).toBe(true);
  });

  it('reads provider readiness as booleans without exposing secrets', () => {
    const env = new Map([
      ['LIVEKIT_URL', 'wss://example.livekit.cloud'],
      ['LIVEKIT_API_KEY', 'key'],
      ['LIVEKIT_API_SECRET', 'secret-value'],
      ['MSG91_AUTH_KEY', 'auth-key'],
      ['MSG91_CALLER_ID', '+447700900123'],
    ]);
    const readiness = readCommunicationProviderReadinessFromEnv({
      get: (key) => env.get(key),
    });
    expect(readiness).toEqual({
      livekitConfigured: true,
      msg91AuthConfigured: true,
      envCallerId: '+447700900123',
    });
  });

  it('authorises assigned Driver via confirmed_driver_id and rejects reassigned Driver', () => {
    expect(
      resolveAuthoritativeAssignedDriverId({
        confirmed_driver_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        driver_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      }),
    ).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

    const assigned = resolveTripCommunicationParticipant({
      authUserId: 'user-a',
      driverProfileId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      trip: {
        confirmed_driver_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        driver_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        passenger_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
    });
    expect(assigned.ok).toBe(true);

    const previous = resolveTripCommunicationParticipant({
      authUserId: 'user-b',
      driverProfileId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      trip: {
        confirmed_driver_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        driver_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        passenger_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
    });
    expect(previous.ok).toBe(false);
    if (!previous.ok) {
      expect(previous.errorCode).toBe(TRIP_COMMUNICATION_ERROR.NOT_TRIP_PARTICIPANT);
    }
  });

  it('gates voip tokens when VoIP is disabled or not configured', () => {
    const disabled = resolveVoipTokenGate(
      resolveTripCommunicationSsot({
        tripId: '22222222-2222-2222-2222-222222222222',
        serviceAreaId: '33333333-3333-3333-3333-333333333333',
        actorRole: 'driver',
        participantAuthorised: true,
        lifecycleEligible: true,
        settings: { ...kampalaSettings, voip_enabled: false },
        maskingConfig: activeMasking,
        providerReadiness: readyProviders,
      }),
    );
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) {
      expect(disabled.errorCode).toBe(TRIP_COMMUNICATION_ERROR.VOIP_DISABLED);
    }
  });
});
