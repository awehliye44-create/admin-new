/**
 * Service-area communication SSOT — shared validation helpers.
 */

export const COMMUNICATION_LOG_EVENTS = {
  CONFIG_SAVED: 'COMMUNICATION_CONFIG_SAVED',
  CONFIG_LOADED: 'COMMUNICATION_CONFIG_LOADED',
  CONFIG_MISSING: 'COMMUNICATION_CONFIG_MISSING',
  OUTBOUND_CALLER_ID_INVALID: 'OUTBOUND_CALLER_ID_INVALID',
} as const;

const E164_RE = /^\+[1-9]\d{6,14}$/;

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

/** Surfaced when no real MSG91 outbound E.164 is configured. */
export const OUTBOUND_CALLER_ID_NOT_CONFIGURED_MESSAGE =
  'Outbound caller ID is not configured for this service area. Set a real MSG91 E.164 in Admin → Communication (placeholders like +441908000000 are rejected).';

export function suggestOutboundCallerId(
  ...candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    const normalized = normalizeOutboundCallerIdE164(candidate);
    if (normalized && !isPlaceholderOutboundCallerId(normalized)) {
      return normalized;
    }
  }
  return '';
}
