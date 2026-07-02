import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export type InvoiceAction = 'download' | 'view' | 'resend_email' | 'regenerate';

export interface InvoiceActionResult {
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

const INVOICE_ACTION_FAILED = 'Invoice action failed. Please try again or check invoice settings.';

export function resolveInvoicePdfUrl(
  result: InvoiceActionResult,
  fallbackUrl?: string | null,
): string | null {
  return result.pdfUrl ?? result.pdf_url ?? result.invoice_pdf_url ?? fallbackUrl ?? null;
}

export async function invokeInvoiceAction(tripId: string, action: InvoiceAction): Promise<InvoiceActionResult> {
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

export function openInvoiceUrl(url?: string | null): void {
  if (!url) throw new Error(INVOICE_ACTION_FAILED);
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function downloadTripInvoicePdf(
  tripId: string,
  fallbackPdfUrl?: string | null,
): Promise<string | null> {
  const result = await invokeInvoiceAction(tripId, 'download');
  const url = resolveInvoicePdfUrl(result, fallbackPdfUrl);
  if (url) openInvoiceUrl(url);
  return url;
}

export async function viewTripInvoicePdf(
  tripId: string,
  fallbackPdfUrl?: string | null,
): Promise<string | null> {
  const result = await invokeInvoiceAction(tripId, 'view');
  const url = resolveInvoicePdfUrl(result, fallbackPdfUrl);
  if (url) openInvoiceUrl(url);
  return url;
}

export async function shareTripInvoicePdf(
  tripId: string,
  tripLabel: string,
  fallbackPdfUrl?: string | null,
): Promise<void> {
  const result = await invokeInvoiceAction(tripId, 'view');
  const url = resolveInvoicePdfUrl(result, fallbackPdfUrl);
  if (!url) throw new Error(INVOICE_ACTION_FAILED);

  const title = `Trip invoice ${tripLabel}`;
  const text = `Trip receipt for ${tripLabel}. Finance details are available in Financial Reconciliation.`;

  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    toast.success('Invoice link copied to clipboard');
    return;
  }

  openInvoiceUrl(url);
}
