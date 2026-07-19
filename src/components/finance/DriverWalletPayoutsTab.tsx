import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { payoutLedgerUrl } from '../../../shared/adminPayoutLedgerSSOT';
import {
  buildLiveWalletCompositionDisplay,
  isCarriedForwardPayoutItem,
  resolveDriverPayoutItemDisplayPresentation,
  sumCarriedForwardPayoutItemsPence,
} from '../../../shared/driverPayoutBatchDisplaySSOT';
import { Loader2 } from 'lucide-react';

const ACTIVE_BATCH_STATUSES = new Set([
  'pending',
  'processing',
  'ready',
  'transfer_created',
  'reserved',
  'reserving',
]);

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

function payoutAmountPence(pi: Record<string, unknown>): number | null {
  if (pi.net_driver_payout_pence != null) return Number(pi.net_driver_payout_pence);
  if (pi.amount_pence != null) return Number(pi.amount_pence);
  return null;
}

function isActiveBatchItem(pi: Record<string, unknown>): boolean {
  if (isCarriedForwardPayoutItem({
    status: pi.status as string | null,
    execution_status: pi.execution_status as string | null,
    reservation_status: pi.reservation_status as string | null,
    paid_at: pi.paid_at as string | null,
    completed_at: pi.completed_at as string | null,
    wallet_ledger_entry_id: pi.ledger_entry_id as string | null,
  })) {
    return false;
  }
  return ACTIVE_BATCH_STATUSES.has(String(pi.status ?? '').toLowerCase());
}

function batchLabel(pi: Record<string, unknown>): string {
  const batchId = pi.batch_id ? String(pi.batch_id) : null;
  return batchId ? `${batchId.slice(0, 12)}…` : `${String(pi.id).slice(0, 12)}…`;
}

function providerPayoutLabel(pi: Record<string, unknown>): string {
  const ref = pi.provider_reference;
  if (ref) return String(ref);
  return String(pi.stripe_payout_id ?? pi.stripe_transfer_id ?? '—');
}

function itemPresentation(pi: Record<string, unknown>) {
  return resolveDriverPayoutItemDisplayPresentation({
    status: pi.status as string | null,
    execution_status: pi.execution_status as string | null,
    completed_at: pi.completed_at as string | null,
    paid_at: pi.paid_at as string | null,
    reservation_status: pi.reservation_status as string | null,
    wallet_ledger_entry_id: pi.ledger_entry_id as string | null,
    release_reason: pi.release_reason as string | null,
    failure_reason: pi.failure_reason as string | null,
  });
}

/**
 * Driver-scoped payout read view. Execution (create batch / mark paid) lives on Payout Ledger.
 * Does not client-sum money — displays backend per-item amounts only.
 */
