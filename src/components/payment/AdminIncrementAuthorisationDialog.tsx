/**
 * Admin same-order Revolut incremental authorisation dialog.
 * Calls admin-increment-revolut-authorisation only — never Revolut from the browser.
 */
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Loader2, ShieldPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useStaffProfile } from '@/hooks/useStaffProfile';
import { formatMoneyMinor } from '@/lib/formatMoneyMinor';

type PreviewPayload = {
  preview?: boolean;
  eligible?: boolean;
  reason?: string;
  provider_confirmed_authorised_total_pence?: number;
  original_hold_pence?: number;
  target_total_authorised_pence?: number;
  max_provider_eligible_target_pence?: number;
  increment_count?: number;
  max_increments?: number;
  payment_method_type?: string | null;
  financial_operation_state?: string | null;
  error?: string;
};

type Props = {
  paymentSessionId: string;
  tripId?: string | null;
  /** Optional current/final fare hint (pence) — never sent as an authoritative amount alone. */
  suggestedTargetPence?: number | null;
  currency?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void;
};

export function AdminIncrementAuthorisationDialog({
  paymentSessionId,
  tripId,
  suggestedTargetPence,
  currency = 'GBP',
  open,
  onOpenChange,
  onComplete,
}: Props) {
  const { canAccessPage, staffProfile } = useStaffProfile();
  const permitted =
    staffProfile?.role === 'super_admin'
    || canAccessPage('payments-increment-authorisation');

  const [targetMajor, setTargetMajor] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<PreviewPayload | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setReason('');
    if (suggestedTargetPence != null && Number.isFinite(suggestedTargetPence) && suggestedTargetPence > 0) {
      setTargetMajor((suggestedTargetPence / 100).toFixed(2));
    } else {
      setTargetMajor('');
    }
  }, [open, suggestedTargetPence]);

  const previewMutation = useMutation({
    mutationFn: async () => {
      const targetPence = Math.round(Number(targetMajor) * 100);
      if (!Number.isFinite(targetPence) || targetPence < 1) {
        throw new Error('Enter a valid target authorised total');
      }
      const { data, error } = await supabase.functions.invoke(
        'admin-increment-revolut-authorisation',
        {
          body: {
            payment_session_id: paymentSessionId,
            target_total_authorised_pence: targetPence,
            reason: reason.trim() || 'preview',
            preview_only: true,
          },
        },
      );
      if (error) {
        throw new Error((data as { error?: string } | null)?.error || error.message);
      }
      return data as PreviewPayload;
    },
    onSuccess: (data) => setPreview(data),
    onError: (err: Error) => toast.error(err.message),
  });

  const executeMutation = useMutation({
    mutationFn: async () => {
      const targetPence = Math.round(Number(targetMajor) * 100);
      if (!Number.isFinite(targetPence) || targetPence < 1) {
        throw new Error('Enter a valid target authorised total');
      }
      if (reason.trim().length < 3) {
        throw new Error('A reason is required');
      }
      const { data, error } = await supabase.functions.invoke(
        'admin-increment-revolut-authorisation',
        {
          body: {
            payment_session_id: paymentSessionId,
            target_total_authorised_pence: targetPence,
            reason: reason.trim(),
            trip_id: tripId ?? undefined,
          },
        },
      );
      if (error) {
        throw new Error((data as { error?: string } | null)?.error || error.message);
      }
      const payload = data as { success?: boolean; error?: string; provider_confirmed_authorised_total_pence?: number };
      if (payload.success === false) {
        throw new Error(payload.error || 'Increment failed');
      }
      return payload;
    },
    onSuccess: (data) => {
      toast.success(
        `Authorised total updated to ${formatMoneyMinor(
          Number(data.provider_confirmed_authorised_total_pence ?? 0),
          currency,
        )}`,
      );
      onOpenChange(false);
      onComplete?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!permitted) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Increment authorisation</DialogTitle>
            <DialogDescription>
              You do not have permission to increment Revolut authorisations.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const busy = previewMutation.isPending || executeMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldPlus className="h-4 w-4" />
            Same-order increment authorisation
          </DialogTitle>
          <DialogDescription>
            Raises the authorised hold on the existing Revolut order. Does not create a second charge.
            Session {paymentSessionId.slice(0, 8)}…
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="inc-target">Target authorised total ({currency})</Label>
            <Input
              id="inc-target"
              inputMode="decimal"
              value={targetMajor}
              onChange={(e) => setTargetMajor(e.target.value)}
              placeholder="e.g. 25.00"
              disabled={busy}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="inc-reason">Reason (required)</Label>
            <Textarea
              id="inc-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this increment is required"
              disabled={busy}
              rows={3}
            />
          </div>

          {preview && (
            <div className="rounded-md border p-3 text-sm space-y-1">
              <div className="flex items-center gap-2">
                <span>Eligible</span>
                <Badge variant={preview.eligible ? 'default' : 'destructive'}>
                  {preview.eligible ? 'yes' : preview.reason ?? 'no'}
                </Badge>
              </div>
              <div>
                Provider authorised:{' '}
                {formatMoneyMinor(preview.provider_confirmed_authorised_total_pence ?? 0, currency)}
              </div>
              <div>
                Original hold:{' '}
                {formatMoneyMinor(preview.original_hold_pence ?? 0, currency)}
              </div>
              <div>
                Max eligible target:{' '}
                {formatMoneyMinor(preview.max_provider_eligible_target_pence ?? 0, currency)}
              </div>
              <div>
                Increments used: {preview.increment_count ?? 0}
                {preview.max_increments != null ? ` / ${preview.max_increments}` : ''}
              </div>
              <div>Payment method (provider): {preview.payment_method_type ?? 'unknown'}</div>
              <div>Operation state: {preview.financial_operation_state ?? 'IDLE'}</div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !targetMajor}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Preview'}
          </Button>
          <Button
            disabled={busy || !preview?.eligible || reason.trim().length < 3}
            onClick={() => executeMutation.mutate()}
          >
            {executeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Increment hold'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
