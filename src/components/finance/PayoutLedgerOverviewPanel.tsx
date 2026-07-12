/**
 * Payout Ledger Overview widgets — display-only of backend DTO.
 * Never sums financial totals in React.
 */
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatNullablePence } from '@/lib/formatNullablePence';
import type { AdminPayoutLedgerOverviewSummary } from '../../../shared/adminPayoutLedgerSSOT';
import type { CompanyBalanceSnapshot } from '../../../shared/companyBalanceSSOT';
import { COMPANY_BALANCE_ERROR } from '../../../shared/companyBalanceSSOT';
import { PAYOUT_LEDGER_ERROR } from '../../../shared/payoutLedgerOverviewSSOT';
import { Loader2, RefreshCw } from 'lucide-react';

function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB');
}

function MetricCard({
  title,
  value,
  source,
  unavailableReason,
}: {
  title: string;
  value: string;
  source: string;
  unavailableReason?: string | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {unavailableReason ? (
          <>
            <div className="text-sm font-semibold text-amber-700">UNAVAILABLE</div>
            <div className="text-xs font-mono text-muted-foreground">{unavailableReason}</div>
          </>
        ) : (
          <div className="text-xl font-semibold tabular-nums">{value}</div>
        )}
        <div className="text-[11px] text-muted-foreground">Source: {source}</div>
      </CardContent>
    </Card>
  );
}

function moneyOrUnavailable(
  pence: number | null | undefined,
  unavailableReason?: string | null,
): { value: string; reason?: string | null } {
  if (pence == null || unavailableReason) {
    return {
      value: 'UNAVAILABLE',
      reason: unavailableReason ?? COMPANY_BALANCE_ERROR.SOURCE_UNAVAILABLE,
    };
  }
  return { value: formatNullablePence(pence) };
}

