import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { getCurrencySymbol } from '@/lib/regionSettings';
import {
  DRIVER_WALLET_ADJUSTMENT_MIN_NOTE_LENGTH,
  DRIVER_WALLET_ADJUSTMENT_OWNER_THRESHOLD_PENCE,
  DRIVER_WALLET_ADJUSTMENT_REASON_CATEGORIES,
  DRIVER_WALLET_ADJUSTMENT_REASON_LABELS,
  type DriverWalletAdjustmentReasonCategory,
} from '../../../shared/driverWalletManualAdjustmentSSOT';

type Direction = 'credit' | 'debit';

export function DriverWalletAdjustmentDialog({
  open,
  onOpenChange,
  driverId,
  driverName,
  currencyCode = 'GBP',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driverId: string;
  driverName?: string | null;
  currencyCode?: string;
}) {
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<Direction>('credit');
  const [amount, setAmount] = useState('');
  const [reasonCategory, setReasonCategory] = useState<DriverWalletAdjustmentReasonCategory>('goodwill_credit');
  const [reasonNote, setReasonNote] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const amountPencePreview = useMemo(() => {
    const parsed = Math.round(parseFloat(amount) * 100);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [amount]);

  const needsOwnerPreview = amountPencePreview >= DRIVER_WALLET_ADJUSTMENT_OWNER_THRESHOLD_PENCE
    || direction === 'debit';

  const resetForm = () => {
    setDirection('credit');
    setAmount('');
    setReasonCategory('goodwill_credit');
    setReasonNote('');
    setEvidenceReference('');
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('admin-driver-adjustment', {
        body: {
          action: 'create',
          driver_id: driverId,
          direction,
          amount_pence: amountPencePreview,
          reason_category: reasonCategory,
          reason_note: reasonNote.trim(),
          evidence_reference: evidenceReference.trim() || undefined,
          idempotency_key: idempotencyKey,
        },
      });
      if (error) throw error;
      if (data?.error) {
        const err = new Error(String(data.error));
        (err as Error & { code?: string }).code = data.error_code;
        throw err;
      }
      return data;
    },
    onSuccess: (data) => {
      const status = String(data?.status ?? data?.adjustment?.status ?? 'APPLIED');
      if (status === 'PENDING_APPROVAL') {
        toast.message('Adjustment submitted for owner approval', {
          description: 'An owner must approve before the ledger row is applied.',
        });
      } else {
        toast.success('Driver wallet adjustment applied');
      }
      void queryClient.invalidateQueries({ queryKey: ['finance-ledger-transactions'] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot-detail', driverId] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-pending-adjustments', driverId] });
      resetForm();
      onOpenChange(false);
    },
    onError: (error: Error & { code?: string }) => {
      toast.error(error.message || 'Failed to create adjustment');
    },
  });

  const canSubmit = amountPencePreview >= 1
    && reasonNote.trim().length >= DRIVER_WALLET_ADJUSTMENT_MIN_NOTE_LENGTH;

  const currencySymbol = getCurrencySymbol(currencyCode);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetForm();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add adjustment</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <p className="text-sm text-muted-foreground">
            {driverName ? `${driverName} · ` : ''}
            Append-only Driver Wallet Ledger entry. No Payment Sessions or payout execution.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as Direction)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="credit">Credit driver</SelectItem>
                  <SelectItem value="debit">Debit driver</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Amount ({currencySymbol})</Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Reason category</Label>
            <Select
              value={reasonCategory}
              onValueChange={(v) => setReasonCategory(v as DriverWalletAdjustmentReasonCategory)}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {DRIVER_WALLET_ADJUSTMENT_REASON_CATEGORIES.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {DRIVER_WALLET_ADJUSTMENT_REASON_LABELS[cat]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>
              Reason note <span className="text-destructive">*</span>
              <span className="text-xs text-muted-foreground font-normal ml-1">
                (min {DRIVER_WALLET_ADJUSTMENT_MIN_NOTE_LENGTH} characters)
              </span>
            </Label>
            <Textarea
              rows={3}
              value={reasonNote}
              onChange={(e) => setReasonNote(e.target.value)}
              placeholder="Explain why this adjustment is required…"
            />
          </div>

          <div className="space-y-2">
            <Label>
              Evidence / reference
              <span className="text-xs text-muted-foreground font-normal ml-1">(optional)</span>
            </Label>
            <Input
              placeholder="Trip code, payout item, support ticket, or admin note"
              value={evidenceReference}
              onChange={(e) => setEvidenceReference(e.target.value)}
            />
          </div>

          {needsOwnerPreview ? (
            <Alert>
              <AlertDescription>
                This adjustment may require owner approval before it is applied
                {amountPencePreview >= DRIVER_WALLET_ADJUSTMENT_OWNER_THRESHOLD_PENCE
                  ? ` (amount ≥ ${currencySymbol}${(DRIVER_WALLET_ADJUSTMENT_OWNER_THRESHOLD_PENCE / 100).toFixed(2)})`
                  : ''}
                {direction === 'debit' ? '. Debits that exceed available balance always require owner approval.' : '.'}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { resetForm(); onOpenChange(false); }}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!canSubmit || mutation.isPending}
          >
            {mutation.isPending ? 'Submitting…' : 'Submit adjustment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
