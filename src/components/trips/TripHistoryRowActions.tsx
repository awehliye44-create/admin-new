import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Eye, Download, Share2, FileText, Loader2, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { TripInvoiceFields } from '@/components/trips/TripInvoiceCard';
import {
  downloadTripInvoicePdf,
  shareTripInvoicePdf,
  viewTripInvoicePdf,
} from '@/lib/tripInvoiceActions';
import { getTripDisplayId } from '@/lib/tripUtils';
import { SendTripReceiptDialog } from '@/components/trips/SendTripReceiptDialog';

interface TripHistoryRowActionsProps {
  trip: TripInvoiceFields & {
    trip_number?: string | null;
  };
  onView: () => void;
  onInvoiceUpdated?: () => void;
}

export function TripHistoryRowActions({
  trip,
  onView,
  onInvoiceUpdated,
  onReceiptSendingChange,
  onReceiptSent,
  onReceiptFailed,
}: TripHistoryRowActionsProps & {
  onReceiptSendingChange?: (sending: boolean) => void;
  onReceiptSent?: (sentAt: string) => void;
  onReceiptFailed?: () => void;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const tripLabel = getTripDisplayId(trip);

  const run = async (key: string, fn: () => Promise<void>) => {
    setLoading(key);
    try {
      await fn();
      onInvoiceUpdated?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invoice action failed';
      toast.error(message);
    } finally {
      setLoading(null);
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center justify-end gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onView} aria-label="View trip details">
              <Eye className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>View trip details</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!loading}
              aria-label="Download invoice PDF"
              onClick={() =>
                run('download', async () => {
                  await downloadTripInvoicePdf(trip.id, trip.invoice_pdf_url);
                  toast.success('Invoice downloaded');
                })
              }
            >
              {loading === 'download' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download PDF</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!loading}
              aria-label="Share invoice PDF"
              onClick={() =>
                run('share', async () => {
                  await shareTripInvoicePdf(trip.id, tripLabel, trip.invoice_pdf_url);
                })
              }
            >
              {loading === 'share' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Share2 className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Share PDF</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!loading}
              aria-label="Send receipt"
              onClick={() => setSendOpen(true)}
            >
              <Mail className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Send receipt</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!loading}
              aria-label="Open invoice"
              onClick={() =>
                run('view', async () => {
                  await viewTripInvoicePdf(trip.id, trip.invoice_pdf_url);
                })
              }
            >
              {loading === 'view' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open invoice</TooltipContent>
        </Tooltip>
      </div>
      <SendTripReceiptDialog
        tripId={trip.id}
        open={sendOpen}
        onOpenChange={setSendOpen}
        onSendingChange={onReceiptSendingChange}
        onSent={(sentAt) => {
          onReceiptSent?.(sentAt);
          onInvoiceUpdated?.();
        }}
        onFailed={onReceiptFailed}
      />
    </TooltipProvider>
  );
}
