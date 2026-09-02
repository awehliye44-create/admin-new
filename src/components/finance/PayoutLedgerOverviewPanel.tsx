/**
 * Payout Ledger Overview widgets — display-only of backend DTO.
 * Company funding grid is liquidity/protection only (never PS commission accounting).
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
import {
  PAYOUT_LEDGER_LIQUIDITY_CARD_TITLES as LIQUIDITY,
  PAYOUT_LEDGER_LIQUIDITY_CARD_TOOLTIPS as LIQUIDITY_TIPS,
  PAYOUT_LEDGER_LIQUIDITY_SECTION_TITLE,
  computePayoutLedgerRealAvailableFundsPence,
} from '@/lib/payoutLedgerLiquidityCardsSSOT';
import type { AdminPayoutLedgerOverviewSummary } from '../../../shared/adminPayoutLedgerSSOT';
import type { CompanyBalanceSnapshot } from '../../../shared/companyBalanceSSOT';
import { COMPANY_BALANCE_ERROR } from '../../../shared/companyBalanceSSOT';
import { PAYOUT_LEDGER_ERROR } from '../../../shared/payoutLedgerOverviewSSOT';
import { Info, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { LoadingTimeout } from '@/components/LoadingTimeout';

/** Optional overview fields returned by newer edges — ignored when absent. */
type OverviewExtras = {
  company_funds_scope?: string;
  company_funds_scope_label?: string | null;
  protected_driver_liabilities_breakdown?: {
    total_pence?: number | null;
    pending_clearing_pence?: number | null;
  } | null;
  next_run_at_local?: string | null;
  schedule_label?: string | null;
  payout_schedule?: {
    next_run_at_local?: string | null;
    schedule_label?: string | null;
  } | null;
};