export function DriverWalletPayoutsTab({
  driver,
  currencyCode,
  isLoading,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  isLoading?: boolean;
  regionId?: string | null;
  manualPayoutMode?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading payouts…
      </div>
    );
  }

  if (!driver) {
    return (
      <p className="text-sm text-muted-foreground py-8">
        Select a driver to view payout allocations.
      </p>
    );
  }

  const items = (driver.payout_items ?? []) as Array<Record<string, unknown>>;
  const earlyCashouts = (driver.early_cashouts ?? []) as Array<Record<string, unknown>>;
  const ccy = currencyCode ?? 'GBP';
  const carriedForwardItems = items.filter((pi) =>
    isCarriedForwardPayoutItem({
      status: pi.status as string | null,
      execution_status: pi.execution_status as string | null,
      reservation_status: pi.reservation_status as string | null,
      paid_at: pi.paid_at as string | null,
      completed_at: pi.completed_at as string | null,
      wallet_ledger_entry_id: pi.ledger_entry_id as string | null,
    }),
  );
  const currentBatchItems = items.filter(isActiveBatchItem);
  const previousBatchItems = items.filter((pi) => {
    const s = String(pi.status ?? '').toLowerCase();
    return (s === 'completed' || s === 'paid' || s === 'succeeded') && !isActiveBatchItem(pi);
  });
  const failedPayouts = items.filter((pi) => {
    const s = String(pi.status ?? '').toLowerCase();
    return s === 'failed' || s === 'ledger_sync_failed' || s === 'error';
  });
  const retryableCount = failedPayouts.length;
  const carriedPence = sumCarriedForwardPayoutItemsPence(
    carriedForwardItems.map((pi) => ({
      amount_pence: payoutAmountPence(pi),
      status: pi.status as string | null,
      execution_status: pi.execution_status as string | null,
      reservation_status: pi.reservation_status as string | null,
      wallet_ledger_entry_id: pi.ledger_entry_id as string | null,
    })),
  );
  const liveComposition = buildLiveWalletCompositionDisplay({
    live_balance_pence: Number(driver.wallet_balance_pence ?? 0),
    carried_forward_pence: carriedPence,
  });

  const renderItemTable = (rows: Array<Record<string, unknown>>, empty: string) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Batch</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Provider / bank ref</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
              {empty}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((pi) => {
            const presentation = itemPresentation(pi);
            return (
              <TableRow key={String(pi.id)}>
                <TableCell className="font-mono text-xs">{batchLabel(pi)}</TableCell>
                <TableCell className="text-right">
                  {formatNullablePence(payoutAmountPence(pi), ccy)}
                </TableCell>
                <TableCell>
                  <div className="space-y-0.5">
                    <Badge variant="outline">{presentation.display_status_label}</Badge>
                    {presentation.supporting_text ? (
                      <p className="text-[11px] text-muted-foreground">
                        {presentation.supporting_text}
                      </p>
                    ) : null}
                    {presentation.reason_label ? (
                      <p className="text-[11px] text-muted-foreground">
                        Reason: {presentation.reason_label}
                      </p>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">{providerPayoutLabel(pi)}</TableCell>
                <TableCell className="text-xs">
                  {formatDate((pi.updated_at ?? pi.created_at) as string)}
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Payout allocations (read-only)</CardTitle>
          <Button asChild size="sm">
            <Link to={payoutLedgerUrl({ driverId: driver.driver_id, tab: 'overview' })}>
              Open Payout Ledger
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Create weekly batch, mark paid, retry, and cancel are owned by Payout Ledger (SSOT).
            This tab shows this driver’s payout items only — amounts are backend values, not
            client totals.
          </p>
          {liveComposition.carried_forward_pence > 0 ? (
            <div className="rounded-md border bg-muted/30 p-3 text-foreground space-y-1 text-sm">
              <div>
                Live Wallet: {formatNullablePence(liveComposition.live_balance_pence, ccy)}
              </div>
              <div>
                Carried forward from previous batch:{' '}
                {formatNullablePence(liveComposition.carried_forward_pence, ccy)}
              </div>
              <div>
                New earnings since then:{' '}
                {formatNullablePence(liveComposition.new_earnings_pence, ccy)}
              </div>
              <p className="text-xs text-muted-foreground">
                {formatNullablePence(liveComposition.carried_forward_pence, ccy)}
                {' + '}
                {formatNullablePence(liveComposition.new_earnings_pence, ccy)}
                {' = '}
                {formatNullablePence(liveComposition.live_balance_pence, ccy)}
                {' · carried forward is included in Live Wallet, not an extra unpaid balance'}
              </p>
            </div>
          ) : null}
          <div className="grid gap-2 grid-cols-2 lg:grid-cols-3 text-foreground text-xs">
            <div>
              <p className="text-muted-foreground">Payout destination</p>
              <p className="font-mono">{driver.connected_account_id ?? 'Manual bank'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Verification</p>
              <p className="font-semibold">{driver.verification_status ?? '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Bank account</p>
              <p className="font-semibold">
                {driver.bank_account_last4 ? `•••• ${driver.bank_account_last4}` : '—'}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Provider</p>
              <p className="font-semibold">{driver.payout_provider ?? 'revolut'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Last payout</p>
              <p className="font-semibold">
                {driver.last_payout_at
                  ? `${formatDate(driver.last_payout_at)} · ${formatNullablePence(driver.last_payout_amount_pence, ccy)}`
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Next / scheduled</p>
              <p className="font-semibold">
                {formatNullablePence(driver.scheduled_payout_display_pence, ccy)}
              </p>
            </div>
          </div>
          <div className="grid gap-2 grid-cols-2 lg:grid-cols-6 text-foreground">
            <div>
              <p className="text-xs text-muted-foreground">Available</p>
              <p className="font-semibold tabular-nums">
                {formatNullablePence(driver.cashout_limit_pence, ccy)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Pending</p>
              <p className="font-semibold tabular-nums">
                {formatNullablePence(driver.period_kpis?.pending_earnings_pence, ccy)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Processing</p>
              <p className="font-semibold tabular-nums">
                {formatNullablePence(driver.included_in_payout_batch_amount_pence, ccy)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Paid</p>
              <p className="font-semibold tabular-nums">
                {formatNullablePence(driver.stripe_paid_out_total_pence, ccy)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Failed</p>
              <p className="font-semibold tabular-nums">
                {formatNullablePence(driver.local_only_failed_payout_pence, ccy)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Retry</p>
              <p className="font-semibold tabular-nums">{retryableCount}</p>
            </div>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link to={payoutLedgerUrl({ driverId: driver.driver_id, tab: 'failed' })}>
              Retry failed on Payout Ledger
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Early cash-outs</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Requested</TableHead>
                <TableHead className="text-right">Fee</TableHead>
                <TableHead className="text-right">Driver receives</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Provider ref</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {earlyCashouts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                    No early cash-outs
                  </TableCell>
                </TableRow>
              ) : (
                earlyCashouts.map((row) => (
                  <TableRow key={String(row.id)}>
                    <TableCell className="text-xs">{formatDate(row.created_at as string)}</TableCell>
                    <TableCell className="text-right">
                      {formatNullablePence(
                        row.requested_cashout_pence == null
                          ? null
                          : Number(row.requested_cashout_pence),
                        ccy,
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNullablePence(
                        row.early_cashout_fee_pence == null
                          ? null
                          : Number(row.early_cashout_fee_pence),
                        ccy,
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNullablePence(
                        row.driver_receives_pence == null
                          ? null
                          : Number(row.driver_receives_pence),
                        ccy,
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{String(row.status ?? '—')}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.stripe_payout_id ? String(row.stripe_payout_id).slice(0, 14) : '—'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Carried forward (in Live Wallet)</CardTitle>
        </CardHeader>
        <CardContent>
          {renderItemTable(carriedForwardItems, 'No carried-forward payout items')}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Current / processing</CardTitle>
        </CardHeader>
        <CardContent>{renderItemTable(currentBatchItems, 'No active payout items')}</CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Weekly payout history</CardTitle>
        </CardHeader>
        <CardContent>
          {renderItemTable(previousBatchItems, 'No completed payout items')}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Failed</CardTitle>
        </CardHeader>
        <CardContent>{renderItemTable(failedPayouts, 'No failed payouts')}</CardContent>
      </Card>
    </div>
  );
}
