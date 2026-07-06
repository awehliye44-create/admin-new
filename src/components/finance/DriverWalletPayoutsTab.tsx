import { useState } from 'react';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPence } from '@/hooks/useDriverWallet';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

const ACTIVE_BATCH_STATUSES = new Set(['pending', 'processing']);

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

function payoutAmount(pi: Record<string, unknown>): number {
  return Number(pi.net_driver_payout_pence ?? pi.amount_pence ?? 0);
}

function isActiveBatchItem(pi: Record<string, unknown>): boolean {
  return ACTIVE_BATCH_STATUSES.has(String(pi.status ?? '').toLowerCase());
}

function batchLabel(pi: Record<string, unknown>): string {
  const batchId = pi.batch_id ? String(pi.batch_id) : null;
  return batchId ? `${batchId.slice(0, 12)}…` : `${String(pi.id).slice(0, 12)}…`;
}

type BatchGroup = {
  batchId: string;
  items: Array<Record<string, unknown>>;
  totalPence: number;
  status: string;
  updatedAt: string | null;
};

function groupByBatch(items: Array<Record<string, unknown>>): BatchGroup[] {
  const map = new Map<string, BatchGroup>();
  for (const pi of items) {
    const batchId = pi.batch_id ? String(pi.batch_id) : `item:${pi.id}`;
    const existing = map.get(batchId);
    const amount = payoutAmount(pi);
    const updated = (pi.updated_at ?? pi.created_at) as string | null;
    if (!existing) {
      map.set(batchId, {
        batchId,
        items: [pi],
        totalPence: amount,
        status: String(pi.status ?? '—'),
        updatedAt: updated,
      });
    } else {
      existing.items.push(pi);
      existing.totalPence += amount;
      if (updated && (!existing.updatedAt || updated > existing.updatedAt)) {
        existing.updatedAt = updated;
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}

export function DriverWalletPayoutsTab({
  driver,
  currencyCode,
  isLoading,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  isLoading?: boolean;
}) {
  const queryClient = useQueryClient();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading payouts…
      </div>
    );
  }

  if (!driver) {
    return <p className="text-sm text-muted-foreground py-8">Select a driver to view payout batches.</p>;
  }

  const items = (driver.payout_items ?? []) as Array<Record<string, unknown>>;
  const fmt = (p: number) => formatPence(p, currencyCode);

  const currentBatchItems = items.filter(isActiveBatchItem);
  const previousBatchItems = items.filter((pi) => {
    const s = String(pi.status ?? '').toLowerCase();
    return s === 'completed' && !isActiveBatchItem(pi);
  });
  const failedPayouts = items.filter((pi) => {
    const s = String(pi.status ?? '').toLowerCase();
    return s === 'failed' || s === 'ledger_sync_failed';
  });
  const retryHistory = items.filter((pi) => pi.failure_reason || pi.retry_count);

  const currentBatches = groupByBatch(currentBatchItems);
  const previousBatches = groupByBatch(previousBatchItems);


  const renderBatchTable = (groups: BatchGroup[], empty: string) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Batch</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead>Items</TableHead>
          <TableHead>Batch status</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="text-center text-muted-foreground py-6">{empty}</TableCell>
          </TableRow>
        ) : (
          groups.map((group) => (
            <TableRow key={group.batchId}>
              <TableCell className="font-mono text-xs">{group.batchId.startsWith('item:') ? group.batchId.slice(5, 17) + '…' : group.batchId.slice(0, 12) + '…'}</TableCell>
              <TableCell className="text-right">{fmt(group.totalPence)}</TableCell>
              <TableCell>{group.items.length}</TableCell>
              <TableCell><Badge variant="outline">{group.status}</Badge></TableCell>
              <TableCell className="text-xs">{formatDate(group.updatedAt)}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );

  const renderItemTable = (rows: Array<Record<string, unknown>>, empty: string) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Batch</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Provider transfer</TableHead>
          <TableHead>Provider payout</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="text-center text-muted-foreground py-6">{empty}</TableCell>
          </TableRow>
        ) : (
          rows.map((pi) => {
            return (
              <TableRow key={String(pi.id)}>
                <TableCell className="font-mono text-xs">{batchLabel(pi)}</TableCell>
                <TableCell className="text-right">{fmt(payoutAmount(pi))}</TableCell>
                <TableCell>
                  <Badge variant="outline">{String(pi.status ?? '—')}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{String(pi.stripe_transfer_id ?? '—')}</TableCell>
                <TableCell className="font-mono text-xs">{String(pi.stripe_payout_id ?? '—')}</TableCell>
                <TableCell className="text-xs">{formatDate((pi.updated_at ?? pi.created_at) as string)}</TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );

  const activeBatchStatus = currentBatches[0]?.status ?? (currentBatchItems.length > 0 ? String(currentBatchItems[0].status ?? '—') : '—');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Current batch</CardTitle>
        </CardHeader>
        <CardContent>{renderBatchTable(currentBatches, 'No active payout batch')}</CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Previous batches</CardTitle>
        </CardHeader>
        <CardContent>{renderBatchTable(previousBatches, 'No completed batches')}</CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Failed payouts</CardTitle>
        </CardHeader>
        <CardContent>{renderItemTable(failedPayouts, 'No failed payouts')}</CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Retry history</CardTitle>
        </CardHeader>
        <CardContent>{renderItemTable(retryHistory, 'No retry history')}</CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Batch status</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Active weekly batch: <Badge variant="outline">{activeBatchStatus}</Badge>
          {currentBatches.length > 0 ? ` · ${currentBatches.length} batch(es), ${currentBatchItems.length} item(s)` : null}
        </CardContent>
      </Card>
    </div>
  );
}
