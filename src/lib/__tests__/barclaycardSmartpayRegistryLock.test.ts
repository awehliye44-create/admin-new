/**
 * Barclaycard Smartpay — configuration readiness stub lock.
 * If these fail, fix the code — never delete or soften the lock.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LIVE_CUSTOMER_BOOKING_PROVIDERS,
  LIVE_DRIVER_PAYOUT_PROVIDERS,
  isCustomerBookingAdapterLive,
  isPayoutAdapterLive,
  resolveProviderBookingAdapterStatus,
} from '@/lib/customerPaymentWorkflow';
import {
  PROVIDER_SECRET_FIELDS,
  SUPPORTED_PAYMENT_PROVIDER_IDS,
} from '@/lib/paymentProviderConfig';

function readSrc(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

describe('Barclaycard Smartpay registry lock', () => {
  it('is listed in Admin supported providers with no speculative secrets', () => {
    expect(SUPPORTED_PAYMENT_PROVIDER_IDS).toContain('barclaycard_smartpay');
    expect(PROVIDER_SECRET_FIELDS.barclaycard_smartpay).toEqual([]);
  });

  it('is not a live booking or payout adapter', () => {
    expect(LIVE_CUSTOMER_BOOKING_PROVIDERS.has('barclaycard_smartpay')).toBe(false);
    expect(LIVE_DRIVER_PAYOUT_PROVIDERS.has('barclaycard_smartpay')).toBe(false);
    expect(isCustomerBookingAdapterLive('barclaycard_smartpay')).toBe(false);
    expect(isPayoutAdapterLive('barclaycard_smartpay')).toBe(false);
    expect(resolveProviderBookingAdapterStatus('barclaycard_smartpay', false, false)).toBe(
      'not_configured',
    );
  });

  it('keeps Revolut as the only live booking/payout provider', () => {
    expect([...LIVE_CUSTOMER_BOOKING_PROVIDERS]).toEqual(['revolut']);
    expect([...LIVE_DRIVER_PAYOUT_PROVIDERS]).toEqual(['revolut']);
  });

  it('migration seeds disabled test-mode non-primary stub with backend gates', () => {
    const migration = readSrc(
      'supabase/migrations/20270228130000_barclaycard_smartpay_payment_provider_registry.sql',
    );
    expect(migration).toContain("'barclaycard_smartpay'");
    expect(migration).toContain("'Barclaycard Smartpay'");
    expect(migration).toContain("'test'");
    expect(migration).toContain("'not_configured'");
    expect(migration).toMatch(/false,\s*\n\s*false,\s*\n\s*false,\s*\n\s*false/);
    expect(migration).toContain('supports_customer_payments = false');
    expect(migration).toContain('supports_driver_payouts = false');
    expect(migration).toContain('enforce_barclaycard_smartpay_readiness_stub');
    expect(migration).toContain('barclaycard_smartpay_not_ready');
    expect(migration).toContain('payment_provider_not_assignable');
    expect(migration).toContain('sync_service_area_payment_provider');
  });

  it('Edge registry mirrors Admin and excludes speculative credential map', () => {
    const edge = readSrc('supabase/functions/_shared/paymentProviders/types.ts');
    expect(edge).toContain('"barclaycard_smartpay"');
    expect(edge).toMatch(/barclaycard_smartpay:\s*\{\}/);
    expect(edge).toMatch(/barclaycard_smartpay:\s*\[\]/);
    expect(edge).not.toContain('BARCLAYCARD_SMARTPAY_SECRET');
    // admin-payment-providers GET filters by this list — undeployed Edge omits the card.
    const supported = edge.slice(
      edge.indexOf('SUPPORTED_PAYMENT_PROVIDER_IDS'),
      edge.indexOf('PROVIDER_SECRET_FIELD_LABELS'),
    );
    expect(supported).toContain('"barclaycard_smartpay"');
    expect(supported).toContain('"revolut"');
  });

  it('adapter factory never constructs Barclaycard', () => {
    const factory = readSrc('supabase/functions/_shared/paymentProviders/index.ts');
    expect(factory).toContain('provider !== "revolut"');
    expect(factory).not.toContain('barclaycard');
  });

  it('admin-payment-providers GET uses shared SUPPORTED registry (no separate filter that drops stubs)', () => {
    const edgeAdmin = readSrc('supabase/functions/admin-payment-providers/index.ts');
    expect(edgeAdmin).toContain('SUPPORTED_PAYMENT_PROVIDER_IDS.includes(c.provider as PaymentProviderId)');
    expect(edgeAdmin).toContain('disabled / not_configured stubs stay visible');
    // Visibility must not require is_enabled — disabled stubs remain listed.
    expect(edgeAdmin).not.toMatch(/\.filter\(\(c\)\s*=>\s*c\.is_enabled\)/);
  });

  it('service-area assignment excludes Barclaycard until readiness', () => {
    const sa = readSrc('src/components/payment/ServiceAreaPaymentGatewayConfig.tsx');
    expect(sa).toContain("Barclaycard Smartpay is intentionally omitted");
    const supportedBlock = sa.slice(
      sa.indexOf('const SUPPORTED_PROVIDERS'),
      sa.indexOf('function statusBadgeClass'),
    );
    expect(supportedBlock).not.toContain('barclaycard_smartpay');
    expect(supportedBlock).toContain("'revolut'");
  });

  it('overview counters use payment provider cards, not legacy admin_settings', () => {
    const cards = readSrc('src/components/integrations/IntegrationsOverviewCards.tsx');
    expect(cards).toContain('payment_provider_configs');
    expect(cards).not.toContain("setting_key\", \"integrations\"");
    expect(cards).not.toContain("eq(\"setting_key\", \"integrations\")");
    expect(cards).not.toContain("eq(\"setting_key\", \"api_keys\")");
    const page = readSrc('src/pages/PaymentProviders.tsx');
    expect(page).toContain('providers={data?.providers}');
  });

  it('does not change incremental auth or Revolut payment rules', () => {
    const revolutLive = readSrc('src/lib/customerPaymentWorkflow.ts');
    expect(revolutLive).toContain('LIVE_CUSTOMER_BOOKING_PROVIDERS = new Set<string>(["revolut"])');
    expect(revolutLive).toContain('LIVE_DRIVER_PAYOUT_PROVIDERS = new Set<string>(["revolut"])');
  });

  it('locks enable/primary UI for non-Revolut and blocks empty Smartpay secrets save', () => {
    const section = readSrc('src/components/integrations/PaymentProvidersSection.tsx');
    expect(section).toContain('const enableLocked = provider.provider !== "revolut"');
    expect(section).toContain('secretsUnavailable');
    expect(section).toContain('No speculative Smartpay credential fields are exposed');
    const edgeAdmin = readSrc('supabase/functions/admin-payment-providers/index.ts');
    expect(edgeAdmin).toContain(
      'if (provider !== "revolut" && (body.is_enabled === true || body.is_primary === true))',
    );
  });
});
