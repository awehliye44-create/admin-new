export type CommunicationDefaultMethod = 'voip' | 'call_masking';

export type CommunicationCallMethod = 'voip' | 'call_masking';

export interface ServiceAreaCommunicationSettings {
  service_area_id: string;
  /** @deprecated No runtime authority — VoIP is globally always enabled. */
  voip_enabled: boolean;
  call_masking_enabled: boolean;
  /** @deprecated No runtime authority — no default method / no fallback. */
  default_method: CommunicationDefaultMethod;
  maximum_call_duration_seconds: number;
  voip_rate_per_minute_minor: number;
  masked_call_rate_per_minute_minor: number;
  currency: string;
  /** @deprecated No runtime authority — communication module is always active. */
  is_enabled: boolean;
  voip_provider: string;
  outbound_caller_id?: string | null;
  config_version?: number;
}

export interface CallMaskingProviderConfig {
  id: string;
  provider: string;
  country_code: string;
  number_pool_id: string;
  outbound_caller_id: string;
  label: string;
  is_active: boolean;
}

export interface ServiceAreaCallMaskingConfig {
  service_area_id: string;
  provider_config_id: string | null;
  provider: string;
  country_code: string;
  number_pool_id: string;
  outbound_caller_id: string;
  is_active: boolean;
}

export interface CommunicationUsageMetrics {
  totalVoipMinutes: number;
  totalMaskedMinutes: number;
  estimatedCostMinor: number;
  callCount: number;
  averageDurationSeconds: number;
  successRate: number;
  failureRate: number;
}

export interface UnifiedCommunicationCallLog {
  id: string;
  occurred_at: string;
  trip_id: string | null;
  trip_label: string | null;
  driver_name: string | null;
  customer_name: string | null;
  method: CommunicationCallMethod;
  provider: string;
  status: string;
  duration_seconds: number | null;
  estimated_cost_minor: number;
  end_reason: string | null;
}

export function minutesToSeconds(minutes: number): number {
  return Math.max(1, Math.round(minutes * 60));
}

export function secondsToMinutes(seconds: number): number {
  return Math.round((seconds / 60) * 100) / 100;
}

/** VoIP is a global ONECAB capability — always available, never per-service-area. */
export const VOIP_GLOBALLY_ENABLED = true as const;

export interface ResolvedServiceAreaCommunication {
  voipAvailable: true;
  voipProvider: 'livekit';
  callMaskingAvailable: boolean;
  maskedOutboundCallerId: string | null;
  maximumCallDurationSeconds: number;
}

/**
 * Authoritative communication resolver.
 * VoIP = global + always enabled. Call Masking = per-service-area only.
 * No automatic fallback between the two methods.
 */
export function resolveServiceAreaCommunication(input: {
  call_masking_enabled?: boolean | null;
  maximum_call_duration_seconds?: number | null;
  masking?: { is_active?: boolean | null; outbound_caller_id?: string | null } | null;
}): ResolvedServiceAreaCommunication {
  const callMaskingAvailable = Boolean(input.call_masking_enabled) && Boolean(input.masking?.is_active);
  return {
    voipAvailable: true,
    voipProvider: 'livekit',
    callMaskingAvailable,
    maskedOutboundCallerId: callMaskingAvailable ? input.masking?.outbound_caller_id ?? null : null,
    maximumCallDurationSeconds: input.maximum_call_duration_seconds ?? 600,
  };
}

export function estimateCallCostMinor(
  durationSeconds: number | null,
  ratePerMinuteMinor: number,
): number {
  if (!durationSeconds || durationSeconds <= 0 || ratePerMinuteMinor <= 0) return 0;
  const minutes = durationSeconds / 60;
  return Math.round(minutes * ratePerMinuteMinor);
}

export function buildUsageMetrics(
  voipLogs: { duration_seconds: number | null; status: string }[],
  maskedLogs: { duration_seconds: number | null; status: string }[],
  voipRateMinor: number,
  maskedRateMinor: number,
): CommunicationUsageMetrics {
  const allLogs = [
    ...voipLogs.map((log) => ({ ...log, method: 'voip' as const })),
    ...maskedLogs.map((log) => ({ ...log, method: 'call_masking' as const })),
  ];

  const totalVoipSeconds = voipLogs.reduce((sum, log) => sum + (log.duration_seconds ?? 0), 0);
  const totalMaskedSeconds = maskedLogs.reduce((sum, log) => sum + (log.duration_seconds ?? 0), 0);

  let estimatedCostMinor = 0;
  for (const log of voipLogs) {
    estimatedCostMinor += estimateCallCostMinor(log.duration_seconds, voipRateMinor);
  }
  for (const log of maskedLogs) {
    estimatedCostMinor += estimateCallCostMinor(log.duration_seconds, maskedRateMinor);
  }

  const completed = allLogs.filter((log) =>
    ['completed', 'success', 'answered'].includes(log.status.toLowerCase()),
  ).length;
  const failed = allLogs.filter((log) =>
    ['failed', 'error', 'busy', 'no_answer', 'cancelled', 'canceled'].includes(log.status.toLowerCase()),
  ).length;
  const callCount = allLogs.length;
  const totalDuration = totalVoipSeconds + totalMaskedSeconds;

  return {
    totalVoipMinutes: Math.round((totalVoipSeconds / 60) * 10) / 10,
    totalMaskedMinutes: Math.round((totalMaskedSeconds / 60) * 10) / 10,
    estimatedCostMinor,
    callCount,
    averageDurationSeconds: callCount > 0 ? Math.round(totalDuration / callCount) : 0,
    successRate: callCount > 0 ? Math.round((completed / callCount) * 1000) / 10 : 0,
    failureRate: callCount > 0 ? Math.round((failed / callCount) * 1000) / 10 : 0,
  };
}

export const VOIP_PROVIDER_LABEL = 'LiveKit Cloud';
