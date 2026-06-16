/**
 * Trip invoice display — uses generated invoice snapshots (invoice_total_paid_pence).
 * TODO(Phase 1D): Future invoice writer must persist settlement fare (getTripSettlementFarePence)
 * at generation time; do not regenerate historical invoices without explicit approval.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { FileText, Download, Mail, RefreshCw, Loader2, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';

export interface TripInvoiceFields {
  id: string;
  trip_code: string | null;
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
}

type InvoiceAction = 'download' | 'view' | 'resend_email' | 'regenerate';

interface InvoiceActionResult {
  success?: boolean;
  ok?: boolean;
  error?: string;
  message?: string;
  pdfUrl?: string;
  pdf_url?: string;
  htmlUrl?: string;
  html_url?: string;
  invoiceNo?: string;
  invoice_no?: string;
  invoice_pdf_url?: string;
  invoiceGeneratedAt?: string;
  invoice_generated_at?: string;
  invoiceEmailStatus?: string;
  invoice_email_status?: string;
  invoiceEmailSentAt?: string;
  invoice_email_sent_at?: string;
  stage?: string;
}

function hasSuccessfulInvoicePdf(trip: TripInvoiceFields): boolean {
  return Boolean(trip.invoice_generated_at || trip.invoice_pdf_url);
}

function getInvoiceStatusLabel(trip: TripInvoiceFields): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  const pdfReady = hasSuccessfulInvoicePdf(trip);
  const emailSent = Boolean(trip.invoice_email_sent || trip.invoice_email_status === 'sent');

  if (emailSent && pdfReady) {
    return { label: 'Sent', variant: 'default' };
  }
  if (trip.invoice_pdf_error && !pdfReady) {
    return { label: 'Failed', variant: 'destructive' };
  }
  if (pdfReady && trip.invoice_email_status === 'failed') {
    return { label: 'PDF Ready / Email Failed', variant: 'destructive' };
  }
  if (pdfReady) {
    return { label: emailSent ? 'Sent' : 'Generated', variant: emailSent ? 'default' : 'secondary' };
  }
  return { label: 'Pending', variant: 'outline' };
}

function formatPaymentMethod(method: string | null | undefined): string {
  const m = (method ?? '').toLowerCase();
  if (m === 'card') return 'Card';
  if (m === 'cash') return 'Cash';
  return method || '—';
}

function formatTotalPaid(pence: number | null | undefined): string {
  if (pence == null) return '—';
  return `£${(pence / 100).toFixed(2)}`;
}

const INVOICE_ACTION_FAILED = 'Invoice action failed. Please try again or check invoice settings.';

async function invokeInvoiceAction(tripId: string, action: InvoiceAction): Promise<InvoiceActionResult> {
  const { data, error } = await supabase.functions.invoke('trip-invoice-process', {
    body: { bookingId: tripId, trip_id: tripId, action },
  });

  if (error) {
    const ctx = (error as { context?: Response })?.context;
    if (ctx) {
      try {
        const payload = await ctx.json();
        if (payload?.error) throw new Error(payload.error);
      } catch {
        // ignore parse errors
      }
    }
    throw new Error(error.message || INVOICE_ACTION_FAILED);
  }

  const result = (data ?? {}) as InvoiceActionResult;
  if (result.success === false || (result.ok === false && result.error)) {
    throw new Error(result.error || INVOICE_ACTION_FAILED);
  }

  return result;
}

interface TripInvoiceCardProps {
  trip: TripInvoiceFields;
  onUpdated?: () => void;
  compact?: boolean;
}

export function TripInvoiceCard({ trip, onUpdated, compact = false }: TripInvoiceCardProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const status = getInvoiceStatusLabel(trip);

  const runAction = async (key: string, action: InvoiceAction, onSuccess?: (result: InvoiceActionResult) => void) => {
    setLoading(key);
    try {
      const result = await invokeInvoiceAction(trip.id, action);
      onSuccess?.(result);
      if (action === 'download') {
        toast.success('Invoice downloaded successfully');
      } else if (action === 'regenerate') {
        toast.success('Invoice PDF generated successfully');
      } else if (action === 'resend_email') {
        toast.success('Invoice email sent successfully');
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

  const openUrl = (url?: string | null) => {
    if (!url) throw new Error(INVOICE_ACTION_FAILED);
    window.open(url, '_blank', 'noopener,noreferrer');
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
          <Label className="text-xs text-muted-foreground">Total Paid</Label>
          <p className="font-medium">{formatTotalPaid(trip.invoice_total_paid_pence)}</p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Generated</Label>
          <p>{trip.invoice_generated_at ? format(new Date(trip.invoice_generated_at), 'MMM d, yyyy HH:mm') : '—'}</p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Email Status</Label>
          <p>{trip.invoice_email_status || (trip.invoice_email_sent ? 'sent' : '—')}</p>
        </div>
        {trip.invoice_email_sent_at && (
          <div className="col-span-2">
            <Label className="text-xs text-muted-foreground">Email Sent</Label>
            <p>{format(new Date(trip.invoice_email_sent_at), 'MMM d, yyyy HH:mm')}</p>
          </div>
        )}
        {trip.invoice_pdf_url && (
          <div className="col-span-2">
            <Label className="text-xs text-muted-foreground">Invoice PDF URL</Label>
            <p className="font-mono text-xs break-all text-muted-foreground">{trip.invoice_pdf_url}</p>
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
      </div>

      <Separator />

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => runAction('download', 'download', (r) => openUrl(r.pdfUrl ?? r.pdf_url ?? r.invoice_pdf_url ?? trip.invoice_pdf_url))}
          disabled={!!loading}
        >
          {loading === 'download' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Download className="h-4 w-4 mr-1" />}
          Download Invoice
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => runAction('view', 'view', (r) => openUrl(r.pdfUrl ?? r.pdf_url ?? trip.invoice_pdf_url))}
          disabled={!!loading}
        >
          {loading === 'view' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ExternalLink className="h-4 w-4 mr-1" />}
          View Invoice
        </Button>
        <Button size="sm" variant="outline" onClick={() => runAction('resend', 'resend_email')} disabled={!!loading}>
          {loading === 'resend' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Mail className="h-4 w-4 mr-1" />}
          Resend Email
        </Button>
        <Button size="sm" variant="secondary" onClick={() => runAction('regenerate', 'regenerate')} disabled={!!loading}>
          {loading === 'regenerate' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
          Regenerate PDF
        </Button>
      </div>
    </div>
  );
}

export function TripInvoiceStatusBadge({ trip }: { trip: TripInvoiceFields }) {
  const status = getInvoiceStatusLabel(trip);
  return <Badge variant={status.variant} className="text-[10px]">{status.label}</Badge>;
}
