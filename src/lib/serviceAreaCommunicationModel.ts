export type CommunicationDefaultMethod = 'voip' | 'call_masking';

export type CommunicationCallMethod = 'voip' | 'call_masking';

export interface ServiceAreaCommunicationSettings {
  service_area_id: string;
  voip_enabled: boolean;
  call_masking_enabled: boolean;
  default_method: CommunicationDefaultMethod;
  maximum_call_duration_seconds: number;
  voip_rate_per_minute_minor: number;
  masked_call_rate_per_minute_minor: number;
  currency: string;
  is_enabled: boolean;
  voip_provider: string;
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

export function resolveDefaultMethod(
  voipEnabled: boolean,
  callMaskingEnabled: boolean,
  preferred: CommunicationDefaultMethod,
): CommunicationDefaultMethod {
  if (voipEnabled && callMaskingEnabled) return preferred;
  if (voipEnabled) return 'voip';
  if (callMaskingEnabled) return 'call_masking';
  return preferred;
}

export function validateCommunicationSettings(input: {
  voip_enabled: boolean;
  call_masking_enabled: boolean;
  default_method: CommunicationDefaultMethod;
}): string | null {
  if (input.default_method === 'voip' && !input.voip_enabled) {
    return 'VoIP must be enabled when default method is VoIP.';
  }
  if (input.default_method === 'call_masking' && !input.call_masking_enabled) {
    return 'Call Masking must be enabled when default method is Call Masking.';
  }
  return null;
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
