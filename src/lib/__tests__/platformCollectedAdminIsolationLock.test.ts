/**
 * Admin PLATFORM_COLLECTED finance page isolation lock.
 *
 * Proves the four PLATFORM pages never mix DRIVER_COLLECTED_COMMISSION_WALLET
 * revenue / commission-wallet ledger data, and that Commission Wallet owns CW only.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADMIN_PAGE_FINANCIAL_MODEL,
  FINANCIAL_MODEL,
  classifyTripForPlatformCollectedAdminPage,
  filterTripsForCommissionWalletAdminPage,
  filterTripsForPlatformCollectedAdminPage,
  paymentSessionIncludedOnPlatformCollectedAdminPage,
  resolveFinancialModelScope,
} from '../../../shared/financialModelScopeSSOT';

const ROOT = resolve(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const PLATFORM_PAGES = [
  'src/pages/PaymentSessions.tsx',
  'src/pages/FinancialReconciliation.tsx',
  'src/pages/DriverWalletLedger.tsx',
  'src/pages/PayoutLedger.tsx',
] as const;

const PLATFORM_HOOKS = [
  'src/hooks/useAdminPaymentSessions.ts',
  'src/hooks/useFinancialReconciliationSSOT.ts',
  'src/hooks/useDriverWalletSsot.ts',
  'src/hooks/useAdminPayoutLedger.ts',
] as const;

const PLATFORM_EDGE = [
  'supabase/functions/admin-payment-sessions/index.ts',
  'supabase/functions/admin-finance-reconciliation/index.ts',
  'supabase/functions/admin-driver-wallet-ssot/index.ts',
  'supabase/functions/admin-payout-ledger/index.ts',
  'supabase/functions/_shared/adminPaymentSessionsListSSOT.ts',
  'supabase/functions/_shared/adminPaymentSessionsTripCompareSSOT.ts',
  'supabase/functions/_shared/adminPayoutLedgerListSSOT.ts',
  'supabase/functions/_shared/adminPayoutLedgerOverviewSSOT.ts',
  'supabase/functions/_shared/adminPayoutLedgerAccountsOverviewSSOT.ts',
  'supabase/functions/_shared/fetchDriverWalletPayoutSnapshot.ts',
] as const;

describe('ADMIN_PAGE_FINANCIAL_MODEL map', () => {
  it('maps four PLATFORM pages + Commission Wallet', () => {
    expect(ADMIN_PAGE_FINANCIAL_MODEL['payment-sessions']).toBe(FINANCIAL_MODEL.PLATFORM_COLLECTED);
    expect(ADMIN_PAGE_FINANCIAL_MODEL['financial-reconciliation']).toBe(FINANCIAL_MODEL.PLATFORM_COLLECTED);
    expect(ADMIN_PAGE_FINANCIAL_MODEL['driver-wallet-ledger']).toBe(FINANCIAL_MODEL.PLATFORM_COLLECTED);
    expect(ADMIN_PAGE_FINANCIAL_MODEL['payout-ledger']).toBe(FINANCIAL_MODEL.PLATFORM_COLLECTED);
    expect(ADMIN_PAGE_FINANCIAL_MODEL['commission-wallet']).toBe(
      FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
    );
  });
});

describe('no commission_wallet_ledger on PLATFORM pages', () => {
  for (const rel of [...PLATFORM_PAGES, ...PLATFORM_HOOKS, ...PLATFORM_EDGE]) {
    it(`${rel} does not query driver_commission_wallet_ledger / commission_wallet_ledger`, () => {
      const src = read(rel);
      expect(src).not.toMatch(/driver_commission_wallet_ledger/);
      expect(src).not.toMatch(/from\(['"]commission_wallet_ledger['"]\)/);
      expect(src).not.toMatch(/\.from\(["']commission_wallet_ledger["']\)/);
    });
  }
});

describe('PLATFORM page UI scope filter', () => {
  for (const rel of PLATFORM_PAGES) {
    it(`${rel} pins ServiceAreaFinanceFilter to PLATFORM_COLLECTED`, () => {
      const src = read(rel);
      expect(src).toContain('financialModel="PLATFORM_COLLECTED"');
      expect(src).not.toContain('financialModel="DRIVER_COLLECTED_COMMISSION_WALLET"');
    });
  }

  it('Commission Wallet page is labelled Driver-Collected', () => {
    const src = read('src/pages/CommissionWallet.tsx');
    expect(src).toContain('Commission Wallet (Driver-Collected)');
    expect(src).not.toContain('financialModel="PLATFORM_COLLECTED"');
  });
});

describe('Edge SSOT PLATFORM boundaries', () => {
  it('Payment Sessions trip compare hard-filters financial_model PLATFORM_COLLECTED', () => {
    const src = read('supabase/functions/_shared/adminPaymentSessionsTripCompareSSOT.ts');
    expect(src).toContain('.eq("financial_model", FINANCIAL_MODEL.PLATFORM_COLLECTED)');
    expect(src).toContain('allowed_service_area_ids');
  });

  it('Payment Sessions list excludes null SA outside allowed PLATFORM set', () => {
    const src = read('supabase/functions/_shared/adminPaymentSessionsListSSOT.ts');
    expect(src).toContain('if (!row.service_area_id) continue');
    expect(src).toContain('allowed_service_area_ids');
  });

  it('FR trip query hard-filters PLATFORM_COLLECTED and scopes wallet drivers', () => {
    const tripQ = read('supabase/functions/_shared/financeReconciliationTripQuery.ts');
    const fr = read('supabase/functions/admin-finance-reconciliation/index.ts');
    expect(tripQ).toContain('.eq("financial_model", FINANCE_RECONCILIATION_TRIP_FINANCIAL_MODEL)');
    expect(fr).toContain('resolvePlatformCollectedDriverIds');
    expect(fr).not.toMatch(/driver_commission_wallet_ledger/);
  });

  it('Driver Wallet SSOT applies PLATFORM driver membership scope', () => {
    const src = read('supabase/functions/admin-driver-wallet-ssot/index.ts');
    expect(src).toContain('resolvePlatformCollectedDriverIds');
    expect(src).toContain('platformDriverIds');
    expect(src).toContain('.in("id", platformDriverIds)');
  });

  it('Payout Ledger passes allowed_service_area_ids into builders', () => {
    const index = read('supabase/functions/admin-payout-ledger/index.ts');
    const overview = read('supabase/functions/_shared/adminPayoutLedgerOverviewSSOT.ts');
    expect(index).toContain('allowed_service_area_ids: scope.allowedServiceAreaIds');
    expect(overview).toContain('allowed_service_area_ids');
    expect(overview).toContain('resolvePlatformCollectedDriverIds');
  });
});

describe('seeded row isolation (before/after counts)', () => {
  const platformTrip = {
    id: 'p1',
    financial_model: FINANCIAL_MODEL.PLATFORM_COLLECTED,
    commission_wallet_enabled: false,
  };
  const cwTrip = {
    id: 'c1',
    financial_model: FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
    commission_wallet_enabled: true,
  };
  const nullLegacyPlatform = {
    id: 'n1',
    financial_model: null,
    commission_wallet_enabled: false,
  };
  const nullWithCwEvidence = {
    id: 'n2',
    financial_model: null,
    commission_wallet_enabled: true,
  };

  const seeded = [platformTrip, cwTrip, nullLegacyPlatform, nullWithCwEvidence];

  it('PLATFORM pages keep PLATFORM + explicit legacy-null; drop CW and CW-evidenced null', () => {
    const before = seeded.length;
    const after = filterTripsForPlatformCollectedAdminPage(seeded);
    expect(before).toBe(4);
    expect(after.map((t) => t.id)).toEqual(['p1', 'n1']);
    expect(after).toHaveLength(2);
    expect(after.every((t) => t.id !== 'c1' && t.id !== 'n2')).toBe(true);
  });

  it('Commission Wallet page keeps DRIVER_COLLECTED only', () => {
    const before = seeded.length;
    const after = filterTripsForCommissionWalletAdminPage(seeded);
    expect(before).toBe(4);
    expect(after.map((t) => t.id)).toEqual(['c1']);
    expect(after).toHaveLength(1);
  });

  it('classifies legacy-null into explicit PLATFORM bucket', () => {
    const c = classifyTripForPlatformCollectedAdminPage(nullLegacyPlatform);
    expect(c.includeOnPlatformPage).toBe(true);
    if (c.includeOnPlatformPage) {
      expect(c.bucket).toBe('LEGACY_NULL_AS_PLATFORM_COLLECTED');
    }
  });

  it('Payment Sessions: CW SA + null SA without trip proof never leak', () => {
    const allowed = ['sa-platform'];
    const rows = [
      { service_area_id: 'sa-platform', trip_financial_model: FINANCIAL_MODEL.PLATFORM_COLLECTED },
      { service_area_id: 'sa-cw', trip_financial_model: FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET },
      { service_area_id: null, trip_financial_model: undefined },
      {
        service_area_id: null,
        trip_financial_model: FINANCIAL_MODEL.PLATFORM_COLLECTED,
      },
      {
        service_area_id: null,
        trip_financial_model: null,
        trip_commission_wallet_enabled: true,
      },
    ];
    const before = rows.length;
    const after = rows.filter((r) => paymentSessionIncludedOnPlatformCollectedAdminPage(r, allowed));
    expect(before).toBe(5);
    expect(after).toHaveLength(2);
    expect(after.every((r) => r.service_area_id === 'sa-platform' || r.trip_financial_model === FINANCIAL_MODEL.PLATFORM_COLLECTED)).toBe(true);
  });

  it('All Services scope never includes DRIVER_COLLECTED service areas', () => {
    const areas = [
      { id: 'uk', financial_model: FINANCIAL_MODEL.PLATFORM_COLLECTED },
      { id: 'af', financial_model: FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET },
      { id: 'legacy', financial_model: null },
    ];
    const scope = resolveFinancialModelScope(areas, FINANCIAL_MODEL.PLATFORM_COLLECTED, null);
    expect(scope.ok).toBe(true);
    if (scope.ok) {
      expect(scope.allowedServiceAreaIds.sort()).toEqual(['legacy', 'uk'].sort());
      expect(scope.allowedServiceAreaIds).not.toContain('af');
    }
    const cwScope = resolveFinancialModelScope(
      areas,
      FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
      null,
    );
    expect(cwScope.ok).toBe(true);
    if (cwScope.ok) {
      expect(cwScope.allowedServiceAreaIds).toEqual(['af']);
    }
  });
});
