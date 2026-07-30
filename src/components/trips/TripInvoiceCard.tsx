/**
 * Trip invoice display — uses generated invoice snapshots (invoice_total_paid_pence).
 * Label: Final Settlement Total. Do not recalculate on display; writer persists SSOT at generation.
 * Writer: onecab-comfy-ride/supabase/functions/trip-invoice-process (getTripSettlementFarePence).
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { FileText, Download, Mail, RefreshCw, Loader2, ExternalLink, Share2 } from 'lucide-react';
import { format } from 'date-fns';
import {
  type InvoiceAction,
  type InvoiceActionResult,
  invokeInvoiceAction,
  openInvoiceUrl,
  resolveInvoicePdfUrl,
  shareTripInvoicePdf,
} from '@/lib/tripInvoiceActions';
import { maskEmailForAdmin } from '@/lib/maskEmailForAdmin';
import { getTripDisplayId } from '@/lib/tripUtils';

export interface TripInvoiceFields {
  id: string;
  trip_code: string | null;
  trip_number?: string | null;
  payment_method: string | null;
  invoice_no: string | null;
  invoice_pdf_url: string | null;
  invoice_generated_at: string | null;
  invoice_email_sent: boolean | null;
  invoice_email_sent_at: string | null;
  invoice_email_status: string | null;
  invoice_email_error: string | null;
  invoice_pdf_error: string | null;
  invoice_total_paid_pence: number | null;
  invoice_regenerated_at: string | null;
  invoice_delivery_status?: string | null;
  invoice_recipient_email_snapshot?: string | null;
  invoice_provider_message_id?: string | null;
}

function hasSuccessfulInvoicePdf(trip: TripInvoiceFields): boolean {
  return Boolean(trip.invoice_generated_at || trip.invoice_pdf_url);
}

function getInvoiceStatusLabel(trip: TripInvoiceFields): {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
} {
  const delivery = trip.invoice_delivery_status ?? trip.invoice_email_status;
  const pdfReady = hasSuccessfulInvoicePdf(trip);
  const emailSent = Boolean(
    trip.invoice_email_sent || delivery === 'sent' || delivery === 'delivered',
  );

  const map: Record<
    string,
    { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
  > = {
    not_ready: { label: 'Not ready', variant: 'outline' },
    queued: { label: 'Queued', variant: 'outline' },
    generating: { label: 'Generating', variant: 'secondary' },
    generated: { label: 'Generated', variant: 'secondary' },
    sending: { label: 'Sending', variant: 'secondary' },
    sent: { label: 'Sent', variant: 'default' },
    delivered: { label: 'Delivered', variant: 'default' },
    recipient_missing: { label: 'Recipient missing', variant: 'destructive' },
    recipient_unverified: { label: 'Recipient unverified', variant: 'destructive' },
    recipient_policy_violation: { label: 'Recipient policy violation', variant: 'destructive' },
    generation_failed: { label: 'Generation failed', variant: 'destructive' },
    delivery_failed: { label: 'Delivery failed', variant: 'destructive' },
    bounced: { label: 'Bounced', variant: 'destructive' },
    suppressed: { label: 'Suppressed', variant: 'outline' },
    failed: { label: 'Delivery failed', variant: 'destructive' },
  };

  if (delivery && map[delivery]) return map[delivery];

  if (emailSent && pdfReady) {
    return { label: 'Sent', variant: 'default' };
  }
  if (trip.invoice_pdf_error && !pdfReady) {
    return { label: 'Generation failed', variant: 'destructive' };
  }
  if (pdfReady && trip.invoice_email_status === 'failed') {
    return { label: 'Delivery failed', variant: 'destructive' };
  }
  if (pdfReady) {
    return { label: emailSent ? 'Sent' : 'Generated', variant: emailSent ? 'default' : 'secondary' };
  }
  return { label: 'Not ready', variant: 'outline' };
}

function formatPaymentMethod(method: string | null | undefined): string {
  const m = (method ?? '').toLowerCase();
  if (m === 'card') return 'Card';
  if (m === 'wallet' || m === 'apple_pay' || m === 'google_pay') return 'Digital wallet';
  return method || '—';
}

function formatTotalPaid(pence: number | null | undefined): string {
  if (pence == null) return '—';
  return `£${(pence / 100).toFixed(2)}`;
}

const INVOICE_ACTION_FAILED = 'Invoice action failed. Please try again or check invoice settings.';

interface TripInvoiceCardProps {
  trip: TripInvoiceFields;
  onUpdated?: () => void;
  compact?: boolean;
}

export function TripInvoiceCard({ trip, onUpdated, compact = false }: TripInvoiceCardProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [resendOpen, setResendOpen] = useState(false);
  const [maskedRecipient, setMaskedRecipient] = useState<string | null>(null);
  const [resendPreviewError, setResendPreviewError] = useState<string | null>(null);
  const status = getInvoiceStatusLabel(trip);
  const tripLabel = getTripDisplayId(trip);
  const displayMasked =
    maskedRecipient ?? maskEmailForAdmin(trip.invoice_recipient_email_snapshot ?? null);

  const runAction = async (
    key: string,
    action: InvoiceAction,
    onSuccess?: (result: InvoiceActionResult) => void,
  ) => {
    setLoading(key);
    try {
      const result = await invokeInvoiceAction(trip.id, action);
      onSuccess?.(result);
      if (action === 'download') {
        toast.success('Invoice downloaded successfully');
      } else if (action === 'regenerate') {
        toast.success('Invoice PDF generated successfully');
      } else if (action === 'resend_email') {
        toast.success(
          result.masked_recipient_email
            ? `Invoice email resent to ${result.masked_recipient_email}`
            : 'Invoice email sent successfully',
        );
      } else {
        toast.success(result.message ?? 'Invoice action completed');
      }
      onUpdated?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : INVOICE_ACTION_FAILED;
      toast.error(`Invoice action failed: ${message}`);
    } finally {
      setLoading(null);
    }
  };

  const openResendConfirm = async () => {
    setLoading('resend_preview');
    setResendPreviewError(null);
    try {
      const preview = await invokeInvoiceAction(trip.id, 'preview_resend_recipient');
      if (!preview.masked_recipient_email) {
        throw new Error(preview.error || 'Could not resolve recipient');
      }
      setMaskedRecipient(preview.masked_recipient_email);
      setResendOpen(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : INVOICE_ACTION_FAILED;
      setResendPreviewError(message);
      toast.error(`Cannot resend: ${message}`);
    } finally {
      setLoading(null);
    }
  };

  if (compact) {
    return (
      <Badge variant={status.variant} className="text-[10px]">
        {status.label}
      </Badge>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Customer Invoice
        </h4>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        Finance details (commission, driver net, Provider fees) are available in Financial
        Reconciliation.
      </p>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <Label className="text-xs text-muted-foreground">Invoice No</Label>
          <p className="font-mono">{trip.invoice_no || '—'}</p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Trip ID</Label>
          <p className="font-mono">{trip.trip_code || '—'}</p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Payment Method</Label>
          <p>{formatPaymentMethod(trip.payment_method)}</p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Invoice Total (snapshot)</Label>
          <p className="font-medium">{formatTotalPaid(trip.invoice_total_paid_pence)}</p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Generated</Label>
          <p>
            {trip.invoice_generated_at
              ? format(new Date(trip.invoice_generated_at), 'MMM d, yyyy HH:mm')
              : '—'}
          </p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Delivery Status</Label>
          <p>{status.label}</p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Masked Recipient</Label>
          <p className="font-mono text-xs">{displayMasked}</p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Provider Message</Label>
          <p className="font-mono text-xs break-all">
            {trip.invoice_provider_message_id
              ? `${trip.invoice_provider_message_id.slice(0, 12)}…`
              : '—'}
          </p>
        </div>
        {trip.invoice_email_sent_at && (
          <div className="col-span-2">
            <Label className="text-xs text-muted-foreground">Last Email Attempt</Label>
            <p>{format(new Date(trip.invoice_email_sent_at), 'MMM d, yyyy HH:mm')}</p>
          </div>
        )}
        {trip.invoice_pdf_url && (
          <div className="col-span-2">
            <Label className="text-xs text-muted-foreground">Invoice PDF URL</Label>
            <p className="font-mono text-xs break-all text-muted-foreground">
              {trip.invoice_pdf_url}
            </p>
          </div>
        )}
        {trip.invoice_pdf_error && !hasSuccessfulInvoicePdf(trip) && (
          <div className="col-span-2 text-destructive text-xs">
            PDF error: {trip.invoice_pdf_error}
          </div>
        )}
        {trip.invoice_email_error && (
          <div className="col-span-2 text-destructive text-xs">
            Email error: {trip.invoice_email_error}
          </div>
        )}
        {resendPreviewError && (
          <div className="col-span-2 text-destructive text-xs">
            Resend blocked: {resendPreviewError}
          </div>
        )}
      </div>

      <Separator />

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            runAction('download', 'download', (r) =>
              openInvoiceUrl(resolveInvoicePdfUrl(r, trip.invoice_pdf_url)),
            )
          }
          disabled={!!loading}
        >
          {loading === 'download' ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <Download className="h-4 w-4 mr-1" />
          )}
          Download Invoice
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            runAction('view', 'view', (r) =>
              openInvoiceUrl(resolveInvoicePdfUrl(r, trip.invoice_pdf_url)),
            )
          }
          disabled={!!loading}
        >
          {loading === 'view' ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <ExternalLink className="h-4 w-4 mr-1" />
          )}
          View Invoice
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!!loading}
          onClick={() => {
            setLoading('share');
            shareTripInvoicePdf(trip.id, tripLabel, trip.invoice_pdf_url)
              .then(() => onUpdated?.())
              .catch((err) => {
                const message = err instanceof Error ? err.message : INVOICE_ACTION_FAILED;
                toast.error(`Share failed: ${message}`);
              })
              .finally(() => setLoading(null));
          }}
        >
          {loading === 'share' ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <Share2 className="h-4 w-4 mr-1" />
          )}
          Share PDF
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void openResendConfirm()}
          disabled={!!loading}
        >
          {loading === 'resend' || loading === 'resend_preview' ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <Mail className="h-4 w-4 mr-1" />
          )}
          Resend Email
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => runAction('regenerate', 'regenerate')}
          disabled={!!loading}
        >
          {loading === 'regenerate' ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-1" />
          )}
          Regenerate PDF
        </Button>
      </div>

      <AlertDialog open={resendOpen} onOpenChange={setResendOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resend this trip invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              Sends to the current confirmed personal recipient for trip{' '}
              <span className="font-mono">{trip.trip_code || trip.id}</span>
              {trip.invoice_no ? (
                <>
                  {' '}
                  (invoice <span className="font-mono">{trip.invoice_no}</span>)
                </>
              ) : null}
              . Masked recipient: <span className="font-mono">{maskedRecipient ?? '—'}</span>. This
              creates a new delivery attempt only — not a second invoice. Company-domain personal
              recipients are rejected by the backend.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!loading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!loading}
              onClick={(e) => {
                e.preventDefault();
                void runAction('resend', 'resend_email').then(() => setResendOpen(false));
              }}
            >
              Confirm resend
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function TripInvoiceStatusBadge({ trip }: { trip: TripInvoiceFields }) {
  const status = getInvoiceStatusLabel(trip);
  return (
    <Badge variant={status.variant} className="text-[10px]">
      {status.label}
    </Badge>
  );
}
