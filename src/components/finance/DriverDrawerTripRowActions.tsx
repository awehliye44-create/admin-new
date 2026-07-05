import { Link } from 'react-router-dom';
import { ExternalLink, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { TripFinancialAuditRow } from '@/hooks/useFinanceReconciliation';
import { derivePaymentActionAvailability } from '@/lib/financeTripActionsSSOT';
import { tripSettlementRecoverUrl } from '@/lib/financialReconciliationRoutes';
import { isHistoricalLegacyCashTrip } from '../../../shared/digitalFinanceSSOT';
import { useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

function providerStatus(row: TripFinancialAuditRow): string {
  return (row.provider?.label ?? row.provider_status ?? '').toLowerCase();
}

function buildPaymentInput(row: TripFinancialAuditRow) {
  const captured = row.captured_pence ?? 0;
  const refunded = row.refunded_pence ?? 0;
  const status = providerStatus(row);
  return {
    paymentMethod: row.payment_method,
    stripeStatus: status,
    paymentStatus: row.payment_status,
    capturedPence: captured,
    refundedPence: refunded,
    refundablePence: Math.max(0, captured - refunded),
    outstandingPence: row.outstanding_pence ?? 0,
    hasPaymentIntent: Boolean(row.stripe_payment_intent_id),
    hasCharge: captured > 0,
  };
}

export type DriverDrawerTripAction = 'view' | 'refund' | 'partial_refund' | 'repair';

export function DriverDrawerTripRowActions({
  row,
  driverId,
  actionsDisabled,
  onTripAction,
  onSynced,
}: {
  row: TripFinancialAuditRow;
  driverId: string;
  actionsDisabled: boolean;
  onTripAction: (row: TripFinancialAuditRow, action: DriverDrawerTripAction) => void;
  onSynced?: () => void;
}) {
  const legacy = isHistoricalLegacyCashTrip(row.payment_method);
  const availability = derivePaymentActionAvailability(buildPaymentInput(row));
  const piId = row.stripe_payment_intent_id;

  const syncMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = { trip_id: row.trip_id };
      if (row.trip_code) body.trip_code = row.trip_code;
      const { data, error } = await supabase.functions.invoke('admin-sync-trip-payment-from-stripe', { body });
      if (error) throw new Error(data?.error || error.message);
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast.success(data?.message ?? 'Synced from Stripe');
      onSynced?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (legacy) {
    return (
      <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={() => onTripAction(row, 'view')}>
        View
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={() => onTripAction(row, 'view')}>View trip</DropdownMenuItem>
        {piId ? (
          <DropdownMenuItem asChild>
            <a
              href={`https://dashboard.stripe.com/payments/${piId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center"
            >
              View Stripe PaymentIntent
              <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled>No PaymentIntent</DropdownMenuItem>
        )}
        {piId && (row.captured_pence ?? 0) > 0 ? (
          <DropdownMenuItem asChild>
            <a
              href={`https://dashboard.stripe.com/payments/${piId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center"
            >
              View Stripe charge
              <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled>View Stripe charge (not captured)</DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={actionsDisabled || !availability.resync_stripe.enabled || syncMutation.isPending}
          onClick={() => syncMutation.mutate()}
        >
          Sync from Stripe
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={actionsDisabled || !availability.refund_full.enabled}
          onClick={() => onTripAction(row, 'refund')}
        >
          Refund full
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={actionsDisabled || !availability.refund_partial.enabled}
          onClick={() => onTripAction(row, 'partial_refund')}
        >
          Partial refund
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={actionsDisabled || !availability.repair_settlement.enabled}
          onClick={() => onTripAction(row, 'repair')}
        >
          Repair settlement
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            to={`/driver-wallet-ledger?${new URLSearchParams({ driverId, tab: 'ledger', tripId: row.trip_id }).toString()}`}
          >
            View ledger
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={tripSettlementRecoverUrl(row.trip_id, row.trip_code)}>View audit log</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
