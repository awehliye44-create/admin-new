/**
 * Trip communication SSOT — service-area methods for in-trip calling (driver + customer).
 * Methods and order come from backend only; clients must not hardcode availability.
 *
 * Recovered from production Edge Function eszip (trip-communication-config / call-masking)
 * and extended with a privacy-safe capability projection for authorised trip participants.
 *
 * Never expose provider secrets, auth keys, LiveKit tokens, or participant phone numbers.
 */

export type TripCommunicationMethodType = 'voip' | 'call_masking';

export interface TripCommunicationMethod {
  method: TripCommunicationMethodType;
  label: string;
}

export interface TripCommunicationConfigResponse {
  methods: TripCommunicationMethod[];
  maximum_call_duration_seconds: number;
  calling_available: boolean;
  disabled_message?: string | null;
}

export interface LiveKitVoipTokenResponse {
  token: string;
  livekit_url: string;
  room_name: string;
  maximum_call_duration_seconds: number;
  participant_identity: string;
  call_log_id?: string | null;
}

export const TRIP_COMMUNICATION_SSOT = {
  configFunction: 'trip-communication-config' as const,
  voipTokenFunction: 'livekit-voip-token' as const,
  voipCallEventFunction: 'voip-call-event' as const,
  voipProvider: 'livekit' as const,
  callMaskingProvider: 'msg91' as const,
  disabledMessage: 'Calling is disabled for this service area.',
  unavailableMessage: 'Calling is not available for this trip.',
  notAuthorisedMessage: 'You are not authorised to communicate on this trip.',
  noServiceAreaMessage: 'Calling is not configured for this trip.',
  maxDurationEndMessage: 'Call ended — maximum call duration reached.',
  labels: {
    voip: 'Call in app',
    call_masking: 'Call',
  } as const,
  entryPoints: {
    driver: 'ActiveTripCard.contactSheet',
    customer: 'RideTracking.contactSheet',
  } as const,
} as const;

/** Placeholder catalog caller IDs — not valid for production masking. */
const PLACEHOLDER_CALLER_IDS = new Set(['+441908000000', '+441234567890']);

const E164_RE = /^\+[1-9]\d{6,14}$/;

export function normalizeOutboundCallerIdE164(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().replace(/\s+/g, '');
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('+') ? trimmed : `+${trimmed.replace(/^\+/, '')}`;
  if (!E164_RE.test(normalized)) return null;
  return normalized;
}

export function isPlaceholderOutboundCallerId(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeOutboundCallerIdE164(value);
  return normalized != null && PLACEHOLDER_CALLER_IDS.has(normalized);
}

export function isUsableOutboundCallerId(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeOutboundCallerIdE164(value);
  return Boolean(normalized && !PLACEHOLDER_CALLER_IDS.has(normalized));
}

export function buildCommunicationMethods(input: {
  is_enabled: boolean;
  voip_enabled: boolean;
  call_masking_enabled: boolean;
  default_method: TripCommunicationMethodType;
}): TripCommunicationMethod[] {
  if (!input.is_enabled) return [];

  const methods: TripCommunicationMethod[] = [];
  if (input.voip_enabled) {
    methods.push({ method: 'voip', label: TRIP_COMMUNICATION_SSOT.labels.voip });
  }
  if (input.call_masking_enabled) {
    methods.push({
      method: 'call_masking',
      label: TRIP_COMMUNICATION_SSOT.labels.call_masking,
    });
  }

  if (methods.length === 2) {
    const preferred = input.default_method;
    methods.sort((a, b) => {
      if (a.method === preferred) return -1;
      if (b.method === preferred) return 1;
      return 0;
    });
  }

  return methods;
}

export type TripCommunicationActorRole = 'driver' | 'customer';

export type ServiceAreaCommunicationSettingsInput = {
  is_enabled: boolean;
  voip_enabled: boolean;
  call_masking_enabled: boolean;
  default_method: TripCommunicationMethodType;
  maximum_call_duration_seconds: number;
  voip_rate_per_minute_minor?: number;
  masked_call_rate_per_minute_minor?: number;
  currency?: string;
};

export type ServiceAreaCallMaskingConfigInput = {
  outbound_caller_id: string | null;
  is_active: boolean;
  provider_config_id: string | null;
};

export type TripCommunicationProviderReadinessInput = {
  /** True when LIVEKIT_URL + LIVEKIT_API_KEY + LIVEKIT_API_SECRET are present server-side. */
  livekitConfigured: boolean;
  /** True when MSG91_AUTH_KEY is present server-side. Never expose the key. */
  msg91AuthConfigured: boolean;
  /** Optional env fallback caller ID (MSG91_CALLER_ID). Never returned to clients. */
  envCallerId?: string | null;
};

export type TripCommunicationMethodCapability = {
  enabled: boolean;
  ready: boolean;
  available: boolean;
  unavailableReason?: string;
};

