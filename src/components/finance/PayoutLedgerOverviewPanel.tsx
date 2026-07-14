/**
 * Payout Ledger Overview widgets — display-only of backend DTO.
 * Never sums financial totals in React.
 */
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatNullablePence } from '@/lib/formatNullablePence';
import type { AdminPayoutLedgerOverviewSummary } from '../../../shared/adminPayoutLedgerSSOT';
import type { CompanyBalanceSnapshot } from '../../../shared/companyBalanceSSOT';
import {
  COMPANY_BALANCE_ERROR,
  COMPANY_BALANCE_LABELS,
  COMPANY_BALANCE_TOOLTIPS,
  computeDriverPayoutFunding,
  computeOperationalRefundReservePence,
} from '../../../shared/companyBalanceSSOT';
import { PAYOUT_LEDGER_ERROR } from '../../../shared/payoutLedgerOverviewSSOT';
import { Info, Loader2, RefreshCw } from 'lucide-react';

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
  tooltip,
}: {
  title: string;
  value: string;
  source: string;
  unavailableReason?: string | null;
  tooltip?: string | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <span>{title}</span>
          {tooltip ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`${title} info`}>
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">{tooltip}</TooltipContent>
            </Tooltip>
          ) : null}
        </CardTitle>
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
  // Unknown money must never render as £0.
  if (pence == null) {
    let reason = unavailableReason ?? COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED;
    if (
      reason === COMPANY_BALANCE_ERROR.SOURCE_UNAVAILABLE
      || reason === COMPANY_BALANCE_ERROR.ACCOUNT_NOT_CONFIGURED
    ) {
      reason = COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED;
    }
    if (
      reason === COMPANY_BALANCE_ERROR.PROVIDER_UNAVAILABLE
      || reason === COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE
    ) {
      reason = COMPANY_BALANCE_ERROR.PROVIDER_BALANCE_UNAVAILABLE;
    }
    return { value: 'UNAVAILABLE', reason };
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

  const snap = companyBalance ?? overview.company_balance ?? null;
  const companyReason =
    snap?.status_code
    ?? snap?.unavailable_reason
    ?? (overview.unavailable_reason
      && overview.unavailable_reason !== COMPANY_BALANCE_ERROR.SOURCE_UNAVAILABLE
      ? overview.unavailable_reason
      : null)
    ?? (snap?.provider_available_balance_pence == null
      && overview.company_balance_pence == null
      ? COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED
      : null);

  const providerReason = (() => {
    const raw = companyReason;
    if (
      raw === COMPANY_BALANCE_ERROR.PROVIDER_UNAVAILABLE
      || raw === COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE
    ) {
      return COMPANY_BALANCE_ERROR.PROVIDER_BALANCE_UNAVAILABLE;
    }
    return raw;
  })();

  // £19.34-style provider cash — never labelled ONECAB Company Balance.
  const providerCash = moneyOrUnavailable(
    snap?.provider_available_balance_pence
      ?? snap?.provider_cash_balance_pence
      ?? null,
    providerReason,
  );
  const liability = moneyOrUnavailable(
    snap?.driver_liability_pence ?? overview.driver_wallet_total_pence,
    snap?.sections?.driver_liabilities?.reason_code
      ?? (
        (snap?.driver_liability_pence ?? overview.driver_wallet_total_pence) == null
          ? COMPANY_BALANCE_ERROR.DRIVER_LIABILITY_QUERY_FAILED
          : null
      ),
  );
  const reservedPence = snap?.driver_payout_reserved_pence
    ?? (
      snap?.status === 'LIVE' || overview.payout_scheduled_pence != null
        ? ((overview.payout_scheduled_pence ?? 0) + (overview.payout_processing_pence ?? 0))
        : null
    );
  const reserved = moneyOrUnavailable(
    reservedPence,
    snap?.sections?.reserved_driver_payouts?.reason_code,
  );

  const payablesPence = snap?.approved_company_payables_pence
    ?? overview.company_payables_pending_pence
    ?? 0;
  const reservePence = computeOperationalRefundReservePence({
    operational_reserve_pence: snap?.operational_reserve_pence,
    customer_refund_reserved_pence: snap?.customer_refund_reserved_pence,
  });
  const onecabFunds = moneyOrUnavailable(
    snap?.company_available_for_transfer_pence
      ?? overview.company_available_for_transfer_pence,
    companyReason,
  );
  const funding = snap?.driver_payout_funding_status && snap.funding_gap_pence != null
    ? { status: snap.driver_payout_funding_status, gap_pence: snap.funding_gap_pence }
    : computeDriverPayoutFunding({
      provider_available_balance_pence:
        snap?.provider_available_balance_pence ?? snap?.provider_cash_balance_pence ?? null,
      driver_liability_pence:
        snap?.driver_liability_pence ?? overview.driver_wallet_total_pence ?? null,
    });
  const fundingGap = moneyOrUnavailable(
    funding.gap_pence,
    funding.status === 'UNAVAILABLE' ? 'FUNDING_STATUS_UNAVAILABLE' : null,
  );

  const driverSource = overview.sources?.driver_wallet ?? 'Driver Wallet Ledger SSOT';
  const payoutSource = overview.sources?.driver_payouts ?? 'payout_items';
  const companyTxSource = overview.sources?.company_transfers ?? 'company_outgoing_transfers';
  const providerSource = snap?.source_account_label
    ? `Selected Revolut Business source account`
    : 'Selected Revolut Business source account';

  return (
    <TooltipProvider>
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
            Driver payout widgets are live. Provider / company funding may be incomplete
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
          <MetricCard
            title="Failed payout items"
            value={String(overview.payout_failed_count ?? '—')}
            source={payoutSource}
            tooltip="Counts failed payout items (driver-level). Does not count historical FAILED batches in Batch History."
          />
          <MetricCard
            title="Next Scheduled Weekly Driver Payout"
            value={overview.next_run_at_local
              ?? overview.payout_schedule?.next_run_at_local
              ?? '—'}
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
        <h3 className="text-sm font-medium mb-2">Company funding</h3>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <MetricCard
            title={COMPANY_BALANCE_LABELS.REVOLUT_SOURCE_ACCOUNT_BALANCE}
            value={providerCash.value}
            source={providerSource}
            unavailableReason={providerCash.reason}
            tooltip={COMPANY_BALANCE_TOOLTIPS.REVOLUT_SOURCE_ACCOUNT_BALANCE}
          />
          <MetricCard
            title={COMPANY_BALANCE_LABELS.PROTECTED_DRIVER_LIABILITIES}
            value={liability.value}
            source={driverSource}
            unavailableReason={liability.reason}
          />
          <MetricCard
            title={COMPANY_BALANCE_LABELS.RESERVED_DRIVER_PAYOUTS}
            value={reserved.value}
            source={payoutSource}
            unavailableReason={reserved.reason}
          />
          <MetricCard
            title={COMPANY_BALANCE_LABELS.APPROVED_COMPANY_PAYABLES}
            value={formatNullablePence(payablesPence)}
            source={companyTxSource}
          />
          <MetricCard
            title={COMPANY_BALANCE_LABELS.OPERATIONAL_REFUND_RESERVE}
            value={formatNullablePence(reservePence)}
            source="Company Balance SSOT"
          />
          <MetricCard
            title={COMPANY_BALANCE_LABELS.ONECAB_AVAILABLE_COMPANY_FUNDS}
            value={onecabFunds.value}
            source="Company Balance SSOT"
            unavailableReason={onecabFunds.reason}
            tooltip={COMPANY_BALANCE_TOOLTIPS.ONECAB_AVAILABLE_COMPANY_FUNDS}
          />
          <MetricCard
            title={COMPANY_BALANCE_LABELS.DRIVER_PAYOUT_FUNDING_STATUS}
            value={funding.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : funding.status}
            source="Company Balance SSOT"
            unavailableReason={funding.status === 'UNAVAILABLE' ? 'FUNDING_STATUS_UNAVAILABLE' : null}
          />
          <MetricCard
            title={COMPANY_BALANCE_LABELS.FUNDING_GAP}
            value={fundingGap.value}
            source="Company Balance SSOT"
            unavailableReason={fundingGap.reason}
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
    </TooltipProvider>
  );
}
