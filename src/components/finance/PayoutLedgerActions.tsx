import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { supabase } from '@/integrations/supabase/client';
import { formatNullablePence } from '@/lib/formatNullablePence';
import {
  CRITICAL_BUTTON_TIMEOUT_MESSAGE,
  useCriticalButtonTimeout,
} from '@/lib/criticalButtonTimeout';
import { startAdminPerformanceStep } from '@/lib/recordAdminPerformanceStep';

/** Payout Ledger–owned writers only. Do not mount on Driver Wallet. */
export function PayoutLedgerCreateWeeklyBatchButton({
  regionId,
  currencyCode = 'GBP',
}: {
  regionId?: string | null;
  currencyCode?: string;
}) {
  const queryClient = useQueryClient();
  const [creatingBatch, setCreatingBatch] = useState(false);
  const runPayoutsTimeout = useCriticalButtonTimeout({
    action: 'admin_run_payouts',
    isPending: creatingBatch,
    onTimeout: () => {
      setCreatingBatch(false);
      toast.error(CRITICAL_BUTTON_TIMEOUT_MESSAGE);
    },
  });

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
      const total = data?.total_amount_pence == null
        ? null
        : Number(data.total_amount_pence);
      toast.success(
        data?.batch_id
          ? `Weekly batch created (${data.ready_count ?? 0} driver(s)${total == null ? '' : `, ${formatNullablePence(total, currencyCode)}`})`
          : 'Weekly settlement completed',
      );
      void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot'] });
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

  return (
    <Button
      size="sm"
      onClick={() => void handleCreateWeeklyBatch()}
      disabled={runPayoutsTimeout.showSpinner || !regionId}
    >
      {runPayoutsTimeout.showSpinner ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
      Create weekly batch
    </Button>
  );
}

export function PayoutLedgerMarkPaidButton({
  payoutItemId,
  amountPence,
  currencyCode = 'GBP',
  disabled = false,
}: {
  payoutItemId: string;
  amountPence: number | null;
  currencyCode?: string;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [providerReference, setProviderReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const payDriverTimeout = useCriticalButtonTimeout({
    action: 'admin_pay_driver',
    isPending: submitting,
    onTimeout: () => {
      setSubmitting(false);
      toast.error(CRITICAL_BUTTON_TIMEOUT_MESSAGE);
    },
  });

  const handleMarkPaid = async () => {
    const reference = providerReference.trim();
    if (reference.length < 3) {
      toast.error('Enter the Revolut transfer reference (min 3 characters)');
      return;
    }
    setSubmitting(true);
    const perf = startAdminPerformanceStep({
      action_name: 'admin_pay_driver',
      metadata: { payout_item_id: payoutItemId },
    });
    try {
      const { data, error } = await supabase.functions.invoke('admin-mark-manual-payout-paid', {
        body: {
          payout_item_id: payoutItemId,
          provider_reference: reference,
          confirm_manual_payout: true,
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(String(data.error));
      perf.complete({ success: true });
      toast.success('Payout marked paid — wallet ledger debited');
      setOpen(false);
      setProviderReference('');
      void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot'] });
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

  return (
    <>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        Mark paid
      </Button>
      <Dialog open={open} onOpenChange={(next) => !next && setOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark payout paid</DialogTitle>
            <DialogDescription>
              Confirm the Revolut Business bank transfer for{' '}
              {formatNullablePence(amountPence, currencyCode)}.
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
            <Button variant="outline" onClick={() => setOpen(false)} disabled={payDriverTimeout.showSpinner}>
              Cancel
            </Button>
            <Button onClick={() => void handleMarkPaid()} disabled={payDriverTimeout.showSpinner}>
              {payDriverTimeout.showSpinner ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Confirm paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