export type TripCommunicationSsotResult = {
  tripId: string;
  publicTripReference?: string;
  serviceAreaId: string | null;
  actorRole: TripCommunicationActorRole | null;
  participantAuthorised: boolean;
  communicationEnabled: boolean;
  allowed: boolean;
  blockedReason?: string;
  defaultMethod?: TripCommunicationMethodType;
  maximumDurationSeconds: number;
  options: {
    voip: TripCommunicationMethodCapability;
    callMasking: TripCommunicationMethodCapability;
  };
};

export type ResolveTripCommunicationSsotInput = {
  tripId: string;
  publicTripReference?: string | null;
  serviceAreaId: string | null;
  actorRole: TripCommunicationActorRole | null;
  participantAuthorised: boolean;
  /** True when trip lifecycle permits communication (callable statuses / grace). */
  lifecycleEligible: boolean;
  settings: ServiceAreaCommunicationSettingsInput | null;
  maskingConfig: ServiceAreaCallMaskingConfigInput | null;
  providerReadiness: TripCommunicationProviderReadinessInput;
};

const DEFAULT_MAX_DURATION_SECONDS = 600;

function resolveMaskingCallerId(
  maskingConfig: ServiceAreaCallMaskingConfigInput | null,
  envCallerId: string | null | undefined,
): string | null {
  if (maskingConfig?.is_active && isUsableOutboundCallerId(maskingConfig.outbound_caller_id)) {
    return normalizeOutboundCallerIdE164(maskingConfig.outbound_caller_id);
  }
  if (isUsableOutboundCallerId(envCallerId)) {
    return normalizeOutboundCallerIdE164(envCallerId);
  }
  return null;
}

/**
 * Pure capability projection for an authorised trip participant.
 * Call only after JWT auth + trip participant verification.
 * Does not perform DB access and never returns secrets or phone numbers.
 */
export function resolveTripCommunicationSsot(
  input: ResolveTripCommunicationSsotInput,
): TripCommunicationSsotResult {
  const maximumDurationSeconds = Math.max(
    60,
    input.settings?.maximum_call_duration_seconds ?? DEFAULT_MAX_DURATION_SECONDS,
  );

  const base: TripCommunicationSsotResult = {
    tripId: input.tripId,
    publicTripReference: input.publicTripReference?.trim() || undefined,
    serviceAreaId: input.serviceAreaId,
    actorRole: input.actorRole,
    participantAuthorised: input.participantAuthorised,
    communicationEnabled: false,
    allowed: false,
    maximumDurationSeconds,
    options: {
      voip: {
        enabled: false,
        ready: false,
        available: false,
        unavailableReason: TRIP_COMMUNICATION_SSOT.unavailableMessage,
      },
      callMasking: {
        enabled: false,
        ready: false,
        available: false,
        unavailableReason: TRIP_COMMUNICATION_SSOT.unavailableMessage,
      },
    },
  };

  if (!input.participantAuthorised || !input.actorRole) {
    return {
      ...base,
      blockedReason: TRIP_COMMUNICATION_SSOT.notAuthorisedMessage,
    };
  }

  if (!input.serviceAreaId) {
    return {
      ...base,
      blockedReason: TRIP_COMMUNICATION_SSOT.noServiceAreaMessage,
    };
  }

  if (!input.lifecycleEligible) {
    return {
      ...base,
      blockedReason: TRIP_COMMUNICATION_SSOT.unavailableMessage,
    };
  }

  if (!input.settings) {
    return {
      ...base,
      blockedReason: TRIP_COMMUNICATION_SSOT.disabledMessage,
    };
  }

  const communicationEnabled = Boolean(input.settings.is_enabled);
  if (!communicationEnabled) {
    return {
      ...base,
      communicationEnabled: false,
      blockedReason: TRIP_COMMUNICATION_SSOT.disabledMessage,
    };
  }

  const voipEnabled = Boolean(input.settings.voip_enabled);
  const callMaskingEnabled = Boolean(input.settings.call_masking_enabled);
  const livekitReady = Boolean(input.providerReadiness.livekitConfigured);
  const maskingCallerId = resolveMaskingCallerId(
    input.maskingConfig,
    input.providerReadiness.envCallerId,
  );
  const assignmentReady = Boolean(
    input.maskingConfig?.is_active && input.maskingConfig.provider_config_id,
  );
  const msg91Ready = Boolean(
    input.providerReadiness.msg91AuthConfigured &&
      maskingCallerId &&
      (assignmentReady || isUsableOutboundCallerId(input.providerReadiness.envCallerId)),
  );

  let voipUnavailable: string | undefined;
  if (!voipEnabled) {
    voipUnavailable = 'Call in app is not enabled for this service area.';
  } else if (!livekitReady) {
    voipUnavailable = 'Call in app is temporarily unavailable.';
  }

  let maskingUnavailable: string | undefined;
  if (!callMaskingEnabled) {
    maskingUnavailable = 'Secure phone call is not enabled for this service area.';
  } else if (!msg91Ready) {
    maskingUnavailable = 'Secure phone call is temporarily unavailable.';
  }

  const voipAvailable = voipEnabled && livekitReady;
  const callMaskingAvailable = callMaskingEnabled && msg91Ready;

  const methods = buildCommunicationMethods({
    is_enabled: communicationEnabled,
    voip_enabled: voipEnabled,
    call_masking_enabled: callMaskingEnabled,
    default_method: input.settings.default_method,
  });

  const defaultMethod = methods[0]?.method;

  const allowed = voipAvailable || callMaskingAvailable;

  return {
    tripId: input.tripId,
    publicTripReference: input.publicTripReference?.trim() || undefined,
    serviceAreaId: input.serviceAreaId,
    actorRole: input.actorRole,
    participantAuthorised: true,
    communicationEnabled: true,
    allowed,
    blockedReason: allowed ? undefined : TRIP_COMMUNICATION_SSOT.unavailableMessage,
    defaultMethod,
    maximumDurationSeconds,
    options: {
      voip: {
        enabled: voipEnabled,
        ready: livekitReady,
        available: voipAvailable,
        unavailableReason: voipAvailable ? undefined : voipUnavailable,
      },
      callMasking: {
        enabled: callMaskingEnabled,
        ready: msg91Ready,
        available: callMaskingAvailable,
        unavailableReason: callMaskingAvailable ? undefined : maskingUnavailable,
      },
    },
  };
}