type CompanyBalanceExtras = {
  company_funds_underprotected?: boolean;
  company_funds_underprotected_message?: string | null;
};

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
  subtitle,
  statusBadge,
  setupRequired,
}: {
  title: string;
  value: string;
  source: string;
  unavailableReason?: string | null;
  tooltip?: string | null;
  subtitle?: string | null;
  statusBadge?: string | null;
  setupRequired?: boolean;
}) {
  return (
    <Card data-testid="payout-ledger-metric-card" data-card-title={title}>
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
            <div className={`text-sm font-semibold ${setupRequired ? 'text-blue-700' : 'text-amber-700'}`}>
              {setupRequired ? 'SETUP REQUIRED' : 'UNAVAILABLE'}
            </div>
            <div className="text-xs font-mono text-muted-foreground">{unavailableReason}</div>
          </>
        ) : (
          <div className="text-xl font-semibold tabular-nums">{value}</div>
        )}
        {statusBadge && !unavailableReason ? (
          <div className="text-xs font-mono text-amber-700">Status: {statusBadge}</div>
        ) : null}
        {subtitle ? (
          <div className="text-[11px] text-muted-foreground">{subtitle}</div>
        ) : null}
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
      <LoadingTimeout
        isLoading
        sectionLabel="payout ledger overview"
        loadingText="Loading overview..."
        onRetry={onRetry}
      />
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

  const overviewX = overview as AdminPayoutLedgerOverviewSummary & OverviewExtras;
  const snap = (companyBalance ?? overview.company_balance ?? null) as
    | (CompanyBalanceSnapshot & CompanyBalanceExtras)
    | null;
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

  // Provider cash — never labelled ONECAB Company Balance / commission.
  const providerCash = moneyOrUnavailable(
    snap?.provider_available_balance_pence
      ?? snap?.provider_cash_balance_pence
      ?? null,
    providerReason,
  );
  const liabilityBreakdown = overviewX.protected_driver_liabilities_breakdown;
  const protectedLiabilityPence = snap?.driver_liability_pence
    ?? liabilityBreakdown?.total_pence
    ?? null;
  const liability = moneyOrUnavailable(
    protectedLiabilityPence,
    snap?.sections?.driver_liabilities?.reason_code
      ?? (
        protectedLiabilityPence == null
          ? COMPANY_BALANCE_ERROR.DRIVER_LIABILITY_QUERY_FAILED
          : null
      ),
  );
  const liabilitySubtitle = liabilityBreakdown && liabilityBreakdown.pending_clearing_pence > 0
    ? `Includes ${formatNullablePence(liabilityBreakdown.pending_clearing_pence)} pending clearing.`
    : null;
  // Canonical reserved = ACTIVE driver_payout_reservations (same as Driver Payouts tab).
  const reservedPence = overview.driver_reserved_pence
    ?? snap?.driver_payout_reserved_pence
    ?? null;
  const reserved = moneyOrUnavailable(
    reservedPence,
    snap?.sections?.reserved_driver_payouts?.reason_code
      ?? (reservedPence == null ? 'RESERVED_DRIVER_PAYOUTS_QUERY_FAILED' : null),
  );
  const reservedSource =
    'driver_payout_reservations ACTIVE / Driver Wallet Ledger SSOT';

  const underprotected = snap?.company_funds_underprotected === true;
  const underprotectedMessage = snap?.company_funds_underprotected_message ?? null;
  const reserveConfigured = snap?.operational_reserve_pence != null
    && snap?.sections?.operational_reserve?.status === 'AVAILABLE';
  const reserveNotConfiguredReason = snap?.sections?.operational_reserve?.reason_code
    ?? 'OPERATIONAL_RESERVE_NOT_CONFIGURED';
  const reserveSetupRequired = !reserveConfigured
    && reserveNotConfiguredReason === 'OPERATIONAL_RESERVE_NOT_CONFIGURED';
  const reserveCard = moneyOrUnavailable(
    reserveConfigured ? snap?.operational_reserve_pence : null,
    snap?.sections?.operational_reserve?.reason_code
      ?? (reserveConfigured ? null : 'OPERATIONAL_RESERVE_NOT_CONFIGURED'),
  );
  const beforeReserve = moneyOrUnavailable(
    underprotected
      ? 0
      : snap?.company_available_before_operational_reserve_pence ?? null,
    underprotected
      ? null
      : snap?.company_available_before_operational_reserve_pence == null
        ? 'BEFORE_RESERVE_UNAVAILABLE'
        : null,
  );
  // Liquidity-only Real Available — ignore onecab_net_commission_available_pence entirely.
  const realAvailablePence = computePayoutLedgerRealAvailableFundsPence({
    company_available_before_operational_reserve_pence:
      snap?.company_available_before_operational_reserve_pence ?? null,
    operational_reserve_pence: snap?.operational_reserve_pence ?? null,
    operational_reserve_configured: reserveConfigured,
    provider_available_balance_pence: snap?.provider_available_balance_pence ?? null,
    company_funds_underprotected: underprotected,
  });
  const onecabFunds = moneyOrUnavailable(
    realAvailablePence,
    underprotected
      ? null
      : !reserveConfigured
        ? 'OPERATIONAL_RESERVE_NOT_CONFIGURED'
        : realAvailablePence == null
          ? companyReason
          : null,
  );
  const driverSource = overview.sources?.driver_wallet ?? 'Driver Wallet Ledger SSOT';
  const payoutSource = overview.sources?.driver_payouts ?? 'payout_items';
  const providerSource = snap?.source_account_label
    ? `Selected Revolut Business source account`
    : 'Selected Revolut Business source account';

  return (
    <TooltipProvider>
    <div className="space-y-4" data-testid="payout-ledger-overview-panel">
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
          <MetricCard
            title="Reserved Driver Payouts"
            value={formatNullablePence(overview.driver_reserved_pence)}
            source={reservedSource}
          />
          <MetricCard
            title="Other Pending / Held"
            value={formatNullablePence(overview.driver_pending_pence)}
            source={driverSource}
            tooltip="Non-reservation holds only. Active payout reservations are counted under Reserved Driver Payouts."
          />
          <MetricCard title="Total Outstanding Debt" value={formatNullablePence(overview.driver_debt_pence)} source={driverSource} />
          <MetricCard title="Paid Today" value={formatNullablePence(overview.payout_paid_today_pence)} source={payoutSource} />
          <MetricCard title="Eligible Drivers" value={String(overview.eligible_driver_count ?? '—')} source={driverSource} />
          <MetricCard
            title="Held Drivers"
            value={String(overview.held_driver_count ?? '—')}
            source={driverSource}
            tooltip="Drivers whose available payout is currently held by an active payout reservation or another valid payout hold."
          />
          <MetricCard title="Next Batch Amount" value={formatNullablePence(overview.next_driver_batch_amount_pence)} source={driverSource} />
          <MetricCard title="Next Batch Drivers" value={String(overview.next_driver_batch_count ?? '—')} source={driverSource} />
          <MetricCard title="Scheduled Driver Payouts" value={formatNullablePence(overview.payout_scheduled_pence)} source={payoutSource} />
          <MetricCard title="Processing Driver Payouts" value={formatNullablePence(overview.payout_processing_pence)} source={payoutSource} />
          <MetricCard title="Paid This Week" value={formatNullablePence(overview.payout_paid_week_pence)} source={payoutSource} />
          <MetricCard
            title="Completed Driver Payouts This Month"
            value={formatNullablePence(overview.payout_paid_month_pence)}
            source={payoutSource}
          />
          <MetricCard
            title="Failed payout items"
            value={String(overview.payout_failed_count ?? '—')}
            source={payoutSource}
            tooltip="Counts failed payout items (driver-level). Does not count historical FAILED batches in Batch History."
          />
          <MetricCard
            title="Next Scheduled Weekly Driver Payout"
            value={overviewX.next_run_at_local
              ?? overviewX.payout_schedule?.next_run_at_local
              ?? overview.next_scheduled_weekly_driver_payout_at
              ?? '—'}
            source="Payout Schedule SSOT"
          />
          <MetricCard
            title="Schedule"
            value={overviewX.schedule_label
              ?? overviewX.payout_schedule?.schedule_label
              ?? '—'}
            source="Payout Schedule SSOT"
          />
        </div>
      </div>

      <div data-testid="payout-ledger-company-funding">
        <h3 className="text-sm font-medium mb-2">Company funding</h3>
        {overviewX.company_funds_scope === 'GLOBAL' ? (
          <p className="text-xs text-muted-foreground mb-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
            {overviewX.company_funds_scope_label
              ?? 'Global company funds — Revolut source is not segregated by service area. Driver liabilities are platform-wide.'}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground mb-4">
          Live Revolut liquidity, protected liabilities, and reserves only — not Payment Sessions revenue accounting.
        </p>

        {underprotected && underprotectedMessage ? (
          <Alert variant="destructive" className="mb-4 py-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle className="text-sm">Company funds unavailable</AlertTitle>
            <AlertDescription className="text-xs space-y-1">
              <p>{underprotectedMessage}</p>
              <p className="text-muted-foreground">
                Do not approve company transfers or treat ONECAB Funds Before Reserve as spendable until
                Revolut source balance covers protected driver liabilities and approved payables.
                Driver payouts remain governed separately by payout funding gates.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-4">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              {PAYOUT_LEDGER_LIQUIDITY_SECTION_TITLE}
            </h4>
            <div
              className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
              data-testid="payout-ledger-liquidity-cards"
            >
              <MetricCard
                title={LIQUIDITY.REVOLUT_SOURCE_ACCOUNT_BALANCE}
                value={providerCash.value}
                source={providerSource}
                unavailableReason={providerCash.reason}
                tooltip={LIQUIDITY_TIPS.REVOLUT_SOURCE_ACCOUNT_BALANCE}
              />
              <MetricCard
                title={LIQUIDITY.PROTECTED_DRIVER_LIABILITIES}
                value={liability.value}
                source={driverSource}
                unavailableReason={liability.reason}
                tooltip={LIQUIDITY_TIPS.PROTECTED_DRIVER_LIABILITIES}
                subtitle={liabilitySubtitle}
              />
              <MetricCard
                title={LIQUIDITY.RESERVED_DRIVER_PAYOUTS}
                value={reserved.value}
                source={reservedSource}
                unavailableReason={reserved.reason}
                tooltip={LIQUIDITY_TIPS.RESERVED_DRIVER_PAYOUTS}
                subtitle="Subset of protected driver liabilities — shown separately for payout operations."
              />
              <MetricCard
                title={LIQUIDITY.ONECAB_FUNDS_BEFORE_RESERVE}
                value={beforeReserve.value}
                source="Company Balance SSOT"
                unavailableReason={beforeReserve.reason}
                tooltip={LIQUIDITY_TIPS.ONECAB_FUNDS_BEFORE_RESERVE}
                subtitle="Revolut source − protected driver liabilities − approved company payables (− refund reserve when set)."
              />
              <MetricCard
                title={LIQUIDITY.OPERATIONAL_REFUND_RESERVE}
                value={reserveCard.value}
                source="Company Balance SSOT"
                unavailableReason={reserveCard.reason}
                setupRequired={reserveSetupRequired}
                subtitle={reserveSetupRequired
                  ? 'Configure and owner-activate in Payout Ledger → Settings. Not a payment failure.'
                  : undefined}
                tooltip={LIQUIDITY_TIPS.OPERATIONAL_REFUND_RESERVE}
              />
              <MetricCard
                title={LIQUIDITY.ONECAB_REAL_AVAILABLE_FUNDS}
                value={onecabFunds.value}
                source="Company Balance SSOT · liquidity-only"
                unavailableReason={onecabFunds.reason}
                setupRequired={reserveSetupRequired}
                subtitle={reserveSetupRequired
                  ? 'Requires an active reserve policy. Real Available = Before Reserve − reserve.'
                  : undefined}
                tooltip={LIQUIDITY_TIPS.ONECAB_REAL_AVAILABLE_FUNDS}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
    </TooltipProvider>
  );
}
