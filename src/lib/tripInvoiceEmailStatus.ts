import {
  receiptEmailBadgeLabel,
  resolveReceiptEmailBadge,
  type ReceiptEmailBadge,
} from '../../shared/manualTripReceiptSSOT';

export type TripInvoiceEmailFields = {
  invoice_email_sent_at?: string | null;
  invoice_email_status?: string | null;
  invoice_email_log_status?: string | null;
  invoice_email_log_sent_at?: string | null;
};

export function getTripInvoiceEmailBadge(
  trip: TripInvoiceEmailFields,
  requestInProgress = false,
): { badge: ReceiptEmailBadge; label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  const badge = resolveReceiptEmailBadge({
    invoice_email_sent_at: trip.invoice_email_sent_at,
    invoice_email_status: trip.invoice_email_status,
    invoice_email_log_status: trip.invoice_email_log_status,
    invoice_email_log_sent_at: trip.invoice_email_log_sent_at,
    requestInProgress,
  });
  const variant =
    badge === 'sent'
      ? 'default'
      : badge === 'failed'
        ? 'destructive'
        : badge === 'sending'
          ? 'outline'
          : 'secondary';
  return { badge, label: receiptEmailBadgeLabel(badge), variant };
}