export function PayoutLedgerOverviewPanel({
  overview,
  companyBalance,
  isLoading,
  isError,
  errorCode,
  errorMessage,
  onRetry,
  isFetching,
}: {
  overview: AdminPayoutLedgerOverviewSummary | null | undefined;
  companyBalance?: CompanyBalanceSnapshot | null;
  isLoading: boolean;
  isError: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  onRetry: () => void;
  isFetching?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading overview...
      </div>
    );
  }

  if (isError || (!overview && errorCode)) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Payout Ledger unavailable</AlertTitle>
        <AlertDescription className="space-y-2">
          <div>Source: admin-payout-ledger</div>
          <div className="font-mono text-xs">
            Error code: {errorCode ?? PAYOUT_LEDGER_ERROR.API_UNAVAILABLE}
          </div>
          {errorMessage ? <div>{errorMessage}</div> : null}
          <Button variant="outline" size="sm" onClick={onRetry} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Retry</span>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!overview) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Payout Ledger unavailable</AlertTitle>
        <AlertDescription className="space-y-2">
          <div>Source: admin-payout-ledger</div>
          <div className="font-mono text-xs">
            Error code: {PAYOUT_LEDGER_ERROR.SCHEMA_MISMATCH}
          </div>
          <div>Overview DTO missing from response (schema mismatch or stale edge deploy).</div>
          <Button variant="outline" size="sm" onClick={onRetry} disabled={isFetching}>
            <RefreshCw className="h-4 w-4" />
            <span className="ml-2">Retry</span>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const companyReason =
    companyBalance?.status_code
    ?? companyBalance?.unavailable_reason
    ?? (overview.company_balance_pence == null
      ? (overview.unavailable_reason?.includes('COMPANY')
        || overview.unavailable_reason === 'ACCOUNT_NOT_CONFIGURED'
        || overview.unavailable_reason === 'AUTHENTICATION_REQUIRED'
        ? overview.unavailable_reason
        : COMPANY_BALANCE_ERROR.SOURCE_UNAVAILABLE)
      : null);
  const companyBal = moneyOrUnavailable(overview.company_balance_pence, companyReason);
  const companyAvail = moneyOrUnavailable(
    overview.company_available_for_transfer_pence,
    companyReason,
  );

  const driverSource = overview.sources?.driver_wallet ?? 'Driver Wallet Ledger SSOT';
  const payoutSource = overview.sources?.driver_payouts ?? 'payout_items';
  const companySource = overview.sources?.company_balance ?? 'Company Balance SSOT';
  const companyTxSource = overview.sources?.company_transfers ?? 'company_outgoing_transfers';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={overview.status === 'LIVE' ? 'default' : 'secondary'}>
          Overview: {overview.status}
        </Badge>
        {overview.unavailable_reason ? (
          <Badge variant="outline" className="font-mono text-xs">
            {overview.unavailable_reason}
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          Generated {shortDate(overview.generated_at)} · {overview.currency}
        </span>
      </div>

      {overview.status === 'PARTIAL' ? (
        <Alert>
          <AlertTitle>Partial overview</AlertTitle>
          <AlertDescription>
            Driver payout widgets are live. Company balance is unavailable
            {companyReason ? ` (${companyReason})` : ''}. Driver wallet money is not used as company money.
          </AlertDescription>
        </Alert>
      ) : null}

      <div>
        <h3 className="text-sm font-medium mb-2">Driver payouts</h3>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <MetricCard title="Total Live Driver Wallet" value={formatNullablePence(overview.driver_wallet_total_pence)} source={driverSource} />
          <MetricCard title="Total Available for Payout" value={formatNullablePence(overview.driver_available_pence)} source={driverSource} />
          <MetricCard title="Total Pending / Held" value={formatNullablePence(overview.driver_pending_pence)} source={driverSource} />
          <MetricCard title="Total Outstanding Debt" value={formatNullablePence(overview.driver_debt_pence)} source={driverSource} />
          <MetricCard title="Eligible Drivers" value={String(overview.eligible_driver_count ?? '—')} source={driverSource} />
          <MetricCard title="Held Drivers" value={String(overview.held_driver_count ?? '—')} source={driverSource} />
          <MetricCard title="Next Batch Amount" value={formatNullablePence(overview.next_driver_batch_amount_pence)} source={driverSource} />
          <MetricCard title="Next Batch Drivers" value={String(overview.next_driver_batch_count ?? '—')} source={driverSource} />
          <MetricCard title="Scheduled Driver Payouts" value={formatNullablePence(overview.payout_scheduled_pence)} source={payoutSource} />
          <MetricCard title="Processing Driver Payouts" value={formatNullablePence(overview.payout_processing_pence)} source={payoutSource} />
          <MetricCard title="Paid Today" value={formatNullablePence(overview.payout_paid_today_pence)} source={payoutSource} />
          <MetricCard title="Paid This Week" value={formatNullablePence(overview.payout_paid_week_pence)} source={payoutSource} />
          <MetricCard title="Paid This Month" value={formatNullablePence(overview.payout_paid_month_pence)} source={payoutSource} />
          <MetricCard title="Failed Driver Payouts" value={String(overview.payout_failed_count ?? '—')} source={payoutSource} />
          <MetricCard
            title="Next Scheduled Weekly Driver Payout"
            value={overview.next_run_at_local
              ?? shortDate(overview.next_scheduled_weekly_driver_payout_at)}
            source="Payout Schedule SSOT"
          />
          <MetricCard
            title="Schedule"
            value={overview.schedule_label
              ?? overview.payout_schedule?.schedule_label
              ?? '—'}
            source="Payout Schedule SSOT"
          />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">Company transfers</h3>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <MetricCard
            title="ONECAB Company Balance"
            value={companyBal.value}
            source={companySource}
            unavailableReason={companyBal.reason}
          />
          <MetricCard
            title="Available for Company Transfer"
            value={companyAvail.value}
            source={companySource}
            unavailableReason={companyAvail.reason}
          />
          <MetricCard
            title="Approved Company Payables"
            value={formatNullablePence(overview.company_payables_pending_pence)}
            source={companyTxSource}
          />
          <MetricCard
            title="Company Transfers Processing"
            value={formatNullablePence(overview.company_transfers_processing_pence)}
            source={companyTxSource}
          />
          <MetricCard
            title="Company Transfers Completed Today"
            value={formatNullablePence(overview.company_transfers_paid_today_pence)}
            source={companyTxSource}
          />
          <MetricCard
            title="Company Transfers Failed"
            value={String(overview.company_transfers_failed_count ?? '—')}
            source={companyTxSource}
          />
          <MetricCard
            title="Awaiting Approval"
            value={String(overview.company_awaiting_approval_count ?? '—')}
            source={companyTxSource}
          />
        </div>
      </div>
    </div>
  );
}
