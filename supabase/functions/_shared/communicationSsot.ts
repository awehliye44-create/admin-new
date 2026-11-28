/**
 * Service-area communication SSOT — shared across admin, customer, driver, and edge.
 */

export type CommunicationDefaultMethod = 'voip' | 'call_masking';

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
