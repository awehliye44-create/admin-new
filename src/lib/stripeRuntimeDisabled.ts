/**
 * Admin client Stripe retirement mirror.
 */
export const STRIPE_RETIRED = 'STRIPE_RETIRED';
export const LEGACY_STRIPE_EVIDENCE = 'LEGACY_STRIPE_EVIDENCE';

export function isStripeRuntimeDisabled(): boolean {
  return String(import.meta.env.VITE_STRIPE_RUNTIME_DISABLED ?? 'true').trim().toLowerCase() !== 'false';
}

export function isStripeProviderName(provider: string | null | undefined): boolean {
  return String(provider ?? '').trim().toLowerCase() === 'stripe';
}

export function resolveActivePaymentProviderName(
  raw: string | null | undefined,
): 'revolut' | 'bank_transfer' | 'unknown' | 'unavailable' {
  const p = String(raw ?? '').trim().toLowerCase();
  if (!p) return 'unavailable';
  if (p === 'stripe') return 'unavailable';
  if (p === 'revolut') return 'revolut';
  if (p === 'bank_transfer' || p === 'manual' || p === 'manual_bank') return 'bank_transfer';
  if (p === 'unknown') return 'unknown';
  return 'unavailable';
}
