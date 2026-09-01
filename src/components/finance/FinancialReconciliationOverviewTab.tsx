import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { formatMoneyMinor } from '@/lib/formatMoneyMinor';
import { FinancialReconciliationRefreshBar } from '@/components/finance/FinancialReconciliationRefreshBar';
import type { FinancialReconciliationSSOTResult } from '@/hooks/useFinancialReconciliationSSOT';
import type { FinanceMoneyFormat } from '@/hooks/useFinanceReconciliationMoney';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import { fetchOnecabProfitSsot } from '@/hooks/financeReconciliationApi';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { payoutLedgerUrl } from '../../../shared/adminPayoutLedgerSSOT';
import { financialReconciliationIssuesTabUrl } from '@/lib/financialReconciliationRoutes';
import { hasFrPeriodAuditKpis } from '../../../shared/frIssuesSSOT';

function KpiCard({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string | number;
  subtitle?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold mt-1">{value}</p>
        {subtitle ? <div className="text-xs text-muted-foreground mt-1">{subtitle}</div> : null}
      </CardContent>
    </Card>
  );
}

export function FinancialReconciliationOverviewTab({
  ssot,
  auditOverviewKpis,
  money,
  currencyGroups,
  filter,
  from,
  to,
  openIssueCount = 0,
  readOnly = false,
  onRefresh,
  isRefreshing = false,
}: {
  ssot: FinancialReconciliationSSOTResult;
  auditOverviewKpis?: {
    trip_count?: number;
    confirmed_provider_captured_total_pence: number;
    driver_net_total_pence: number;
    onecab_gross_commission_pence: number;
    provider_fee_total_pence: number;
    settlement_identity_variance_pence?: number | null;
    unresolved_mismatches_count: number;
    driver_credit_exception_trip_count?: number;
    driver_credit_exception_difference_pence?: number;
  } | null;
  money: FinanceMoneyFormat;
  currencyGroups?: Array<{
    currency_code: string;
    currency_symbol: string;
    currency_minor_unit: number;
    customer_revenue_pence: number;
    driver_net_pence: number;
    commission_pence: number;
    trip_count: number;
  }>;
  filter: ServiceAreaFinanceSelection;
  from?: string;
  to?: string;
  openIssueCount?: number;
  readOnly?: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  const fmt = money.fmt;
  const o = auditOverviewKpis;
  const summary = ssot.summary;
  const useAuditKpis = hasFrPeriodAuditKpis(o);

  const profitQuery = useQuery({
    queryKey: ['fr-overview-profit-ssot', filter, from, to],
    queryFn: () => {
      const fromDate = from ? new Date(`${from}T00:00:00`) : new Date();
      const toDate = to ? new Date(`${to}T23:59:59`) : new Date();
      return fetchOnecabProfitSsot(fromDate, toDate, filter);
    },
    enabled: Boolean(from && to && (filter.regionId || filter.serviceAreaId)),
    staleTime: 60_000,
  });

  const promotionSubsidyPence = profitQuery.data?.promotion_subsidy_pence ?? null;

  const reconciliationDifference =
    useAuditKpis && o?.settlement_identity_variance_pence != null
      ? o.settlement_identity_variance_pence
      : summary?.reconciliation_check?.delta_pence ?? summary?.reconciliation_check?.variance_pence ?? null;

  const openIssues = openIssueCount > 0
    ? openIssueCount
    : (useAuditKpis ? (o?.unresolved_mismatches_count ?? 0) : 0);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Period totals for the selected service area and date range
        {from && to ? ` (${from} – ${to})` : ''}. Bank transfers:{' '}
        <Link to={payoutLedgerUrl()} className="underline">
          Payout Ledger
        </Link>
      </p>

      <FinancialReconciliationRefreshBar
        badge={isRefreshing ? 'REFRESHING' : ssot.badge}
        lastSyncedAt={ssot.lastSyncedAt}
        isRefreshing={isRefreshing}
        readOnly={readOnly}
        onRefresh={onRefresh}
        label="Platform reconciliation overview"
      />

      <div className="flex items-center gap-2">
        <FinanceSSOTBadge badge={ssot.badge} />
        <span className="text-xs text-muted-foreground">
          Read-only audit — capture, wallet credits, and payouts are owned elsewhere.
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <KpiCard
          label="Captured revenue"
          value={useAuditKpis ? fmt(o!.confirmed_provider_captured_total_pence) : fmt(summary?.customer_revenue?.card_customer_revenue_pence)}
          subtitle="Payment Sessions"
        />
        <KpiCard
          label="Driver earnings"
          value={useAuditKpis ? fmt(o!.driver_net_total_pence) : fmt(summary?.driver_money?.card_driver_payable_pence)}
          subtitle="Period trip stamps"
        />
        <KpiCard
          label="ONECAB commission"
          value={useAuditKpis ? fmt(o!.onecab_gross_commission_pence) : fmt(summary?.onecab_money?.onecab_gross_commission_pence)}
        />
        <KpiCard
          label="Promotion subsidy"
          value={
            promotionSubsidyPence == null
              ? profitQuery.isLoading
                ? '…'
                : '—'
              : fmt(promotionSubsidyPence)
          }
          subtitle="Platform-funded promotions"
        />
        <KpiCard
          label="Provider fees"
          value={useAuditKpis ? fmt(o!.provider_fee_total_pence) : fmt(summary?.onecab_money?.provider_processing_fee_pence)}
          subtitle="Payment Sessions"
        />
        <KpiCard
          label="Reconciliation difference"
          value={reconciliationDifference == null ? '—' : fmt(reconciliationDifference)}
          subtitle="Settlement identity variance"
        />
        <KpiCard
          label="Open issues"
          value={openIssues}
          subtitle={(
            <>
              {!useAuditKpis && openIssues === 0 ? (
                <span className="block">Open Issues tab to load period counts.</span>
              ) : null}
              <Link to={financialReconciliationIssuesTabUrl()} className="underline">
                View in Issues tab
              </Link>
            </>
          )}
        />
      </div>

      {money.isMixedCurrency && currencyGroups && currencyGroups.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Totals by currency</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {currencyGroups.map((group) => (
              <Card key={group.currency_code}>
                <CardContent className="pt-4 pb-4 space-y-1">
                  <p className="text-xs text-muted-foreground">{group.currency_code} · {group.trip_count} trips</p>
                  <p className="text-sm">
                    Revenue:{' '}
                    {formatMoneyMinor(group.customer_revenue_pence, group.currency_code, 'en-GB', group.currency_minor_unit)}
                  </p>
                  <p className="text-sm">
                    Driver net:{' '}
                    {formatMoneyMinor(group.driver_net_pence, group.currency_code, 'en-GB', group.currency_minor_unit)}
                  </p>
                  <p className="text-sm">
                    Commission:{' '}
                    {formatMoneyMinor(group.commission_pence, group.currency_code, 'en-GB', group.currency_minor_unit)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
