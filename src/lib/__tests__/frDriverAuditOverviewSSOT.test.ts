import { describe, expect, it } from 'vitest';
import { aggregateFrDriverAuditOverview } from '@/lib/frDriverAuditOverviewSSOT';

describe('frDriverAuditOverviewSSOT', () => {
  it('9. Overview reports driver mismatch counts separately from settlement identity', () => {
    const overview = aggregateFrDriverAuditOverview(
      [
        { reconciliation_status: 'BALANCED' },
        { reconciliation_status: 'DRIVER_WALLET_MISMATCH' },
      ],
      { settlementIdentityBalanced: true },
    );
    expect(overview.drivers_balanced_count).toBe(1);
    expect(overview.driver_wallet_mismatches_count).toBe(1);
    expect(overview.overview_driver_audit_status).toBe('DRIVER_AUDIT_MISMATCH');
  });

  it('settlement balanced with provider unavailable → SETTLEMENT_BALANCED_DRIVER_AUDIT_PENDING', () => {
    const overview = aggregateFrDriverAuditOverview(
      [
        { reconciliation_status: 'BALANCED' },
        { reconciliation_status: 'PROVIDER_BALANCE_UNAVAILABLE' },
      ],
      { settlementIdentityBalanced: true },
    );
    expect(overview.provider_balance_unavailable_count).toBe(1);
    expect(overview.overview_driver_audit_status).toBe('SETTLEMENT_BALANCED_DRIVER_AUDIT_PENDING');
  });
});
