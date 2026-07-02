import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatPence } from '@/hooks/useDriverWallet';
import type { ConnectBalanceAccount } from '@/hooks/useConnectPayoutStatus';
import { invokeConnectManualPayout } from '@/hooks/useConnectPayoutStatus';

export function ConnectManualPayoutDialog({
  driver,
  currencyCode,
  open,
  onOpenChange,
  onSuccess,
}: {
  driver: ConnectBalanceAccount | null;
  currencyCode: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const queryClient = useQueryClient();
  const [amountPounds, setAmountPounds] = useState('');
  const [reason, setReason] = useState('');

  const ccy = driver?.currency ?? currencyCode;
  const maxPence = driver?.max_manual_connect_payout_pence ?? 0;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!driver) throw new Error('No driver selected');
      const pounds = Number(amountPounds);
      if (!Number.isFinite(pounds) || pounds <= 0) {
        throw new Error('Enter a valid amount');
      }
      const amount_pence = Math.round(pounds * 100);
      return invokeConnectManualPayout({
        driver_id: driver.driver_id,
        amount_pence,
        reason: reason.trim() || 'Connect balance manual payout',
      });
    },
    onSuccess: (data) => {
      if (data?.success) {
        toast.success('Connect payout created and ledger updated');
        queryClient.invalidateQueries({ queryKey: ['connect-payout-status'] });
        queryClient.invalidateQueries({ queryKey: ['finance-reconciliation-ssot-fallback'] });
        queryClient.invalidateQueries({ queryKey: ['finance-reconciliation-ssot-ledger'] });
        queryClient.invalidateQueries({ queryKey: ['finance-reconciliation-summary'] });
        onSuccess();
      } else {
        toast.error(data?.error ?? 'Payout failed');
      }
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setAmountPounds('');
      setReason('');
    }
    onOpenChange(next);
  };

  if (!driver) return null;

  const suggestedPounds = (maxPence / 100).toFixed(2);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Manual payout from Connect</DialogTitle>
          <DialogDescription>
            Creates a Stripe payout from funds already on the driver&apos;s Connect account. Does not
            change ONECAB payout SSOT rules — amount is capped server-side.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <Row label="Driver" value={`${driver.driver_name} (${driver.driver_code ?? driver.driver_id.slice(0, 8)})`} />
          <Row label="Connect Available" value={formatPence(driver.connect_available_pence, ccy)} />
          <Row label="ONECAB Available Now" value={formatPence(driver.onecab_available_now_pence, ccy)} highlight />
          <Row label="Max allowed payout" value={formatPence(maxPence, ccy)} highlight />

          <Alert>
            <AlertDescription>
              Payout = min(available now, Connect available). Driver Stripe positions live on Driver Wallet Ledger → Overview.
            </AlertDescription>
          </Alert>

          <div>
            <Label htmlFor="connect-payout-amount">Amount ({ccy})</Label>
            <Input
              id="connect-payout-amount"
              type="number"
              min={0.01}
              max={maxPence / 100}
              step={0.01}
              placeholder={suggestedPounds}
              value={amountPounds}
              onChange={(e) => setAmountPounds(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="connect-payout-reason">Reason (audit log)</Label>
            <Textarea
              id="connect-payout-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Release stranded Connect balance after manual schedule lockdown"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || maxPence <= 0}
          >
            {mutation.isPending ? 'Processing…' : 'Confirm Connect payout'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={highlight ? 'font-semibold' : ''}>{value}</span>
    </div>
  );
}