/** Privacy-safe API projection (snake_case) for Edge Function responses. */
export function toTripCommunicationConfigApiPayload(
  result: TripCommunicationSsotResult,
): {
  trip_id: string;
  public_trip_reference: string | null;
  service_area_id: string | null;
  actor_role: TripCommunicationActorRole | null;
  communication_enabled: boolean;
  allowed: boolean;
  blocked_reason: string | null;
  default_method: TripCommunicationMethodType | null;
  maximum_duration_seconds: number;
  options: {
    voip: {
      enabled: boolean;
      ready: boolean;
      available: boolean;
      unavailable_reason: string | null;
    };
    call_masking: {
      enabled: boolean;
      ready: boolean;
      available: boolean;
      unavailable_reason: string | null;
    };
  };
  active_call: null;
  /** @deprecated Prefer options.*; kept for existing callers. */
  methods: TripCommunicationMethod[];
  calling_available: boolean;
  disabled_message: string | null;
  maximum_call_duration_seconds: number;
} {
  const methods = buildCommunicationMethods({
    is_enabled: result.communicationEnabled,
    voip_enabled: result.options.voip.enabled,
    call_masking_enabled: result.options.callMasking.enabled,
    default_method: result.defaultMethod ?? 'voip',
  }).filter((method) =>
    method.method === 'voip'
      ? result.options.voip.available
      : result.options.callMasking.available
  );

  // When module is on but a method is enabled+not ready, still list enabled methods
  // for chooser ordering; availability is authoritative via options.*.available.
  const orderedLabels = buildCommunicationMethods({
    is_enabled: result.communicationEnabled,
    voip_enabled: result.options.voip.enabled,
    call_masking_enabled: result.options.callMasking.enabled,
    default_method: result.defaultMethod ?? 'voip',
  });

  return {
    trip_id: result.tripId,
    public_trip_reference: result.publicTripReference ?? null,
    service_area_id: result.serviceAreaId,
    actor_role: result.actorRole,
    communication_enabled: result.communicationEnabled,
    allowed: result.allowed,
    blocked_reason: result.blockedReason ?? null,
    default_method: result.defaultMethod ?? null,
    maximum_duration_seconds: result.maximumDurationSeconds,
    options: {
      voip: {
        enabled: result.options.voip.enabled,
        ready: result.options.voip.ready,
        available: result.options.voip.available,
        unavailable_reason: result.options.voip.unavailableReason ?? null,
      },
      call_masking: {
        enabled: result.options.callMasking.enabled,
        ready: result.options.callMasking.ready,
        available: result.options.callMasking.available,
        unavailable_reason: result.options.callMasking.unavailableReason ?? null,
      },
    },
    active_call: null,
    methods: orderedLabels,
    calling_available: result.allowed,
    disabled_message: result.allowed
      ? null
      : (result.blockedReason ?? TRIP_COMMUNICATION_SSOT.disabledMessage),
    maximum_call_duration_seconds: result.maximumDurationSeconds,
  };
}

/** Server-only readiness flags from Edge env — never return secret values. */
export function readCommunicationProviderReadinessFromEnv(
  env: { get(key: string): string | undefined } = Deno.env,
): TripCommunicationProviderReadinessInput {
  const livekitConfigured = Boolean(
    env.get('LIVEKIT_URL')?.trim() &&
      env.get('LIVEKIT_API_KEY')?.trim() &&
      env.get('LIVEKIT_API_SECRET')?.trim(),
  );
  const msg91AuthConfigured = Boolean(env.get('MSG91_AUTH_KEY')?.trim());
  const envCallerId = env.get('MSG91_CALLER_ID')?.trim() || null;
  return { livekitConfigured, msg91AuthConfigured, envCallerId };
}
