/**
 * Service-area communication SSOT — shared across admin, customer, driver, and edge.
 */

export type CommunicationDefaultMethod = 'voip' | 'call_masking';

export interface ServiceAreaCommunicationConfig {
  service_area_id: string;
  communication_enabled: boolean;
  voip_enabled: boolean;
  call_masking_enabled: boolean;
  default_method: CommunicationDefaultMethod;
  max_call_duration_seconds: number;
  voip_provider: string;
  call_masking_provider_config_id: string | null;
  outbound_caller_id: string | null;
  voip_rate_per_minute: number;
  call_masking_rate_per_minute: number;
  config_version: number;
  updated_at: string | null;
}

export const COMMUNICATION_LOG_EVENTS = {
  CONFIG_SAVED: 'COMMUNICATION_CONFIG_SAVED',
  CONFIG_LOADED: 'COMMUNICATION_CONFIG_LOADED',
  CONFIG_MISSING: 'COMMUNICATION_CONFIG_MISSING',
  ACTION_RENDERED: 'COMMUNICATION_ACTION_RENDERED',
  ACTION_HIDDEN: 'COMMUNICATION_ACTION_HIDDEN',
  VOIP_TOKEN_REQUESTED: 'VOIP_TOKEN_REQUESTED',
  VOIP_CALL_STARTED: 'VOIP_CALL_STARTED',
  VOIP_CALL_ENDED: 'VOIP_CALL_ENDED',
  MASKED_CALL_REQUESTED: 'MASKED_CALL_REQUESTED',
  MASKED_CALL_STARTED: 'MASKED_CALL_STARTED',
  MASKED_CALL_FAILED: 'MASKED_CALL_FAILED',
  OUTBOUND_CALLER_ID_INVALID: 'OUTBOUND_CALLER_ID_INVALID',
} as const;

const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Normalize and validate E.164 (+country, no spaces). */
export function normalizeOutboundCallerIdE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().replace(/\s+/g, '');
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('+') ? trimmed : `+${trimmed.replace(/^\+/, '')}`;
  if (!E164_RE.test(normalized)) return null;
  return normalized;
}

export function isPlaceholderOutboundCallerId(value: string | null | undefined): boolean {
  const normalized = normalizeOutboundCallerIdE164(value);
  return normalized === '+441908000000' || normalized === '+441234567890';
}

export function resolveOutboundCallerIdPriority(input: {
  serviceAreaOutboundCallerId?: string | null;
  maskingConfigOutboundCallerId?: string | null;
  providerCatalogOutboundCallerId?: string | null;
}): string | null {
  const fromServiceArea = normalizeOutboundCallerIdE164(input.serviceAreaOutboundCallerId);
  if (fromServiceArea && !isPlaceholderOutboundCallerId(fromServiceArea)) {
    return fromServiceArea;
  }

  const fromMasking = normalizeOutboundCallerIdE164(input.maskingConfigOutboundCallerId);
  if (fromMasking && !isPlaceholderOutboundCallerId(fromMasking)) {
    return fromMasking;
  }

  const fromCatalog = normalizeOutboundCallerIdE164(input.providerCatalogOutboundCallerId);
  if (fromCatalog && !isPlaceholderOutboundCallerId(fromCatalog)) {
    return fromCatalog;
  }

  return null;
}
