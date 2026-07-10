import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { payoutLedgerUrl } from '../../shared/adminPayoutLedgerSSOT';
import { Loader2 } from 'lucide-react';

const ACTIVE_BATCH_STATUSES = new Set(['pending', 'processing', 'ready', 'transfer_created']);

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
    return <p className="text-sm text-muted-foreground py-8">Select a driver to view payout allocations.</p>;
  }

  const items = (driver.payout_items ?? []) as Array<Record<string, unknown>>;
  const ccy = currencyCode ?? 'GBP';
  const currentBatchItems = items.filter(isActiveBatchItem);
  const previousBatchItems = items.filter((pi) => {
    const s = String(pi.status ?? '').toLowerCase();
    return s === 'completed' && !isActiveBatchItem(pi);
  });
  const failedPayouts = items.filter((pi) => {
    const s = String(pi.status ?? '').toLowerCase();
    return s === 'failed' || s === 'ledger_sync_failed';
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
            <TableCell colSpan={5} className="text-center text-muted-foreground py-6">{empty}</TableCell>
          </TableRow>
        ) : (
          rows.map((pi) => (
            <TableRow key={String(pi.id)}>
              <TableCell className="font-mono text-xs">{batchLabel(pi)}</TableCell>
              <TableCell className="text-right">{formatNullablePence(payoutAmountPence(pi), ccy)}</TableCell>
              <TableCell><Badge variant="outline">{String(pi.status ?? '—')}</Badge></TableCell>
              <TableCell className="font-mono text-xs">{providerPayoutLabel(pi)}</TableCell>
              <TableCell className="text-xs">{formatDate((pi.updated_at ?? pi.created_at) as string)}</TableCell>
            </TableRow>
          ))
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
        <CardContent className="text-sm text-muted-foreground">
          Create weekly batch, mark paid, retry, and cancel are owned by Payout Ledger (SSOT).
          This tab shows this driver’s payout items only — amounts are backend values, not client totals.
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Current / active</CardTitle></CardHeader>
        <CardContent>{renderItemTable(currentBatchItems, 'No active payout items')}</CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Completed</CardTitle></CardHeader>
        <CardContent>{renderItemTable(previousBatchItems, 'No completed payout items')}</CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Failed</CardTitle></CardHeader>
        <CardContent>{renderItemTable(failedPayouts, 'No failed payouts')}</CardContent>
      </Card>
    </div>
  );
}
