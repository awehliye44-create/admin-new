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

/**
 * Authoritative maximum call duration for VoIP and call masking.
 * Do not scatter literal 240 elsewhere — import this constant.
 * Admin DB rows may differ; runtime enforcement always uses this value.
 */
export const TRIP_COMMUNICATION_MAX_DURATION_SECONDS = 240;

export const TRIP_COMMUNICATION_SSOT = {
  configFunction: 'trip-communication-config' as const,
  voipTokenFunction: 'livekit-voip-token' as const,
  voipCallEventFunction: 'voip-call-event' as const,
  voipWebhookFunction: 'livekit-webhook' as const,
  timeoutSweepFunction: 'trip-communication-timeout-sweep' as const,
  voipProvider: 'livekit' as const,
  callMaskingProvider: 'msg91' as const,
  maxDurationSeconds: TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
  maxDurationLabel: '4 minutes' as const,
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

/** Normalise any settings/admin value to the fixed 240s runtime SSOT. */
export function resolveEffectiveMaxCallDurationSeconds(
  _settingsValue?: number | null,
): number {
  return TRIP_COMMUNICATION_MAX_DURATION_SECONDS;
}

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

/** Safe Edge error_code values for trip communication. */
export const TRIP_COMMUNICATION_ERROR = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  TRIP_NOT_FOUND: 'TRIP_NOT_FOUND',
  NOT_TRIP_PARTICIPANT: 'NOT_TRIP_PARTICIPANT',
  ROLE_AMBIGUOUS: 'ROLE_AMBIGUOUS',
  COMMUNICATION_DISABLED: 'COMMUNICATION_DISABLED',
  COMMUNICATION_NOT_ALLOWED: 'COMMUNICATION_NOT_ALLOWED',
  VOIP_DISABLED: 'VOIP_DISABLED',
  VOIP_NOT_CONFIGURED: 'VOIP_NOT_CONFIGURED',
  CALL_ALREADY_ACTIVE: 'CALL_ALREADY_ACTIVE',
  CALL_NOT_FOUND: 'CALL_NOT_FOUND',
  CALL_EXPIRED: 'CALL_EXPIRED',
  CALL_NOT_JOINABLE: 'CALL_NOT_JOINABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_TERMINATION_FAILED: 'PROVIDER_TERMINATION_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
} as const;

/** Provider-neutral call session statuses exposed to authorised clients. */
export type TripCommunicationCallStatus =
  | 'requested'
  | 'ringing'
  | 'connecting'
  | 'active'
  | 'completed'
  | 'declined'
  | 'missed'
  | 'cancelled'
  | 'failed'
  | 'timed_out';

export const TRIP_COMMUNICATION_ACTIVE_STATUSES: ReadonlySet<TripCommunicationCallStatus> =
  new Set(['requested', 'ringing', 'connecting', 'active']);

export type TripCommunicationActiveCallProjection = {
  call_id: string;
  method: TripCommunicationMethodType;
  provider: 'livekit' | 'msg91';
  status: TripCommunicationCallStatus;
  started_at: string | null;
  connected_at: string | null;
  expires_at: string | null;
  remaining_seconds: number | null;
  join_allowed: boolean;
  end_allowed: boolean;
};

export type TripCommunicationErrorCode =
  (typeof TRIP_COMMUNICATION_ERROR)[keyof typeof TRIP_COMMUNICATION_ERROR];

/**
 * Authoritative assigned Driver for communication.
 * Prefers `confirmed_driver_id` (accept/assign SSOT), falls back to `driver_id`.
 * Never uses offer-only fields (`current_offer_driver_id`, etc.).
 */
export function resolveAuthoritativeAssignedDriverId(trip: {
  confirmed_driver_id?: string | null;
  driver_id?: string | null;
}): string | null {
  const confirmed = String(trip.confirmed_driver_id ?? '').trim();
  if (confirmed) return confirmed;
  const driverId = String(trip.driver_id ?? '').trim();
  return driverId || null;
}

/**
 * Resolve Driver/Customer role from JWT identity + trip assignment/ownership.
 * Does not trust client-supplied driver/customer IDs.
 */
