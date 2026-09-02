/**
 * Payment Sessions page ownership lock.
 * PS UI must not render FR conclusions, driver credit, or settlement stamps.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const FORBIDDEN_LABELS = [
  'Driver credit exceptions',
  'Driver Credit',
  'Expected Credit',
  'Driver Net Total (Settlement)',
  'ONECAB Gross Commission',
] as const;

describe('Payment Sessions page ownership', () => {
  const page = readSrc('src/pages/PaymentSessions.tsx');
  const listPanel = readSrc('src/components/finance/PaymentSessionsListPanel.tsx');
  const combined = `${page}\n${listPanel}`;

  it('keeps PS title and lifecycle-only subtitle', () => {
    expect(page).toContain('Payment Sessions (SSOT)');
    expect(page).toContain('Customer payment lifecycle only');
    expect(page).toContain('Financial Reconciliation');
  });

  it('does not render driver credit or settlement on PS surface', () => {
    for (const label of FORBIDDEN_LABELS) {
      expect(combined.includes(label), `forbidden label: ${label}`).toBe(false);
    }
    expect(page).not.toContain('DriverCreditExceptionsBanner');
    expect(page).not.toContain('PaymentSessionsCompactCreditNotice');
    expect(page).not.toContain('driver_credit_exception');
  });

  it('uses exactly four lifecycle tabs', () => {
    expect(page).toContain('PAYMENT_SESSIONS_NAV_TABS');
    expect(page).toContain('captured: \'Captured\'');
    expect(page).toContain('released: \'Released\'');
    expect(page).toContain('refunded: \'Refunded\'');
    expect(page).toContain('recovery: \'Recovery\'');
    expect(page).not.toContain('provider_payments');
    expect(page).not.toContain('Active Holds');
    expect(page).not.toContain('Overview');
  });

  it('does not show legacy noisy header badges', () => {
    expect(page).not.toContain('Automatically Recovered');
    expect(page).not.toContain('Cancelled by Customer');
    expect(page).not.toContain('Test/Sandbox');
    expect(page).not.toContain('PARTIAL');
    expect(page).not.toContain('RED:');
  });

  it('shows summary cards and operational chips only', () => {
    expect(page).toContain('PaymentSessionsSummaryCards');
    expect(page).toContain('PaymentSessionsOperationalChips');
    expect(readSrc('src/components/finance/PaymentSessionsSummaryCards.tsx')).not.toContain('Authorised active total');
  });

  it('pins PLATFORM_COLLECTED service filter', () => {
    expect(page).toContain('financialModel="PLATFORM_COLLECTED"');
    expect(page).toContain('admin-refresh-payment-sessions');
  });

  it('lazy-mounts active tab list only', () => {
    expect(page).toContain('navTab === t');
    expect(page).not.toContain('PaymentSessionsOverviewTab');
  });
});

describe('Payment Sessions list backend SSOT', () => {
  const listSsot = readSrc('supabase/functions/_shared/adminPaymentSessionsListSSOT.ts');

  it('does not query driver_wallet_ledger or enrich driver credit', () => {
    expect(listSsot).not.toContain('driver_wallet_ledger');
    expect(listSsot).not.toContain('enrichPaymentSessionsWithDriverCredit');
    expect(listSsot).not.toContain('enrichCompletedTripsWithDriverCredit');
    expect(listSsot).not.toContain('buildPaymentSessionDriverCreditFields');
    expect(listSsot).not.toContain('aggregateDriverCreditExceptions');
  });

  it('ignores driver_credit_exceptions_only with FR redirect warning', () => {
    expect(listSsot).toContain('driver_credit_exceptions_only');
    expect(listSsot).toContain('Financial Reconciliation');
  });
});

describe('Payment Sessions list panel', () => {
  const listPanel = readSrc('src/components/finance/PaymentSessionsListPanel.tsx');

  it('keeps customer payment columns only', () => {
    expect(listPanel).toContain('Authorised');
    expect(listPanel).toContain('Captured');
    expect(listPanel).toContain('Provider fee');
    expect(listPanel).not.toContain('Driver Credit');
    expect(listPanel).not.toContain('expected_driver_credit');
    expect(listPanel).toContain('Financial Reconciliation');
  });

  it('wires row actions through props', () => {
    expect(listPanel).toContain('onAction={onAction}');
    expect(listPanel).not.toContain('onAction={runAction}');
  });
});
