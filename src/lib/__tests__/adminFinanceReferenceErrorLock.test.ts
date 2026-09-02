/**
 * Regression lock — admin finance pages must not ReferenceError at runtime
 * from missing imports or stale removed symbols.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function importBlock(src: string): string {
  const idx = src.search(/\n(?:export |function |const [A-Z])/);
  return idx > 0 ? src.slice(0, idx) : src.slice(0, 2500);
}

function mustImport(src: string, symbol: string, from: string | RegExp) {
  const header = importBlock(src);
  expect(header.includes(symbol), `expected import of ${symbol}`).toBe(true);
  if (typeof from === 'string') {
    expect(header.includes(from), `expected import from ${from}`).toBe(true);
  } else {
    expect(from.test(header), `expected import path matching ${from}`).toBe(true);
  }
}

function mustNotUse(src: string, pattern: RegExp, reason: string) {
  expect(pattern.test(src), reason).toBe(false);
}

describe('admin finance ReferenceError lock', () => {
  const tripHistory = readSrc('src/pages/TripHistory.tsx');
  const paymentSessions = readSrc('src/pages/PaymentSessions.tsx');
  const driverWallet = readSrc('src/pages/DriverWalletLedger.tsx');
  const payoutLedger = readSrc('src/pages/PayoutLedger.tsx');
  const financialReconciliation = readSrc('src/pages/FinancialReconciliation.tsx');

  it('Trip History imports recapture component and Alert when used', () => {
    expect(tripHistory).toContain('<TripHistoryShortfallRecaptureAction');
    mustImport(tripHistory, 'TripHistoryShortfallRecaptureAction', '@/components/trips/TripHistoryShortfallRecaptureAction');
    mustImport(tripHistory, 'Alert', '@/components/ui/alert');
    mustNotUse(tripHistory, /\badminNoShowStatusLabel\b/, 'use tripHistoryNoShowDisplayLabel / tripHistoryStatusLabel instead');
  });

  it('Payment Sessions uses providerRefreshActive not stale refreshProviderState', () => {
    mustImport(paymentSessions, 'Alert', '@/components/ui/alert');
    mustNotUse(
      paymentSessions,
      /\brefreshProviderState\b/,
      'rename to providerRefreshActive + triggerProviderListRefresh',
    );
  });

  it('Driver Wallet Ledger does not call aggregateDriverCreditExceptions on page surface', () => {
    mustImport(driverWallet, 'Alert', '@/components/ui/alert');
    mustImport(driverWallet, 'useQueryClient', '@tanstack/react-query');
    mustNotUse(
      driverWallet,
      /\baggregateDriverCreditExceptions\b/,
      'driver credit audit belongs in DriverWalletCreditAuditPanel / FR only',
    );
    mustNotUse(
      driverWallet,
      /DriverCreditExceptionsBanner/,
      'removed active red credit exception banner from wallet page',
    );
  });

  it('Payout Ledger imports useQueryClient when invalidating queries', () => {
    mustImport(payoutLedger, 'useQueryClient', '@tanstack/react-query');
    mustImport(payoutLedger, 'Alert', '@/components/ui/alert');
  });

  it('Driver Wallet hides adjustment UI until migrations deploy', () => {
    mustImport(driverWallet, 'driverWalletAdminAdjustmentsDeployed', 'driverWalletManualAdjustmentSSOT');
    expect(driverWallet).toContain('adjustmentsDeployed');
    expect(driverWallet).toMatch(/driverId && adjustmentsDeployed/);
  });
});
