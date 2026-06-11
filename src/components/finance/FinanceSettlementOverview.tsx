import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatPence } from '@/hooks/useDriverWallet';
import { toSettlementOverviewResponse, useFinanceReconciliation } from '@/hooks/useFinanceReconciliation';
import { AlertTriangle, Banknote, Building2, CreditCard, Users, Wallet } from 'lucide-react';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';

export type OnecabSettlementStatus =
  | 'calculated_only'
  | 'pending_stripe_settlement'
  | 'available_in_stripe_balance'
  | 'paid_to_onecab_bank'
  | 'reconciled';

export interface FinanceSettlementSummaryResponse {
  currency_code: string;
  customer_revenue_summary: {
    total_customer_revenue_pence: number;
    total_commissionable_revenue_pence: number;
    trip_count: number;
  };
  driver_earnings_summary: {
    driver_gross_earnings_pence: number;
    driver_net_earnings_pence: number;
  };
  onecab_commission_summary: {
    onecab_gross_commission_pence: number;
    stripe_fee_pence: number;
    onecab_net_pence: number;
    max_commission_at_15_percent_pence: number;
    commission_exceeds_cap: boolean;
    pending_stripe_settlement_pence: number;
    settlement_status: OnecabSettlementStatus;
    settlement_status_label: string;
    driver_payout_liability_pence: number;
  };
  stripe_platform_summary: {
    available_platform_balance_pence: number;
    pending_platform_balance_pence: number;
    unallocated_platform_cash_pence: number;
    error: string | null;
    note: string;
  };
  driver_payout_summary: {
    wallet_balance_pence: number;
    available_payout_pence: number;
    pending_payout_pence: number;
    paid_out_pence: number;
    failed_amount_today_pence: number;
    failure_reasons: Array<{ reason: string; amount_pence: number; count: number }>;
    safe_payout_amount_pence: number;
    waiting_for_stripe_funds: boolean;
  };
  reconciliation: {
    stripe_available_balance_pence: number;
    calculated_onecab_net_pence: number;
    available_driver_payable_pence: number;
    pending_transfers_pence: number;
    unallocated_platform_cash_pence: number;
    reserves_or_adjustments_pence: number;
    reconciles: boolean;
    mismatch_warning: string | null;
  };
  insufficient_funds_insight: {
    reason: string | null;
    requested_driver_payout_pence: number;
    stripe_available_balance_at_review_pence: number;
    calculated_onecab_net_pence: number;
    diagnoses: string[];
    why_commission_showed_but_payout_failed: string[];
  } | null;
}

function settlementBadgeVariant(status: OnecabSettlementStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'available_in_stripe_balance' || status === 'reconciled') return 'default';
  if (status === 'pending_stripe_settlement') return 'secondary';
  return 'outline';
}

