/**
 * Trip History — shortfall recapture action.
 * Calls admin-recapture-trip-shortfall (wraps existing Payment Sessions recovery).
 * Client submits trip_id only — never an arbitrary amount.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { Loader2, CreditCard } from 'lucide-react';
import { toast } from 'sonner';
import {
  evaluateTripHistoryShortfallRecaptureEligibility,
  recaptureActionLabel,
  TRIP_SHORTFALL_RECAPTURE_UI_STATE,
} from '../../../shared/tripHistoryShortfallRecaptureSSOT';
import { useStaffProfile } from '@/hooks/useStaffProfile';

type Props = {
  tripId: string;
  tripNumber?: string | null;
  tripStatus: string | null | undefined;
  paymentMethod?: string | null;
  financialModel?: string | null;
  customerPayablePence: number;
  verifiedCapturedPence: number;
  currencySymbol?: string;
  onComplete?: () => void;
};

export function TripHistoryShortfallRecaptureAction({
  tripId,
  tripNumber,
  tripStatus,
  paymentMethod,
  financialModel,
  customerPayablePence,
  verifiedCapturedPence,
  currencySymbol = '£',
  onComplete,
}: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queryClient = useQueryClient();
  const { canAccessPage, staffProfile } = useStaffProfile();
  // Dedicated permission only (super_admin may have it by default / role matrix).
  // Do not fall back to blanket trip-history or financial-reconciliation access.
  const adminPermitted =
    staffProfile?.role === 'super_admin'
    || canAccessPage('payments-trip-shortfall-recapture');

  const gate = evaluateTripHistoryShortfallRecaptureEligibility({
    tripStatus,
    financialModel,
    paymentMethod,
    customerPayablePence,
    verifiedCapturedTotalPence: verifiedCapturedPence,
    providerSettlementVerified: verifiedCapturedPence > 0 && customerPayablePence > 0
      ? verifiedCapturedPence >= customerPayablePence
      : false,
    adminPermitted,
  });

  const outstanding = gate.outstanding_shortfall_pence ?? 0;
  const label = recaptureActionLabel(outstanding, currencySymbol);

  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('admin-recapture-trip-shortfall', {
        body: { trip_id: tripId },
      });
      if (error) throw new Error(error.message || 'Recapture request failed');
      if (data?.error) throw new Error(data.error || data.message || 'Recapture request failed');
      return data as {
        status?: string;
        requires_customer_action?: boolean;
        checkout_url?: string | null;
        outstanding_shortfall_pence?: number;
        charged_pence?: number;
        message?: string;
        reused?: boolean;
        already_completed?: boolean;
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['admin-payment-state', tripId] });
      queryClient.invalidateQueries({ queryKey: ['admin-payment-capture-context', tripId] });
      if (data.already_completed) {
        toast.success('Shortfall already collected', {
          description: data.message ?? 'Recovery payment already completed for this trip.',
        });
      } else if (data.requires_customer_action || data.checkout_url) {
        toast.message('Customer action required', {
          description: data.checkout_url
            ? 'Checkout link created — send to the customer to complete payment. Do not mark as captured yet.'
            : (data.message ?? 'Customer must complete authentication / checkout.'),
        });
        if (data.checkout_url && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(data.checkout_url);
          toast.message('Checkout URL copied');
        }
      } else if (data.reused) {
        toast.message('Recapture already processing', {
          description: 'Returning the existing open recovery attempt — no duplicate charge created.',
        });
      } else {
        toast.message('Recapture processing', {
          description: data.message
            ?? `Requested ${currencySymbol}${((data.charged_pence ?? outstanding) / 100).toFixed(2)}. Final capture waits for provider webhook.`,
        });
      }
      onComplete?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (gate.ui_state === TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID) {
    return (
      <Badge variant="outline" className="bg-green-500/10 text-green-700 border-green-500/30">
        Fully paid
      </Badge>
    );
  }

  if (!gate.eligible || outstanding <= 0) {
    if (gate.ui_state === TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING) {
      return (
        <Badge variant="outline" className="bg-amber-500/10 text-amber-800 border-amber-500/40">
          Recapture processing
        </Badge>
      );
    }
    if (gate.ui_state === TRIP_SHORTFALL_RECAPTURE_UI_STATE.PAYMENT_METHOD_UNAVAILABLE) {
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Payment method unavailable
        </Badge>
      );
    }
    return null;
  }

  return (
    <>
      <div className="rounded-md border border-amber-400/60 bg-amber-500/5 p-3 space-y-2 text-sm">
        <div className="font-medium">Customer payment shortfall</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground">Customer payable</div>
            <div className="font-semibold">
              {currencySymbol}{(customerPayablePence / 100).toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Verified captured</div>
            <div className={`font-semibold ${verifiedCapturedPence > 0 ? 'text-green-700' : 'text-muted-foreground'}`}>
              {currencySymbol}{(verifiedCapturedPence / 100).toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Outstanding shortfall</div>
            <div className="font-semibold text-amber-700">
              {currencySymbol}{(outstanding / 100).toFixed(2)}
            </div>
          </div>
        </div>
        <Button
          size="sm"
          disabled={mutation.isPending}
          onClick={() => setConfirmOpen(true)}
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              Recapture processing
            </>
          ) : (
            <>
              <CreditCard className="h-3.5 w-3.5 mr-1" />
              {label}
            </>
          )}
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Recapture customer payment?</AlertDialogTitle>
            <AlertDialogDescription>
              This will attempt to collect the outstanding {currencySymbol}
              {(outstanding / 100).toFixed(2)} for Trip #
              {tripNumber || tripId.slice(0, 8)} using the payment method linked to the
              authoritative Payment Session. The customer will not be charged more than the
              outstanding balance.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={mutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                setConfirmOpen(false);
                mutation.mutate();
              }}
            >
              {label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
