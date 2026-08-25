/**
 * Payment Sessions page ownership lock.
 * PS UI must not render FR conclusions or settlement stamps.
 *
 * Run: npx vitest run src/lib/__tests__/paymentSessionsPageOwnershipLock.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const FORBIDDEN_LABELS = [
  '(FR)',
  'Open FR',
  'Matched Trips (FR)',
  'Capture Shortfall (FR)',
  'Gross Overcapture (FR)',
  'Refunded / Resolved Overcapture (FR)',
  'Outstanding Customer Overcharge (FR)',
  'Completed Trip Fare Total',
  'ONECAB Gross Commission (Settlement)',
  'ONECAB Net Commission (Settlement)',
  'Driver Net Total (Settlement)',
] as const;

describe('Payment Sessions page ownership', () => {
  const page = readSrc('src/pages/PaymentSessions.tsx');
  const kpi = readSrc('src/components/finance/PaymentSessionsKpiStrip.tsx');
  const combined = `${page}\n${kpi}`;

  it('keeps PS title and lifecycle subtitle', () => {
    expect(page).toContain('Payment Sessions (SSOT)');
    expect(page).toContain(
      'Canonical source for customer payment lifecycle: authorisation, capture, release, refund, provider fee, and provider state.',
    );
  });

  it('does not render FR or settlement labels on the PS page surface', () => {
    for (const label of FORBIDDEN_LABELS) {
      expect(combined.includes(label), `forbidden label still present: ${label}`).toBe(false);
    }
  });

  it('does not aggregate settlement stamps on the KPI strip', () => {
    expect(kpi).not.toContain('commission_pence');
    expect(kpi).not.toContain('driver_net_pence');
    expect(kpi).not.toContain('gross_onecab_commission');
    expect(kpi).not.toContain('driver_net_total');
    expect(kpi).not.toContain('completed_trip_fare');
    expect(kpi).not.toContain('capture_shortfall');
    expect(kpi).not.toContain('overcapture');
    expect(kpi).not.toContain('open_financial_reconciliation');
  });

  it('keeps PS-owned lifecycle KPI cards', () => {
    expect(kpi).toContain('Provider Captured Total');
    expect(kpi).toContain('Authorised Total');
    expect(kpi).toContain('Released Total');
    expect(kpi).toContain('Refunded Total');
    expect(kpi).toContain('Provider Fees');
    expect(kpi).toContain('Active Holds');
  });

  it('removes FR-only classification filters from the page', () => {
    expect(page).not.toContain('money_at_risk');
    expect(page).not.toContain('legacy_evidence');
    // URL cleanup of legacy deep-links is allowed; filter checkbox labels must be gone.
    expect(page).not.toMatch(/Checkbox[\s\S]{0,80}money_at_risk/);
    expect(page).not.toMatch(/>[\s\n]*money_at_risk[\s\n]*</);
    expect(page).not.toMatch(/>[\s\n]*legacy_evidence[\s\n]*</);
  });

  it('does not reference removed FR tab row collections (runtime crash lock)', () => {
    expect(page).not.toContain('completedTripRows');
    expect(page).not.toContain('matchingRows');
    expect(page).not.toContain('PaymentSessionsCompletedTripsTable');
    expect(page).not.toContain('PaymentSessionsMatchingTable');
  });

  it('keeps PS lifecycle filters', () => {
    expect(page).toContain('active_hold');
    expect(page).toContain('provider_fees_pending');
    expect(page).toContain('release_failed');
    expect(page).toContain('recovery_pending');
    expect(page).toContain('capture_failed');
  });
});

describe('Financial Reconciliation retains audit ownership', () => {
  const fr = readSrc('src/components/finance/FinancialReconciliationOverviewTab.tsx');

  it('still surfaces FR audit cards removed from Payment Sessions', () => {
    expect(fr).toContain('Matched Trips');
    expect(fr).toContain('Capture Shortfall');
    expect(fr).toContain('Gross Overcapture');
    expect(fr).toContain('Missing Payment Sessions');
    expect(fr).toContain('Trips with wallet mismatches');
    expect(fr).toContain('Reconciliation status');
  });
});
