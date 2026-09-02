/**
 * Payment Sessions lifecycle navigation SSOT tests.
 */
import { describe, expect, it } from 'vitest';
import type { AdminPaymentSessionsListRow } from '../../../shared/adminPaymentSessionsSSOT';
import {
  buildPaymentSessionsBackendRequest,
  buildPaymentSessionsNavPatch,
  buildPaymentSessionsOperationalChips,
  filterPaymentSessionsRowsForNav,
  isPaymentSessionsProviderPollBackendTab,
  needsClientSidePaymentSessionsNavFilter,
  normalizePaymentSessionsSearchParams,
  parsePaymentSessionsNavTab,
  parsePaymentSessionsOpChip,
  paymentSessionsLegacyTabRedirect,
  paymentSessionsNavUrl,
  resolvePaymentSessionsFilteredTotal,
} from '../../../shared/paymentSessionsNavigationSSOT.ts';

function row(partial: Partial<AdminPaymentSessionsListRow>): AdminPaymentSessionsListRow {
  return {
    id: 'r1',
    source: 'payment_sessions',
    payment_session_id: 'ps1',
    created_at: '2026-01-01T00:00:00Z',
    payment_provider: 'revolut',
    payment_method: 'card',
    purpose: 'RIDE_BOOKING',
    customer_payable_pence: 500,
    authorised_amount_pence: 550,
    provider_order_id: 'ord1',
    provider_state: 'pending',
    session_status: 'authorised',
    session_status_display: 'AUTHORISED',
    classification: 'GREEN',
    in_active_queue: true,
    action_policy: { can_release: true },
    ...partial,
  } as AdminPaymentSessionsListRow;
}

describe('paymentSessionsNavigationSSOT', () => {
  it('uses four lifecycle tabs with captured default', () => {
    expect(parsePaymentSessionsNavTab(null)).toBe('captured');
    expect(parsePaymentSessionsNavTab('captured')).toBe('captured');
    expect(parsePaymentSessionsNavTab('released')).toBe('released');
    expect(parsePaymentSessionsNavTab('refunded')).toBe('refunded');
    expect(parsePaymentSessionsNavTab('recovery')).toBe('recovery');
  });

  it('redirects legacy tabs to lifecycle tabs', () => {
    expect(paymentSessionsLegacyTabRedirect('overview')).toBe('/payment-sessions?tab=captured');
    expect(paymentSessionsLegacyTabRedirect('active_holds')).toBe(
      '/payment-sessions?tab=captured&opFilter=active_holds',
    );
    expect(paymentSessionsLegacyTabRedirect('captured')).toBeNull();
  });

  it('maps lifecycle tabs to backend slices', () => {
    expect(buildPaymentSessionsBackendRequest({ navTab: 'captured', base: {} }).tab).toBe('captured');
    expect(buildPaymentSessionsBackendRequest({ navTab: 'released', base: {} }).tab).toBe('released');
    expect(buildPaymentSessionsBackendRequest({ navTab: 'recovery', base: {} }).tab).toBe('failed_recovery');
  });

  it('hides zero-count operational chips', () => {
    const chips = buildPaymentSessionsOperationalChips({
      active_hold_count: 0,
      active_action_required_count: 0,
      recovery_pending_count: 0,
      automatically_recovering_count: 0,
      red: 0,
    } as never);
    expect(chips).toHaveLength(0);
  });

  it('shows operational chips only when count > 0', () => {
    const releaseChips = buildPaymentSessionsOperationalChips({
      actionable_release_pending_count: 3,
      verified_active_hold_count: 5,
      active_hold_count: 5,
      release_failed_count: 1,
      active_action_required_count: 1,
      manual_recovery_required_count: 2,
      recovery_pending_count: 2,
      red: 1,
    } as never);
    expect(releaseChips.map((c) => c.id)).toEqual(['release_pending', 'release_failed', 'recovery_required']);
    expect(releaseChips.find((c) => c.id === 'release_pending')?.label).toBe('Active releases');

    const holdChips = buildPaymentSessionsOperationalChips({
      actionable_release_pending_count: 0,
      verified_active_hold_count: 2,
      active_hold_count: 2,
      active_action_required_count: 0,
      manual_recovery_required_count: 0,
      recovery_pending_count: 0,
      red: 0,
    } as never);
    expect(holdChips.map((c) => c.id)).toEqual(['active_holds']);
    expect(holdChips[0]?.label).toBe('Active holds');
  });

  it('normalizes legacy URLs', () => {
    expect(
      normalizePaymentSessionsSearchParams(new URLSearchParams('tab=overview')),
    ).toBe('/payment-sessions?tab=captured');
    expect(
      normalizePaymentSessionsSearchParams(new URLSearchParams('tab=issues&issueFilter=active_holds')),
    ).toBe('/payment-sessions?tab=captured&opFilter=active_holds');
    expect(
      normalizePaymentSessionsSearchParams(new URLSearchParams('paymentSessionId=ps-1')),
    ).toBe('/payment-sessions?paymentSessionId=ps-1&tab=captured');
  });

  it('builds nav URLs with captured default', () => {
    expect(paymentSessionsNavUrl()).toBe('/payment-sessions?tab=captured');
    expect(paymentSessionsNavUrl({ tab: 'recovery', opFilter: 'recovery_required' }))
      .toBe('/payment-sessions?tab=recovery&opFilter=recovery_required');
  });

  it('filters recovery tab rows client-side when op chip is all', () => {
    expect(needsClientSidePaymentSessionsNavFilter({
      navTab: 'recovery',
      opChip: 'all',
      search: '',
    })).toBe(true);
  });

  it('polls provider on recovery backend tab', () => {
    expect(isPaymentSessionsProviderPollBackendTab('failed_recovery')).toBe(true);
    expect(isPaymentSessionsProviderPollBackendTab('captured')).toBe(false);
  });

  it('builds nav patch clearing op filter on tab change', () => {
    expect(buildPaymentSessionsNavPatch({ tab: 'released', opFilter: null })).toEqual({
      tab: 'released',
      opFilter: null,
    });
  });

  it('filters release failed rows via op chip', () => {
    const releaseFail = row({ attention_class: 'RELEASE_FAILED' });
    const ok = row({ session_status_display: 'CAPTURED', captured_amount_pence: 500, captured_at: 'x' });
    const filtered = filterPaymentSessionsRowsForNav([releaseFail, ok], 'recovery', 'release_failed');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].attention_class).toBe('RELEASE_FAILED');
  });

  it('resolves filtered totals from summary', () => {
    expect(resolvePaymentSessionsFilteredTotal({
      clientFiltered: false,
      navTab: 'captured',
      opChip: 'all',
      summary: { captured_count: 9 } as never,
      backendFilteredTotal: 9,
      displayRowCount: 9,
      hasSearch: false,
    })).toBe(9);
  });

  it('parses legacy issue params to op chips', () => {
    expect(parsePaymentSessionsOpChip('release_failed')).toBe('release_failed');
    expect(parsePaymentSessionsOpChip('recovery_pending')).toBe('recovery_required');
  });
});
