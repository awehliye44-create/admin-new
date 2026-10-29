import { describe, it, expect } from 'vitest';
import { resolvePageAccess } from '@/hooks/useStaffProfile';

const restricted = { is_owner: false };
const allPages = new Set(['roles', 'payout-ledger', 'service-areas', 'dashboard']);

describe('Stage 1 owner-only page access', () => {
  it('Owner can open Roles & Permissions', () => {
    expect(resolvePageAccess('roles', { isLoading: false, profile: { is_owner: true }, allowedPages: new Set() })).toBe(true);
  });
  it('Owner can open finance, payouts and service areas without explicit grants', () => {
    for (const slug of ['financial-reconciliation', 'payout-ledger', 'service-areas']) {
      expect(resolvePageAccess(slug, { isLoading: false, profile: { is_owner: true }, allowedPages: new Set() })).toBe(true);
    }
  });
  it('non-owner staff cannot open Roles & Permissions even if the page row is granted', () => {
    expect(resolvePageAccess('roles', { isLoading: false, profile: restricted, allowedPages: allPages })).toBe(false);
  });
  it('Roles & Permissions stays hidden while staff profile is loading', () => {
    expect(resolvePageAccess('roles', { isLoading: true, profile: null, allowedPages: new Set() })).toBe(false);
  });
  it('non-owner staff keep their granted operational pages', () => {
    expect(resolvePageAccess('payout-ledger', { isLoading: false, profile: restricted, allowedPages: allPages })).toBe(true);
    expect(resolvePageAccess('drivers', { isLoading: false, profile: restricted, allowedPages: allPages })).toBe(false);
  });
});
