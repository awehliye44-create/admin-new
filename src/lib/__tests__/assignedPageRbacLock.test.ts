import { describe, it, expect } from 'vitest';
import { resolvePageAccess } from '@/hooks/useStaffProfile';
import {
  ADMIN_PAGE_CATALOG,
  getPermissionMatrixPageGroups,
  resolvePermissionSlugFromPath,
  isCatalogPageSlug,
} from '../../../shared/adminPageCatalogSSOT';

const owner = { is_owner: true };
const staff = { is_owner: false };

describe('assigned-page RBAC lock', () => {
  it('fails closed with no staff profile', () => {
    expect(
      resolvePageAccess('dashboard', {
        isLoading: false,
        profile: null,
        allowedPages: new Set(['dashboard']),
      }),
    ).toBe(false);
  });

  it('fails closed when failClosed is set (fetch error / inactive)', () => {
    expect(
      resolvePageAccess('dashboard', {
        isLoading: false,
        profile: staff,
        allowedPages: new Set(['dashboard']),
        failClosed: true,
      }),
    ).toBe(false);
  });

  it('denies all pages while loading (including previously open pages)', () => {
    expect(
      resolvePageAccess('dashboard', {
        isLoading: true,
        profile: staff,
        allowedPages: new Set(['dashboard']),
      }),
    ).toBe(false);
  });

  it('grants only the exact assigned slug — no alias expansion', () => {
    const frOnly = new Set(['financial-reconciliation']);
    expect(
      resolvePageAccess('financial-reconciliation', {
        isLoading: false,
        profile: staff,
        allowedPages: frOnly,
      }),
    ).toBe(true);
    expect(
      resolvePageAccess('customer-receivables', {
        isLoading: false,
        profile: staff,
        allowedPages: frOnly,
      }),
    ).toBe(false);
    expect(
      resolvePageAccess('annual-taxi-report', {
        isLoading: false,
        profile: staff,
        allowedPages: frOnly,
      }),
    ).toBe(false);
    expect(
      resolvePageAccess('onecab-revenue-profit', {
        isLoading: false,
        profile: staff,
        allowedPages: frOnly,
      }),
    ).toBe(false);
  });

  it('Customer Receivables uses its own canonical slug', () => {
    expect(isCatalogPageSlug('customer-receivables')).toBe(true);
    expect(resolvePermissionSlugFromPath('/customer-receivables')).toBe('customer-receivables');
    expect(
      resolvePageAccess('customer-receivables', {
        isLoading: false,
        profile: staff,
        allowedPages: new Set(['customer-receivables']),
      }),
    ).toBe(true);
  });

  it('legacy redirect paths normalize to canonical slugs (path resolution only)', () => {
    expect(resolvePermissionSlugFromPath('/payments')).toBe('payment-sessions');
    expect(resolvePermissionSlugFromPath('/driver-wallet')).toBe('driver-wallet-ledger');
    expect(resolvePermissionSlugFromPath('/payout-batches')).toBe('payout-ledger');
    expect(resolvePermissionSlugFromPath('/admin-settlements')).toBe('financial-reconciliation');
  });

  it('profile requires an explicit matrix assignment (not an open exception)', () => {
    expect(
      resolvePageAccess('profile', {
        isLoading: false,
        profile: staff,
        allowedPages: new Set(['dashboard']),
      }),
    ).toBe(false);
    expect(
      resolvePageAccess('profile', {
        isLoading: false,
        profile: staff,
        allowedPages: new Set(['profile']),
      }),
    ).toBe(true);
  });

  it('Owner retains full access including roles and ungranted pages', () => {
    expect(
      resolvePageAccess('roles', {
        isLoading: false,
        profile: owner,
        allowedPages: new Set(),
      }),
    ).toBe(true);
    expect(
      resolvePageAccess('customer-receivables', {
        isLoading: false,
        profile: owner,
        allowedPages: new Set(),
      }),
    ).toBe(true);
  });

  it('non-owners stay blocked from roles even with a DB grant', () => {
    expect(
      resolvePageAccess('roles', {
        isLoading: false,
        profile: staff,
        allowedPages: new Set(['roles', 'dashboard']),
      }),
    ).toBe(false);
  });

  it('unknown / non-catalog slugs are denied to non-owners', () => {
    expect(
      resolvePageAccess('not-a-real-page', {
        isLoading: false,
        profile: staff,
        allowedPages: new Set(['not-a-real-page']),
      }),
    ).toBe(false);
  });

  it('matrix groups include Customer Receivables, annual report, revenue, orphans', () => {
    const pages = getPermissionMatrixPageGroups().flatMap((g) => g.pages);
    for (const slug of [
      'customer-receivables',
      'annual-taxi-report',
      'onecab-revenue-profit',
      'dispatch',
      'service-area-pricing',
      'offers',
      'lost-property',
      'help-centre',
      'profile',
      'roles',
    ]) {
      expect(pages).toContain(slug);
    }
  });

  it('catalog has unique slugs', () => {
    const slugs = ADMIN_PAGE_CATALOG.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
