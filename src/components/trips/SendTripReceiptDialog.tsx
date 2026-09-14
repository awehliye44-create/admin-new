import { useRef, useState } from 'react';
import { Loader2, Mail } from 'lucide-react';
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
import { sendTripReceiptEmail } from '@/lib/tripInvoiceActions';

type Props = {
  tripId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSendingChange?: (sending: boolean) => void;
  onSent?: (sentAt: string) => void;
  onFailed?: () => void;
};

export function SendTripReceiptDialog({
  tripId,
  open,
  onOpenChange,
  onSendingChange,
  onSent,
  onFailed,
}: Props) {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);

  const close = () => {
    if (inFlight.current) return;
    onOpenChange(false);
  };

  const send = () => {
    if (inFlight.current) return;
    const trimmed = email.trim();
    if (!trimmed) {
      toast.error('Enter an email address');
      return;
    }
    inFlight.current = true;
    setSending(true);
    onSendingChange?.(true);
    void sendTripReceiptEmail(tripId, trimmed)
      .then((result) => {
        if (result.status === 'sending') {
          toast.message('Sending…');
          return;
        }
        inFlight.current = false;
        setSending(false);
        onSendingChange?.(false);
        const sentAt = result.invoice_email_sent_at ?? new Date().toISOString();
        toast.success('Receipt sent');
        onSent?.(sentAt);
        onOpenChange(false);
        setEmail('');
      })
      .catch(() => {
        toast.error('Could not send receipt');
        inFlight.current = false;
        setSending(false);
        onSendingChange?.(false);
        onFailed?.();
      });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Email receipt</DialogTitle>
          <DialogDescription>
            Send this trip’s receipt to an email address. Nothing is sent until you confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`receipt-email-${tripId}`}>Email</Label>
          <Input
            id={`receipt-email-${tripId}`}
            type="email"
            autoComplete="email"
            value={email}
            disabled={sending}
            placeholder="name@example.com"
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                send();
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={sending} onClick={close}>
            Cancel
          </Button>
          <Button type="button" disabled={sending} onClick={send}>
            {sending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Mail className="mr-1 h-4 w-4" />}
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