export function resolveTripCommunicationParticipant(input: {
  authUserId: string;
  /** `drivers.id` for the authenticated user, if they have a driver profile. */
  driverProfileId: string | null | undefined;
  trip: {
    confirmed_driver_id?: string | null;
    driver_id?: string | null;
    passenger_id?: string | null;
  };
}):
  | {
    ok: true;
    role: TripCommunicationActorRole;
    assignedDriverId: string | null;
  }
  | { ok: false; errorCode: TripCommunicationErrorCode } {
  const authUserId = String(input.authUserId ?? '').trim();
  if (!authUserId) {
    return { ok: false, errorCode: TRIP_COMMUNICATION_ERROR.AUTH_REQUIRED };
  }

  const assignedDriverId = resolveAuthoritativeAssignedDriverId(input.trip);
  const driverProfileId = String(input.driverProfileId ?? '').trim() || null;
  const isDriver = Boolean(
    driverProfileId && assignedDriverId && driverProfileId === assignedDriverId,
  );
  const passengerId = String(input.trip.passenger_id ?? '').trim() || null;
  const isCustomer = Boolean(passengerId && passengerId === authUserId);

  if (isDriver && isCustomer) {
    return { ok: false, errorCode: TRIP_COMMUNICATION_ERROR.ROLE_AMBIGUOUS };
  }
  if (isDriver) {
    return { ok: true, role: 'driver', assignedDriverId };
  }
  if (isCustomer) {
    return { ok: true, role: 'customer', assignedDriverId };
  }
  return { ok: false, errorCode: TRIP_COMMUNICATION_ERROR.NOT_TRIP_PARTICIPANT };
}

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
  const maximumDurationSeconds = resolveEffectiveMaxCallDurationSeconds(
    input.settings?.maximum_call_duration_seconds,
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
    const voipEnabled = Boolean(input.settings?.voip_enabled);
    const callMaskingEnabled = Boolean(input.settings?.call_masking_enabled);
    return {
      ...base,
      communicationEnabled: Boolean(input.settings?.is_enabled),
      blockedReason: TRIP_COMMUNICATION_SSOT.unavailableMessage,
      defaultMethod: input.settings?.default_method,
      options: {
        voip: {
          enabled: voipEnabled,
          ready: Boolean(input.providerReadiness.livekitConfigured),
          available: false,
          unavailableReason: TRIP_COMMUNICATION_SSOT.unavailableMessage,
        },
        callMasking: {
          enabled: callMaskingEnabled,
          ready: false,
          available: false,
          unavailableReason: TRIP_COMMUNICATION_SSOT.unavailableMessage,
        },
      },
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
  const msg91Ready = Boolean(
    input.providerReadiness.msg91AuthConfigured && maskingCallerId,
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

/** Gate LiveKit token issuance from the SSOT capability projection. */
export function resolveVoipTokenGate(ssot: TripCommunicationSsotResult):
  | { ok: true }
  | {
    ok: false;
    errorCode: TripCommunicationErrorCode;
    message: string;
    status: number;
  } {
  if (!ssot.participantAuthorised) {
    return {
      ok: false,
      errorCode: TRIP_COMMUNICATION_ERROR.NOT_TRIP_PARTICIPANT,
      message: TRIP_COMMUNICATION_SSOT.notAuthorisedMessage,
      status: 403,
    };
  }
  if (!ssot.communicationEnabled) {
    return {
      ok: false,
      errorCode: TRIP_COMMUNICATION_ERROR.COMMUNICATION_DISABLED,
      message: TRIP_COMMUNICATION_SSOT.disabledMessage,
      status: 403,
    };
  }
  if (!ssot.options.voip.enabled) {
    return {
      ok: false,
      errorCode: TRIP_COMMUNICATION_ERROR.VOIP_DISABLED,
      message: 'Call in app is not enabled for this trip.',
      status: 403,
    };
  }
  if (!ssot.options.voip.ready) {
    return {
      ok: false,
      errorCode: TRIP_COMMUNICATION_ERROR.VOIP_NOT_CONFIGURED,
      message: 'Call in app is temporarily unavailable.',
      status: 503,
    };
  }
  if (!ssot.options.voip.available || !ssot.allowed) {
    return {
      ok: false,
      errorCode: TRIP_COMMUNICATION_ERROR.COMMUNICATION_NOT_ALLOWED,
      message: ssot.blockedReason ?? TRIP_COMMUNICATION_SSOT.unavailableMessage,
      status: 403,
    };
  }
  return { ok: true };
}

/**
 * Whether a new call may be started given SSOT + optional active session.
 * Active/non-expired sessions block a second concurrent call on the same trip.
 */
export function resolveCanStartNewCall(input: {
  allowed: boolean;
  activeCall: TripCommunicationActiveCallProjection | null;
  methodAvailable: boolean;
}): boolean {
  if (!input.allowed || !input.methodAvailable) return false;
  if (!input.activeCall) return true;
  return !TRIP_COMMUNICATION_ACTIVE_STATUSES.has(input.activeCall.status);
}

/** Privacy-safe API projection (snake_case) for Edge Function responses. */
export function toTripCommunicationConfigApiPayload(
  result: TripCommunicationSsotResult,
  activeCall: TripCommunicationActiveCallProjection | null = null,
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
      can_start: boolean;
    };
    call_masking: {
      enabled: boolean;
      ready: boolean;
      available: boolean;
      unavailable_reason: string | null;
      can_start: boolean;
    };
  };
  active_call: TripCommunicationActiveCallProjection | null;
  /** @deprecated Prefer options.*; kept for existing callers. */
  methods: TripCommunicationMethod[];
  calling_available: boolean;
  disabled_message: string | null;
  maximum_call_duration_seconds: number;
} {
  const orderedLabels = buildCommunicationMethods({
    is_enabled: result.communicationEnabled,
    voip_enabled: result.options.voip.enabled,
    call_masking_enabled: result.options.callMasking.enabled,
    default_method: result.defaultMethod ?? 'voip',
  });

  const voipCanStart = resolveCanStartNewCall({
    allowed: result.allowed,
    activeCall,
    methodAvailable: result.options.voip.available,
  });
  const maskingCanStart = resolveCanStartNewCall({
    allowed: result.allowed,
    activeCall,
    methodAvailable: result.options.callMasking.available,
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
        can_start: voipCanStart,
      },
      call_masking: {
        enabled: result.options.callMasking.enabled,
        ready: result.options.callMasking.ready,
        available: result.options.callMasking.available,
        unavailable_reason: result.options.callMasking.unavailableReason ?? null,
        can_start: maskingCanStart,
      },
    },
    active_call: activeCall,
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
  env: { get(key: string): string | undefined },
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
