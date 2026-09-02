/**
 * Payout Ledger overview company-funding cards — liquidity only.
 * Run: npm test -- src/lib/__tests__/payoutLedgerLiquidityCardsUI.test.tsx
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PayoutLedgerOverviewPanel } from '@/components/finance/PayoutLedgerOverviewPanel';
import {
  PAYOUT_LEDGER_FORBIDDEN_ACCOUNTING_CARD_TITLES,
  PAYOUT_LEDGER_LIQUIDITY_CARD_TITLES,
  computePayoutLedgerRealAvailableFundsPence,
  isPayoutLedgerForbiddenAccountingTitle,
} from '@/lib/payoutLedgerLiquidityCardsSSOT';
import type { AdminPayoutLedgerOverviewSummary } from '../../../shared/adminPayoutLedgerSSOT';
import type { CompanyBalanceSnapshot } from '../../../shared/companyBalanceSSOT';

const COMMISSION_PENCE = 5173; // live £51.73 accounting figure — must never render on overview

function baseOverview(
  overrides: Partial<AdminPayoutLedgerOverviewSummary> = {},
): AdminPayoutLedgerOverviewSummary {
  return {
    status: 'LIVE',
    service_area_id: null,
    currency: 'GBP',
    generated_at: '2026-09-02T08:45:44.008Z',
    driver_wallet_total_pence: 0,
    driver_available_pence: 0,
    driver_reserved_pence: 0,
    driver_pending_pence: 0,
    driver_debt_pence: 0,
    eligible_driver_count: 0,
    held_driver_count: 0,
    payout_scheduled_pence: 0,
    payout_processing_pence: 0,
    payout_paid_today_pence: 0,
    payout_paid_week_pence: 0,
    payout_paid_month_pence: 0,
    payout_failed_count: 0,
    company_balance_pence: 2176,
    company_available_for_transfer_pence: null,
    onecab_net_commission_available_pence: COMMISSION_PENCE,
    other_company_owned_cash_pence: 0,
    company_payables_pending_pence: 0,
    company_transfers_processing_pence: 0,
    company_transfers_paid_today_pence: 0,
    company_transfers_failed_count: 0,
    company_awaiting_approval_count: 0,
    next_driver_batch_amount_pence: 0,
    next_driver_batch_count: 0,
    next_scheduled_weekly_driver_payout_at: null,
    evidence_status: 'LIVE',
    unavailable_reason: null,
    section_errors: [],
    sources: {
      driver_wallet: 'Driver Wallet Ledger SSOT',
      driver_payouts: 'payout_items',
      company_balance: 'Company Balance SSOT',
      company_transfers: 'company_outgoing_transfers',
      payment_sessions_net_commission: 'Payment Sessions SSOT',
    },
    company_funding_audit: [
      {
        kind: 'NET_COMMISSION',
        amount_pence: COMMISSION_PENCE,
        label: 'Recognised ONECAB Net Commission',
        source: 'Payment Sessions SSOT',
      },
      {
        kind: 'UNATTRIBUTED_CASH',
        amount_pence: 100,
        label: 'Unclassified Company Cash',
        source: 'classification',
        status: 'RECONCILIATION_REQUIRED',
      },
    ],
    ...overrides,
  } as AdminPayoutLedgerOverviewSummary;
}

function baseBalance(
  overrides: Partial<CompanyBalanceSnapshot> = {},
): CompanyBalanceSnapshot {
  return {
    status: 'LIVE',
    status_code: 'AVAILABLE',
    currency: 'GBP',
    service_area_id: null,
    generated_at: '2026-09-02T08:45:46.696Z',
    last_verified_at: '2026-09-02T08:45:46.696Z',
    last_provider_sync_at: '2026-09-02T08:45:46.524Z',
    source_account_id: 'acct',
    source_account_label: 'Main',
    connection_status: 'AVAILABLE',
    connection_health: 'AVAILABLE',
    company_ledger_balance_pence: 2176,
    provider_cash_balance_pence: 2176,
    provider_current_balance_pence: 2176,
    provider_available_balance_pence: 2176,
    driver_liability_pence: 0,
    driver_payout_reserved_pence: 0,
    customer_refund_reserved_pence: null,
    approved_company_payables_pence: 0,
    operational_reserve_pence: null,
    company_available_for_transfer_pence: null,
    company_available_before_operational_reserve_pence: 2176,
    approved_payables_pending_pence: 0,
    driver_payout_funding_status: 'FULLY_FUNDED',
    funding_gap_pence: 0,
    evidence_status: 'CONFIRMED',
    unavailable_reason: null,
    source_label: 'Company Balance SSOT',
    excludes_driver_wallet: true,
    sections: {
      provider_balance: { status: 'AVAILABLE', amount_pence: 2176 },
      driver_liabilities: { status: 'AVAILABLE', amount_pence: 0 },
      reserved_driver_payouts: { status: 'AVAILABLE', amount_pence: 0 },
      approved_company_payables: { status: 'AVAILABLE', amount_pence: 0 },
      operational_reserve: {
        status: 'NOT_CONFIGURED',
        amount_pence: null,
        reason_code: 'OPERATIONAL_RESERVE_NOT_CONFIGURED',
      },
      company_transfer_available: {
        status: 'NOT_CONFIGURED',
        amount_pence: null,
        reason_code: 'OPERATIONAL_RESERVE_NOT_CONFIGURED',
      },
    },
    ...overrides,
  } as CompanyBalanceSnapshot;
}

describe('payoutLedgerLiquidityCardsSSOT', () => {
  it('lists exact forbidden accounting titles', () => {
    expect(PAYOUT_LEDGER_FORBIDDEN_ACCOUNTING_CARD_TITLES).toEqual([
      'ONECAB Net Commission Available',
      'Recognised ONECAB Net Commission',
      'Unclassified Company Cash',
    ]);
    for (const title of PAYOUT_LEDGER_FORBIDDEN_ACCOUNTING_CARD_TITLES) {
      expect(isPayoutLedgerForbiddenAccountingTitle(title)).toBe(true);
    }
    expect(isPayoutLedgerForbiddenAccountingTitle(
      PAYOUT_LEDGER_LIQUIDITY_CARD_TITLES.ONECAB_REAL_AVAILABLE_FUNDS,
    )).toBe(false);
  });

  it('computes real available from liquidity only — never commission', () => {
    expect(computePayoutLedgerRealAvailableFundsPence({
      company_available_before_operational_reserve_pence: 2065,
      operational_reserve_pence: 111,
      operational_reserve_configured: true,
      provider_available_balance_pence: 2176,
    })).toBe(1954);
    expect(computePayoutLedgerRealAvailableFundsPence({
      company_available_before_operational_reserve_pence: 2176,
      operational_reserve_pence: null,
      operational_reserve_configured: false,
      provider_available_balance_pence: 2176,
    })).toBeNull();
    // Commission pence must not influence the helper (not an input).
    expect(COMMISSION_PENCE).toBe(5173);
  });
});

describe('PayoutLedgerOverviewPanel company funding cards', () => {
  it('renders only liquidity cards and ignores backend commission fields', () => {
    render(
      <PayoutLedgerOverviewPanel
        overview={baseOverview()}
        companyBalance={baseBalance()}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );

    const funding = screen.getByTestId('payout-ledger-company-funding');
    const liquidity = within(funding).getByTestId('payout-ledger-liquidity-cards');
    const cards = within(liquidity).getAllByTestId('payout-ledger-metric-card');
    const titles = cards.map((el) => el.getAttribute('data-card-title') ?? '');

    expect(titles).toEqual([
      PAYOUT_LEDGER_LIQUIDITY_CARD_TITLES.REVOLUT_SOURCE_ACCOUNT_BALANCE,
      PAYOUT_LEDGER_LIQUIDITY_CARD_TITLES.PROTECTED_DRIVER_LIABILITIES,
      PAYOUT_LEDGER_LIQUIDITY_CARD_TITLES.RESERVED_DRIVER_PAYOUTS,
      PAYOUT_LEDGER_LIQUIDITY_CARD_TITLES.ONECAB_FUNDS_BEFORE_RESERVE,
      PAYOUT_LEDGER_LIQUIDITY_CARD_TITLES.OPERATIONAL_REFUND_RESERVE,
      PAYOUT_LEDGER_LIQUIDITY_CARD_TITLES.ONECAB_REAL_AVAILABLE_FUNDS,
    ]);

    for (const forbidden of PAYOUT_LEDGER_FORBIDDEN_ACCOUNTING_CARD_TITLES) {
      expect(within(funding).queryByText(forbidden)).toBeNull();
      expect(titles.includes(forbidden)).toBe(false);
    }

    // £51.73 / 5173p accounting figure must not appear on overview company funding.
    expect(funding.textContent ?? '').not.toMatch(/£51\.73/);
    expect(funding.textContent ?? '').not.toMatch(/\b51\.73\b/);
    expect(funding.textContent ?? '').not.toContain('Recognised ONECAB Net Commission');
    expect(funding.textContent ?? '').not.toContain('ONECAB Net Commission Available');
    expect(funding.textContent ?? '').not.toContain('Unclassified Company Cash');
    expect(funding.textContent ?? '').not.toMatch(/Classification status/i);
    expect(funding.textContent ?? '').not.toMatch(/Accounting diagnostics/i);
  });

  it('shows SETUP REQUIRED for missing reserve and locks Real Available', () => {
    render(
      <PayoutLedgerOverviewPanel
        overview={baseOverview()}
        companyBalance={baseBalance()}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );

    const funding = screen.getByTestId('payout-ledger-company-funding');
    expect(within(funding).getAllByText('SETUP REQUIRED').length).toBeGreaterThanOrEqual(1);
    expect(within(funding).getAllByText('OPERATIONAL_RESERVE_NOT_CONFIGURED').length)
      .toBeGreaterThanOrEqual(1);
    // Before Reserve / Revolut source still show liquidity (£21.76) while Real Available is locked.
    expect(within(funding).getAllByText('£21.76').length).toBeGreaterThanOrEqual(1);
    const realCard = within(funding).getByTestId('payout-ledger-liquidity-cards')
      .querySelector('[data-card-title="ONECAB Real Available Funds"]');
    expect(realCard?.textContent ?? '').toContain('SETUP REQUIRED');
    expect(realCard?.textContent ?? '').not.toMatch(/£51\.73/);
  });
});
