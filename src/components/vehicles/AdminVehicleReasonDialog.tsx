import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type Props = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  requireReason?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
};

/** Shared confirm + reason dialog for suspend / archive / reassign / return. */
export function AdminVehicleReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive,
  requireReason = true,
  busy,
  onClose,
  onConfirm,
}: Props) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason('');
  }, [open, title]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {requireReason ? (
          <div className="space-y-2">
            <Label htmlFor="vehicle-action-reason">Reason</Label>
            <Textarea
              id="vehicle-action-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Required for the audit record"
              rows={3}
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy || (requireReason && !reason.trim())}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
