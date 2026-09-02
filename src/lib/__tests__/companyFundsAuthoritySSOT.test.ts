import { describe, expect, it } from 'vitest';
import {
  COMPANY_FUNDS_EXECUTION_ROLES,
  COMPANY_FUNDS_REJECTED_STAFF_ROLES,
  COMPANY_TRANSFER_MUTATION_ACTIONS,
  COMPANY_TRANSFER_READ_ONLY_ACTIONS,
  isCompanyFundsExecutionRole,
  isCompanyFundsRejectedStaffRole,
  isCompanyTransferMutationAction,
  isCompanyTransferReadOnlyAction,
} from '../../../shared/companyFundsAuthoritySSOT.ts';

describe('companyFundsAuthoritySSOT', () => {
  it('rejects customer_support and operator staff roles', () => {
    expect(isCompanyFundsRejectedStaffRole('customer_support')).toBe(true);
    expect(isCompanyFundsRejectedStaffRole('operator')).toBe(true);
    expect(isCompanyFundsRejectedStaffRole('finance_manager')).toBe(false);
  });

  it('allows finance execution roles', () => {
    for (const role of COMPANY_FUNDS_EXECUTION_ROLES) {
      expect(isCompanyFundsExecutionRole(role)).toBe(true);
    }
    expect(isCompanyFundsExecutionRole('customer_support')).toBe(false);
  });

  it('classifies company transfer mutation vs read-only actions', () => {
    expect(isCompanyTransferMutationAction('approve')).toBe(true);
    expect(isCompanyTransferMutationAction('create')).toBe(true);
    expect(isCompanyTransferReadOnlyAction('view_evidence')).toBe(true);
    expect(isCompanyTransferMutationAction('view_evidence')).toBe(false);
    expect(COMPANY_TRANSFER_MUTATION_ACTIONS.length).toBeGreaterThan(8);
    expect(COMPANY_TRANSFER_READ_ONLY_ACTIONS).toContain('view_evidence');
  });

  it('lists rejected roles explicitly', () => {
    expect(COMPANY_FUNDS_REJECTED_STAFF_ROLES).toContain('customer_support');
    expect(COMPANY_FUNDS_REJECTED_STAFF_ROLES).toContain('operator');
  });
});