export function FinanceSettlementOverview({ filter }: { filter?: ServiceAreaFinanceSelection }) {
  const { data: reconciliationData, isLoading, error, refetch, isFetching } = useFinanceReconciliation({ filter });

  const data = useMemo(
    () => (reconciliationData ? toSettlementOverviewResponse(reconciliationData) : undefined),
    [reconciliationData],
  );

  if (isLoading && !data) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">Loading settlement summary…</CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Settlement summary unavailable</AlertTitle>
        <AlertDescription>{(error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  if (!data) return null;

  const ccy = data.currency_code;
  const revenue = data.customer_revenue_summary;
  const driverEarn = data.driver_earnings_summary;
  const onecab = data.onecab_commission_summary;
  const driver = data.driver_payout_summary;
  const stripe = data.stripe_platform_summary;
  const recon = data.reconciliation;
  const insight = data.insufficient_funds_insight;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">Commission vs payout (trip-derived accounting)</h3>
          <p className="text-sm text-muted-foreground">
            ONECAB commission = 15% of commissionable revenue (includes Stripe fee). Stripe balance is platform cash, not commission.
          </p>
        </div>
        <button
          type="button"
          className="text-sm text-primary underline-offset-4 hover:underline"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {onecab.commission_exceeds_cap && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Commission exceeds 15% cap</AlertTitle>
          <AlertDescription>
            ONECAB gross commission {formatPence(onecab.onecab_gross_commission_pence, ccy)} exceeds max{' '}
            {formatPence(onecab.max_commission_at_15_percent_pence, ccy)} for{' '}
            {formatPence(revenue.total_commissionable_revenue_pence, ccy)} commissionable revenue.
            Check trip commission_pence — do not use Stripe balance or driver payable as commission.
          </AlertDescription>
        </Alert>
      )}

      {!recon.reconciles && recon.mismatch_warning && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{recon.mismatch_warning}</AlertTitle>
          <AlertDescription>
            Stripe available {formatPence(recon.stripe_available_balance_pence, ccy)} vs trip ONECAB net{' '}
            {formatPence(recon.calculated_onecab_net_pence, ccy)} + driver payable{' '}
            {formatPence(recon.available_driver_payable_pence, ccy)} + pending{' '}
            {formatPence(recon.pending_transfers_pence, ccy)}
          </AlertDescription>
        </Alert>
      )}

      {insight && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Why did ONECAB commission show today, but driver payout failed?</AlertTitle>
          <AlertDescription className="space-y-2">
            {insight.reason && <p className="font-medium">{insight.reason}</p>}
            <ul className="list-disc pl-5 text-sm space-y-1">
              {insight.why_commission_showed_but_payout_failed.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
            <div className="grid gap-1 text-xs text-muted-foreground pt-2">
              <span>Requested driver payout: {formatPence(insight.requested_driver_payout_pence, ccy)}</span>
              <span>Stripe available: {formatPence(insight.stripe_available_balance_at_review_pence, ccy)}</span>
              <span>Trip-derived ONECAB net: {formatPence(insight.calculated_onecab_net_pence, ccy)}</span>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CreditCard className="h-4 w-4" />
              1. Customer revenue
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total customer revenue</span>
              <span className="font-semibold">{formatPence(revenue.total_customer_revenue_pence, ccy)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Commissionable revenue</span>
              <span>{formatPence(revenue.total_commissionable_revenue_pence, ccy)}</span>
            </div>
            <p className="text-xs text-muted-foreground">{revenue.trip_count} trips in period</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              2. Driver earnings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Driver gross earnings</span>
              <span>{formatPence(driverEarn.driver_gross_earnings_pence, ccy)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Driver net earnings</span>
              <span className="font-medium">{formatPence(driverEarn.driver_net_earnings_pence, ccy)}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4" />
              3–5. ONECAB commission
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">ONECAB gross (15% incl. Stripe)</span>
              <span className="font-semibold">{formatPence(onecab.onecab_gross_commission_pence, ccy)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Max at 15% of commissionable</span>
              <span>{formatPence(onecab.max_commission_at_15_percent_pence, ccy)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Stripe processing fees</span>
              <span>−{formatPence(onecab.stripe_fee_pence, ccy)}</span>
            </div>
            <div className="flex justify-between border-t pt-2">
              <span className="text-muted-foreground">ONECAB net after Stripe</span>
              <span className="font-bold text-primary">{formatPence(onecab.onecab_net_pence, ccy)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Settlement</span>
              <Badge variant={settlementBadgeVariant(onecab.settlement_status)}>{onecab.settlement_status_label}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Banknote className="h-4 w-4" />
              6. Stripe platform balance
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Available (total platform cash)</span>
              <span className="font-semibold">{formatPence(stripe.available_platform_balance_pence, ccy)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pending settlement</span>
              <span>{formatPence(stripe.pending_platform_balance_pence, ccy)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Unallocated cash (after driver liability)</span>
              <span>{formatPence(stripe.unallocated_platform_cash_pence, ccy)}</span>
            </div>
            <p className="text-xs text-amber-600">{stripe.note}</p>
            {stripe.error && <p className="text-xs text-destructive">{stripe.error}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="h-4 w-4" />
              7. Driver payout liability
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Wallet balance</span>
              <span>{formatPence(driver.wallet_balance_pence, ccy)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Available payout</span>
              <span className="font-medium">{formatPence(driver.available_payout_pence, ccy)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Safe payout (min with Stripe)</span>
              <span>{formatPence(driver.safe_payout_amount_pence, ccy)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pending / failed today</span>
              <span>
                {formatPence(driver.pending_payout_pence, ccy)} /{' '}
                <span className={driver.failed_amount_today_pence > 0 ? 'text-destructive' : ''}>
                  {formatPence(driver.failed_amount_today_pence, ccy)}
                </span>
              </span>
            </div>
            {driver.waiting_for_stripe_funds && (
              <p className="text-xs text-amber-600">Waiting for Stripe funds before full payout.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
