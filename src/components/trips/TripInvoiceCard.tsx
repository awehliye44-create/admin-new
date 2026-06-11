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

function getInvoiceStatusLabel(trip: TripInvoiceFields): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  if (trip.invoice_pdf_error || trip.invoice_email_status === 'failed') {
    return { label: 'Failed', variant: 'destructive' };
  }
  if (trip.invoice_email_sent) {
    return { label: 'Sent', variant: 'default' };
  }
  if (trip.invoice_generated_at) {
    return { label: 'Generated', variant: 'secondary' };
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

async function invokeInvoiceAction(tripId: string, action: 'auto' | 'regenerate' | 'resend' | 'generate_only', getUrls = false) {
  const { data, error } = await supabase.functions.invoke('trip-invoice-process', {
    body: { trip_id: tripId, action, get_urls: getUrls },
  });
  if (error) throw error;
  if (data?.error && !data?.ok) throw new Error(data.error);
  return data;
}

interface TripInvoiceCardProps {
  trip: TripInvoiceFields;
  onUpdated?: () => void;
  compact?: boolean;
}

export function TripInvoiceCard({ trip, onUpdated, compact = false }: TripInvoiceCardProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const status = getInvoiceStatusLabel(trip);

  const runAction = async (key: string, action: 'regenerate' | 'resend' | 'generate_only') => {
    setLoading(key);
    try {
      const result = await invokeInvoiceAction(trip.id, action);
      toast.success(result?.message ?? 'Invoice action completed');
      onUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invoice action failed');
    } finally {
      setLoading(null);
    }
  };

  const handleDownload = async () => {
    setLoading('download');
    try {
      if (trip.invoice_pdf_url) {
        window.open(trip.invoice_pdf_url, '_blank', 'noopener,noreferrer');
        return;
      }
      const result = await invokeInvoiceAction(trip.id, 'auto', true);
      if (result?.pdf_url) {
        window.open(result.pdf_url, '_blank', 'noopener,noreferrer');
      } else {
        throw new Error('Invoice PDF not available');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setLoading(null);
    }
  };

  const handleView = async () => {
    setLoading('view');
    try {
      const result = await invokeInvoiceAction(trip.id, 'auto', true);
      const url = result?.html_url ?? result?.pdf_url ?? trip.invoice_pdf_url;
      if (!url) throw new Error('Invoice not available');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'View failed');
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
        {(trip.invoice_pdf_error || trip.invoice_email_error) && (
          <div className="col-span-2 text-destructive text-xs">
            {trip.invoice_pdf_error || trip.invoice_email_error}
          </div>
        )}
      </div>

      <Separator />

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={handleDownload} disabled={!!loading}>
          {loading === 'download' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Download className="h-4 w-4 mr-1" />}
          Download Invoice
        </Button>
        <Button size="sm" variant="outline" onClick={handleView} disabled={!!loading}>
          {loading === 'view' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ExternalLink className="h-4 w-4 mr-1" />}
          View Invoice
        </Button>
        <Button size="sm" variant="outline" onClick={() => runAction('resend', 'resend')} disabled={!!loading}>
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
