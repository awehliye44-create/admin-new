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
  'supabase/functions/admin-driver-wallet-detail/index.ts',
  'supabase/functions/admin-payout-ledger/index.ts',
  'supabase/functions/admin-payment-holds-reconciliation/index.ts',
  'supabase/functions/_shared/adminPaymentSessionsListSSOT.ts',
  'supabase/functions/_shared/adminPaymentSessionsTripCompareSSOT.ts',
  'supabase/functions/_shared/adminPayoutLedgerListSSOT.ts',
  'supabase/functions/_shared/adminPayoutLedgerOverviewSSOT.ts',
  'supabase/functions/_shared/adminPayoutLedgerAccountsOverviewSSOT.ts',
  'supabase/functions/_shared/fetchDriverWalletPayoutSnapshot.ts',
  'supabase/functions/_shared/paymentHoldReconciliationSSOT.ts',
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
    expect(src).toContain('classifyTripForPlatformCollectedAdminPage');
    expect(src).toContain('cwExcludedTripIds');
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

  it('Payout Ledger batch/audit paths pass allowed_service_area_ids into nested lists', () => {
    const src = read('supabase/functions/_shared/adminPayoutLedgerListSSOT.ts');
    expect(src).toContain('allowed_service_area_ids: request.allowed_service_area_ids ?? null');
    expect(src).toContain('scopedDriverBatches');
    expect(src).toContain('platformDriverSet.has(row.driver_id)');
  });

  it('Payment holds loader accepts allowed_service_area_ids', () => {
    const holds = read('supabase/functions/_shared/paymentHoldReconciliationSSOT.ts');
    const list = read('supabase/functions/_shared/adminPaymentSessionsListSSOT.ts');
    const edge = read('supabase/functions/admin-payment-holds-reconciliation/index.ts');
    expect(holds).toContain('allowed_service_area_ids');
    expect(holds).toContain('classifyTripForPlatformCollectedAdminPage');
    expect(holds).toContain('orphan_payments');
    expect(holds).toMatch(/orphan[\s\S]*service_area_id/);
    expect(list).toContain('allowed_service_area_ids: request.allowed_service_area_ids ?? null');
    expect(edge).toContain('FINANCIAL_MODEL.PLATFORM_COLLECTED');
  });

  it('Driver Wallet summary excludes CW trip commission', () => {
    const src = read('supabase/functions/_shared/fetchDriverWalletSummary.ts');
    expect(src).toContain('.eq("financial_model", "PLATFORM_COLLECTED")');
  });

  it('Payout Ledger Settings DriverSelector pins PLATFORM_COLLECTED', () => {
    const panel = read('src/components/finance/PayoutLedgerSettingsPanel.tsx');
    const hook = read('src/hooks/useAdminDriverOptions.ts');
    expect(panel).toContain('financialModel="PLATFORM_COLLECTED"');
    expect(hook).toContain('financialModel');
    expect(hook).toContain('normaliseServiceAreaFinancialModel');
  });

  it('FR location filter intersects allowed PLATFORM service areas', () => {
    const tripQ = read('supabase/functions/_shared/financeReconciliationTripQuery.ts');
    const fr = read('supabase/functions/admin-finance-reconciliation/index.ts');
    expect(tripQ).toContain('allowedServiceAreaIds');
    expect(fr).toContain('allowedServiceAreaIds: modelScope.allowedServiceAreaIds');
    expect(fr).toContain('platformDriverIds');
  });

  it('admin-driver-wallet-detail rejects non-PLATFORM drivers', () => {
    const src = read('supabase/functions/admin-driver-wallet-detail/index.ts');
    expect(src).toContain('resolvePlatformCollectedDriverIds');
    expect(src).toContain('FINANCIAL_MODEL_VIOLATION');
  });

  it('DWL snapshot drops CW-linked ledger/settlement rows before KPIs', () => {
    const src = read('supabase/functions/_shared/fetchDriverWalletPayoutSnapshot.ts');
    expect(src).toContain('classifyTripForPlatformCollectedAdminPage');
    expect(src).toContain('cwExcludedTripIds');
    expect(src).toContain('rawLedger.filter');
    expect(src).toContain('rawSettlements.filter');
    expect(src).toContain('computeLedgerWalletBalancePence(ledger)');
    expect(src).not.toMatch(/computeLedgerWalletBalancePence\(rawLedger\)/);
  });

  it('FR Alerts finance-backend-audit-v1 scopes PLATFORM trips + drivers', () => {
    const src = read('supabase/functions/finance-backend-audit-v1/index.ts');
    expect(src).toContain('resolveServiceAreaFinancialScope');
    expect(src).toContain('resolvePlatformCollectedDriverIds');
    expect(src).toContain('.eq("financial_model", FINANCIAL_MODEL.PLATFORM_COLLECTED)');
    expect(src).toContain('scopedDriverIds');
  });

  it('weekly payout orchestrator + admin UI load PLATFORM drivers only', () => {
    const actions = read('src/components/finance/PayoutLedgerActions.tsx');
    const executor = read('supabase/functions/admin-execute-weekly-payout-occurrence/index.ts');
    const migration = read('supabase/migrations/20260832010000_weekly_payout_orchestrator_claim_cron.sql');
    expect(actions).toContain('admin-execute-weekly-payout-occurrence');
    expect(actions).not.toContain('admin-weekly-payout-scheduler');
    expect(migration).toContain('admin-execute-weekly-payout-occurrence');
    expect(migration).toContain('claim_weekly_payout_occurrence');
    for (const src of [executor]) {
      expect(src).toContain('resolvePlatformCollectedDriverIds');
      expect(src).toContain('FINANCIAL_MODEL.PLATFORM_COLLECTED');
      expect(src).toContain('.in("id", platformDriverIds)');
    }
  });

  it('payment holds trip map uses platform classifier (null+CW evidence excluded)', () => {
    const src = read('supabase/functions/_shared/paymentHoldReconciliationSSOT.ts');
    expect(src).toContain('classifyTripForPlatformCollectedAdminPage');
    expect(src).toMatch(/classifyTripForPlatformCollectedAdminPage[\s\S]*includeOnPlatformPage/);
  });

  it('admin-refresh-payment-sessions scopes PLATFORM only', () => {
    const edge = read('supabase/functions/admin-refresh-payment-sessions/index.ts');
    const page = read('src/pages/PaymentSessions.tsx');
    expect(edge).toContain('resolveServiceAreaFinancialScope');
    expect(edge).toContain('classifyTripForPlatformCollectedAdminPage');
    expect(edge).toContain('FINANCIAL_MODEL.PLATFORM_COLLECTED');
    expect(page).toContain('admin-refresh-payment-sessions');
    expect(page).toContain('service_area_id: serviceFilter.serviceAreaId');
  });

  it('Payout Ledger accounts overview KPIs scope payout_items to PLATFORM drivers', () => {
    const src = read('supabase/functions/_shared/adminPayoutLedgerAccountsOverviewSSOT.ts');
    expect(src).toContain('loadPayoutItemStatusTotals(supabase, platformDriverIds)');
    expect(src).toContain('.in("driver_id", [...platformDriverIds])');
    expect(src).toContain('resolvePlatformCollectedDriverIds');
  });

  it('DWL client ledger transactions filter CW-linked trip rows', () => {
    const src = read('src/hooks/useFinanceLedgerTransactions.ts');
    expect(src).toContain('classifyTripForPlatformCollectedAdminPage');
    expect(src).toContain('financial_model, commission_wallet_enabled');
  });

  it('FR first-load auto-selects PLATFORM service areas only', () => {
    const src = read('src/pages/FinancialReconciliation.tsx');
    expect(src).toContain('filterServiceAreasByFinancialModel');
    expect(src).toContain('FINANCIAL_MODEL.PLATFORM_COLLECTED');
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

  it('PLATFORM pages keep explicit PLATFORM only; drop null, CW, and CW-evidenced null', () => {
    const before = seeded.length;
    const after = filterTripsForPlatformCollectedAdminPage(seeded);
    expect(before).toBe(4);
    expect(after.map((t) => t.id)).toEqual(['p1']);
    expect(after).toHaveLength(1);
    expect(after.every((t) => t.id !== 'c1' && t.id !== 'n1' && t.id !== 'n2')).toBe(true);
  });

  it('Commission Wallet page keeps DRIVER_COLLECTED only', () => {
    const before = seeded.length;
    const after = filterTripsForCommissionWalletAdminPage(seeded);
    expect(before).toBe(4);
    expect(after.map((t) => t.id)).toEqual(['c1']);
    expect(after).toHaveLength(1);
  });

  it('classifies null financial_model as UNKNOWN (fail-closed)', () => {
    const c = classifyTripForPlatformCollectedAdminPage(nullLegacyPlatform);
    expect(c.includeOnPlatformPage).toBe(false);
    if (!c.includeOnPlatformPage) {
      expect(c.model).toBe(FINANCIAL_MODEL.UNKNOWN);
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
      // Fail-closed: null financial_model is UNKNOWN — not included in PLATFORM scope.
      expect(scope.allowedServiceAreaIds).toEqual(['uk']);
      expect(scope.allowedServiceAreaIds).not.toContain('af');
      expect(scope.allowedServiceAreaIds).not.toContain('legacy');
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
