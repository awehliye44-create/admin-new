import { useState } from 'react';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPence } from '@/hooks/useDriverWallet';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { supabase } from '@/integrations/supabase/client';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  CRITICAL_BUTTON_TIMEOUT_MESSAGE,
  useCriticalButtonTimeout,
} from '@/lib/criticalButtonTimeout';
import { startAdminPerformanceStep } from '@/lib/recordAdminPerformanceStep';

const ACTIVE_BATCH_STATUSES = new Set(['pending', 'processing', 'ready', 'transfer_created']);

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

function providerPayoutLabel(pi: Record<string, unknown>): string {
  const ref = pi.provider_reference;
  if (ref) return String(ref);
  return String(pi.stripe_payout_id ?? pi.stripe_transfer_id ?? '—');
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
  regionId,
  manualPayoutMode = false,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  isLoading?: boolean;
  regionId?: string | null;
  /** Revolut/manual bank payout — show mark-paid instead of Stripe transfer ids. */
  manualPayoutMode?: boolean;
}) {
  const queryClient = useQueryClient();
  const [markPaidItem, setMarkPaidItem] = useState<Record<string, unknown> | null>(null);
  const [providerReference, setProviderReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [creatingBatch, setCreatingBatch] = useState(false);
  const runPayoutsTimeout = useCriticalButtonTimeout({
    action: 'admin_run_payouts',
    isPending: creatingBatch,
    onTimeout: () => {
      setCreatingBatch(false);
      toast.error(CRITICAL_BUTTON_TIMEOUT_MESSAGE);
    },
  });
  const payDriverTimeout = useCriticalButtonTimeout({
    action: 'admin_pay_driver',
    isPending: submitting,
    onTimeout: () => {
      setSubmitting(false);
      toast.error(CRITICAL_BUTTON_TIMEOUT_MESSAGE);
    },
  });

  const invalidateWallet = () => {
    void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot'] });
  };

  const handleCreateWeeklyBatch = async () => {
    if (!regionId) {
      toast.error('Select a service area / region before creating a weekly batch');
      return;
    }
    setCreatingBatch(true);
    const perf = startAdminPerformanceStep({ action_name: 'admin_run_payouts' });
    try {
      const { data, error } = await supabase.functions.invoke('admin-weekly-monday-settlement', {
        body: { region_id: regionId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(String(data.error));
      perf.complete({ success: true });
      toast.success(
        data?.batch_id
          ? `Weekly batch created (${data.ready_count ?? 0} driver(s), ${formatPence(Number(data.total_amount_pence ?? 0), currencyCode)})`
          : 'Weekly settlement completed',
      );
      invalidateWallet();
    } catch (err) {
      perf.complete({
        success: false,
        error_code: err instanceof Error ? err.message : 'batch_failed',
      });
      toast.error(err instanceof Error ? err.message : 'Failed to create weekly batch');
    } finally {
      setCreatingBatch(false);
    }
  };

  const handleMarkPaid = async () => {
    if (!markPaidItem?.id) return;
    const reference = providerReference.trim();
    if (reference.length < 3) {
      toast.error('Enter the Revolut transfer reference (min 3 characters)');
      return;
    }
    setSubmitting(true);
    const perf = startAdminPerformanceStep({
      action_name: 'admin_pay_driver',
      metadata: { payout_item_id: String(markPaidItem.id) },
    });
    try {
      const { data, error } = await supabase.functions.invoke('admin-mark-manual-payout-paid', {
        body: {
          payout_item_id: String(markPaidItem.id),
          provider_reference: reference,
          confirm_manual_payout: true,
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(String(data.error));
      perf.complete({ success: true });
      toast.success('Payout marked paid — wallet ledger debited');
      setMarkPaidItem(null);
      setProviderReference('');
      invalidateWallet();
    } catch (err) {
      perf.complete({
        success: false,
        error_code: err instanceof Error ? err.message : 'pay_failed',
      });
      toast.error(err instanceof Error ? err.message : 'Failed to mark payout paid');
    } finally {
      setSubmitting(false);
    }
  };

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

  const renderItemTable = (
    rows: Array<Record<string, unknown>>,
    empty: string,
    options?: { showMarkPaid?: boolean },
  ) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Batch</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>{manualPayoutMode ? 'Bank reference' : 'Provider transfer'}</TableHead>
          {!manualPayoutMode ? <TableHead>Provider payout</TableHead> : null}
          <TableHead>Updated</TableHead>
          {options?.showMarkPaid ? <TableHead className="text-right">Action</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={manualPayoutMode ? (options?.showMarkPaid ? 6 : 5) : (options?.showMarkPaid ? 7 : 6)}
              className="text-center text-muted-foreground py-6"
            >
              {empty}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((pi) => (
            <TableRow key={String(pi.id)}>
              <TableCell className="font-mono text-xs">{batchLabel(pi)}</TableCell>
              <TableCell className="text-right">{fmt(payoutAmount(pi))}</TableCell>
              <TableCell>
                <Badge variant="outline">{String(pi.status ?? '—')}</Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">{providerPayoutLabel(pi)}</TableCell>
              {!manualPayoutMode ? (
                <TableCell className="font-mono text-xs">{String(pi.stripe_payout_id ?? '—')}</TableCell>
              ) : null}
              <TableCell className="text-xs">{formatDate((pi.updated_at ?? pi.created_at) as string)}</TableCell>
              {options?.showMarkPaid && isActiveBatchItem(pi) ? (
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" onClick={() => setMarkPaidItem(pi)}>
                    Mark paid
                  </Button>
                </TableCell>
              ) : options?.showMarkPaid ? (
                <TableCell />
              ) : null}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );

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

  const activeBatchStatus = currentBatches[0]?.status ?? (currentBatchItems.length > 0 ? String(currentBatchItems[0].status ?? '—') : '—');

  return (
    <div className="space-y-6">
      {manualPayoutMode ? (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">Revolut manual payout</CardTitle>
            <Button size="sm" onClick={handleCreateWeeklyBatch} disabled={runPayoutsTimeout.showSpinner || !regionId}>
              {runPayoutsTimeout.showSpinner ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Create weekly batch
            </Button>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Pay drivers from Revolut Business, then mark each payout item paid with the bank transfer reference.
            Ledger debits only run after mark-paid — never before the transfer is confirmed.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Current batch</CardTitle>
        </CardHeader>
        <CardContent>
          {renderItemTable(currentBatchItems, 'No active payout batch', { showMarkPaid: manualPayoutMode })}
        </CardContent>
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

      <Dialog open={Boolean(markPaidItem)} onOpenChange={(open) => !open && setMarkPaidItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark payout paid</DialogTitle>
            <DialogDescription>
              Confirm the Revolut Business bank transfer for {fmt(markPaidItem ? payoutAmount(markPaidItem) : 0)}.
              This posts a ledger debit and cannot be undone automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="provider-reference">Transfer reference</Label>
            <Input
              id="provider-reference"
              placeholder="Revolut payment reference"
              value={providerReference}
              onChange={(e) => setProviderReference(e.target.value)}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMarkPaidItem(null)} disabled={payDriverTimeout.showSpinner}>
              Cancel
            </Button>
            <Button onClick={handleMarkPaid} disabled={payDriverTimeout.showSpinner}>
              {payDriverTimeout.showSpinner ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Confirm paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
