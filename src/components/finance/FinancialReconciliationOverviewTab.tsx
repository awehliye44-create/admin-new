import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatMoneyMinor } from '@/lib/formatMoneyMinor';
import { FinancialReconciliationRefreshBar } from '@/components/finance/FinancialReconciliationRefreshBar';
import type { FinancialReconciliationSSOTResult } from '@/hooks/useFinancialReconciliationSSOT';
import type { PlatformReconciliationKpis } from '@/hooks/useFinanceReconciliation';
import type { FinanceMoneyFormat } from '@/hooks/useFinanceReconciliationMoney';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import {
  ServiceAreaGatewayStatusPanel,
  type ServiceAreaGatewayStatusRow,
} from '@/components/finance/ServiceAreaGatewayStatusPanel';
import { PaymentHoldsFinanceAlertSummary } from '@/components/finance/PaymentHoldsFinanceAlertSummary';
import { payoutLedgerUrl } from '../../../shared/adminPayoutLedgerSSOT';

function KpiCard({ label, value, subtitle }: { label: string; value: string | number; subtitle?: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold mt-1">{value}</p>
        {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}

export function FinancialReconciliationOverviewTab({
  ssot,
  platformKpis,
  auditOverviewKpis,
  money,
  currencyGroups,
  serviceAreaGateways,
  readOnly = false,
  onRefresh,
  isRefreshing = false,
}: {
  ssot: FinancialReconciliationSSOTResult;
  platformKpis?: PlatformReconciliationKpis | null;
  auditOverviewKpis?: {
    completed_trip_fare_total_pence: number;
    confirmed_provider_captured_total_pence: number;
    refunded_total_pence: number;
    released_total_pence?: number;
    provider_fee_total_pence: number;
    onecab_gross_commission_pence: number;
    onecab_net_commission_pence: number | null;
    driver_net_total_pence: number;
    wallet_credits_total_pence: number;
    payouts_completed_pence: number;
    capture_shortfall_pence: number;
    overcapture_pence: number;
    missing_captures_count?: number;
    missing_releases_count?: number;
    missing_wallet_credits_count: number;
    payout_mismatches_count: number;
    balanced_trips_count: number;
    unresolved_mismatches_count: number;
    trip_count: number;
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
  serviceAreaGateways?: ServiceAreaGatewayStatusRow[];
  readOnly?: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  const fmt = money.fmt;
  const kpisUnavailable = platformKpis == null;
  const o = auditOverviewKpis;

  return (
    <div className="space-y-4">
      <PaymentHoldsFinanceAlertSummary />
      <p className="text-xs text-muted-foreground">
        Audit totals only — customer capture from Payment Sessions, wallet from Driver Wallet Ledger, payouts from Payout Ledger.
        Bank transfer lifecycle:{' '}
        <Link to={payoutLedgerUrl()} className="underline">
          Open Payout Ledger
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
          Financial Reconciliation compares authoritative SSOTs. It never owns payment, wallet, or payout truth.
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          label="Completed trips paid total"
          value={o ? fmt(o.completed_trip_fare_total_pence) : '—'}
          subtitle="Payment Sessions expected capture"
        />
        <KpiCard
          label="Confirmed provider captured"
          value={o ? fmt(o.confirmed_provider_captured_total_pence) : '—'}
          subtitle="Payment Sessions"
        />
        <KpiCard label="Refunded total" value={o ? fmt(o.refunded_total_pence) : '—'} subtitle="Payment Sessions" />
        <KpiCard
          label="Released total"
          value={o?.released_total_pence == null ? '—' : fmt(o.released_total_pence)}
          subtitle="Payment Sessions"
        />
        <KpiCard label="Provider fee total" value={o ? fmt(o.provider_fee_total_pence) : '—'} subtitle="Payment Sessions" />
        <KpiCard label="ONECAB gross commission" value={o ? fmt(o.onecab_gross_commission_pence) : '—'} />
        <KpiCard
          label="ONECAB net commission"
          value={o?.onecab_net_commission_pence == null ? 'Pending fee' : fmt(o.onecab_net_commission_pence)}
        />
        <KpiCard label="Driver net total" value={o ? fmt(o.driver_net_total_pence) : '—'} />
        <KpiCard label="Wallet credits total" value={o ? fmt(o.wallet_credits_total_pence) : '—'} />
        <KpiCard label="Payouts completed" value={o ? fmt(o.payouts_completed_pence) : '—'} />
        <KpiCard
          label="Capture shortfall"
          value={o ? fmt(o.capture_shortfall_pence) : '—'}
          subtitle="Payment Sessions classification"
        />
        <KpiCard
          label="Overcapture"
          value={o ? fmt(o.overcapture_pence) : '—'}
          subtitle="Payment Sessions classification"
        />
        <KpiCard label="Missing captures" value={o?.missing_captures_count ?? '—'} subtitle="Payment Sessions" />
        <KpiCard label="Missing releases" value={o?.missing_releases_count ?? '—'} subtitle="Payment Sessions" />
        <KpiCard label="Missing wallet credits" value={o?.missing_wallet_credits_count ?? '—'} />
        <KpiCard label="Payout mismatches" value={o?.payout_mismatches_count ?? '—'} />
        <KpiCard label="Balanced trips" value={o?.balanced_trips_count ?? '—'} />
        <KpiCard label="Unresolved mismatches" value={o?.unresolved_mismatches_count ?? '—'} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Reconciliation status"
          value={ssot.summary?.reconciliation_check?.status ?? '—'}
        />
        <KpiCard
          label="Period customer captured (SSOT)"
          value={fmt(ssot.summary?.customer_revenue?.card_customer_revenue_pence)}
          subtitle="Payment Sessions captures"
        />
        <KpiCard
          label="Period provider fees (SSOT)"
          value={fmt(ssot.summary?.onecab_money?.provider_processing_fee_pence)}
        />
        <KpiCard
          label="Period commission (SSOT)"
          value={fmt(ssot.summary?.onecab_money?.onecab_gross_commission_pence)}
        />
        <KpiCard
          label="Period driver payable (SSOT)"
          value={fmt(ssot.summary?.driver_money?.card_driver_payable_pence)}
        />
        <KpiCard
          label="Ledger wallet balance"
          value={fmt(ssot.summary?.driver_money?.driver_wallet_balance_pence)}
          subtitle="From driver_wallet_ledger"
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
                  <p className="text-sm">Revenue: {formatMoneyMinor(group.customer_revenue_pence, group.currency_code, 'en-GB', group.currency_minor_unit)}</p>
                  <p className="text-sm">Driver net: {formatMoneyMinor(group.driver_net_pence, group.currency_code, 'en-GB', group.currency_minor_unit)}</p>
                  <p className="text-sm">Commission: {formatMoneyMinor(group.commission_pence, group.currency_code, 'en-GB', group.currency_minor_unit)}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ) : null}

      {serviceAreaGateways && serviceAreaGateways.length > 0 ? (
        <ServiceAreaGatewayStatusPanel rows={serviceAreaGateways} />
      ) : null}

      <p className="text-sm font-medium">Sync integrity</p>
      {kpisUnavailable ? (
        <Alert variant="destructive">
          <AlertTitle>Sync KPIs unavailable</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>Driver sync KPIs could not be loaded. Select a service area and refresh.</p>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              Refresh
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Balanced Drivers" value={platformKpis?.balanced_drivers ?? 0} />
          <KpiCard label="Failed Payouts" value={fmt(platformKpis?.failed_payouts_pence)} />
          <KpiCard label="Provider-only Records" value={platformKpis?.provider_only_records ?? platformKpis?.stripe_only_records ?? 0} />
          <KpiCard label="Ledger-only Records" value={platformKpis?.ledger_only_records ?? 0} />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Trip earnings and settlement calculations:{' '}
        <Link to="/trip-history" className="underline">Trip History (Trip Settlement SSOT)</Link>
        {' · '}
        <Link to="/financial-reconciliation?tab=drivers" className="underline">Drivers</Link>
        {' · '}
        <Link to={payoutLedgerUrl()} className="underline">Payout Ledger</Link>
      </p>
    </div>
  );
}
