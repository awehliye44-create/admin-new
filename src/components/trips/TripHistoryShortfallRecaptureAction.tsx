/**
 * Trip History — shortfall recapture action.
 * Calls admin-recapture-trip-shortfall (wraps existing Payment Sessions recovery).
 * Client submits trip_id only — never an arbitrary amount.
 *
 * When a recovery checkout exists: show Copy/Open link + Mark paid
 * (Mark paid verifies against Revolut via admin-refresh-payment-sessions).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { Loader2, CreditCard, Copy, ExternalLink, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  evaluateTripHistoryShortfallRecaptureEligibility,
  isPendingSavedCardProviderState,
  recaptureActionLabel,
  recaptureAttemptBadgeLabel,
  resolveRecaptureAttemptUi,
  TRIP_SHORTFALL_RECAPTURE_UI_STATE,
  type TripShortfallRecaptureUiState,
} from '../../../shared/tripHistoryShortfallRecaptureSSOT';
import {
  parseShortfallRecaptureInvokeFailure,
  shortfallRecaptureUserMessage,
} from '@/lib/tripHistoryShortfallRecaptureInvoke';
import { useStaffProfile } from '@/hooks/useStaffProfile';

type OpenRecoverySession = {
  id: string;
  status: string;
  provider_checkout_url: string | null;
  provider_order_id: string | null;
  estimated_total_pence: number | null;
  captured_amount_pence: number | null;
  saved_card_charged?: boolean | null;
  saved_card_state?: string | null;
};

type Props = {
  tripId: string;
  tripNumber?: string | null;
  tripStatus: string | null | undefined;
  paymentMethod?: string | null;
  financialModel?: string | null;
  customerPayablePence: number;
  verifiedCapturedPence: number;
  netRefundedPence?: number;
  hasOpenRecoveryAttempt?: boolean;
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
  netRefundedPence = 0,
  hasOpenRecoveryAttempt = false,
  currencySymbol = '£',
  onComplete,
}: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [attemptState, setAttemptState] = useState<TripShortfallRecaptureUiState | null>(null);
  const [attemptRef, setAttemptRef] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [lastErrorCode, setLastErrorCode] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { canAccessPage, staffProfile } = useStaffProfile();
  const adminPermitted =
    staffProfile?.role === 'super_admin'
    || canAccessPage('payments-trip-shortfall-recapture');

  const recoveryQuery = useQuery({
    queryKey: ['admin-payment-state', tripId],
    enabled: Boolean(tripId) && adminPermitted,
    staleTime: 15_000,
    queryFn: async (): Promise<{ open_recovery_session: OpenRecoverySession | null }> => {
      const { data, error } = await supabase.functions.invoke('admin-get-trip-payment-state', {
        body: { trip_id: tripId },
      });
      if (error) throw new Error((data as { error?: string } | null)?.error || error.message);
      return {
        open_recovery_session:
          ((data as { open_recovery_session?: OpenRecoverySession | null } | null)
            ?.open_recovery_session) ?? null,
      };
    },
  });

  const openRecovery = recoveryQuery.data?.open_recovery_session ?? null;
  const liveCheckoutUrl = checkoutUrl ?? openRecovery?.provider_checkout_url ?? null;
  const liveSessionId = attemptRef ?? openRecovery?.id ?? null;
  const hasLiveOpenRecovery = Boolean(openRecovery) || Boolean(checkoutUrl);

  const gate = evaluateTripHistoryShortfallRecaptureEligibility({
    tripStatus,
    financialModel,
    paymentMethod,
    customerPayablePence,
    verifiedCapturedTotalPence: verifiedCapturedPence,
    netRefundedTotalPence: netRefundedPence,
    providerSettlementVerified: verifiedCapturedPence > 0 && customerPayablePence > 0
      ? verifiedCapturedPence - netRefundedPence >= customerPayablePence
      : false,
    hasOpenRecoveryAttempt: hasOpenRecoveryAttempt
      || hasLiveOpenRecovery
      || attemptState === TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING
      || attemptState === TRIP_SHORTFALL_RECAPTURE_UI_STATE.CUSTOMER_ACTION_REQUIRED,
    adminPermitted,
  });

  const outstanding = gate.outstanding_shortfall_pence ?? 0;
  const label = recaptureActionLabel(outstanding, currencySymbol);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-payment-state', tripId] });
    queryClient.invalidateQueries({ queryKey: ['admin-payment-capture-context', tripId] });
  };

  const copyCheckoutUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.message('Payment link copied');
    } catch {
      toast.error('Could not copy payment link');
    }
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('admin-recapture-trip-shortfall', {
        body: { trip_id: tripId },
      });
      const payload = (data ?? null) as Record<string, unknown> | null;
      if (error || payload?.error || payload?.success === false) {
        const parsed = await parseShortfallRecaptureInvokeFailure(error, payload);
        throw Object.assign(new Error(shortfallRecaptureUserMessage(parsed)), {
          shortfallError: parsed,
        });
      }
      return payload as {
        status?: string;
        requires_customer_action?: boolean;
        checkout_url?: string | null;
        outstanding_shortfall_pence?: number;
        charged_pence?: number;
        payment_session_id?: string | null;
        provider_order_id?: string | null;
        message?: string;
        reused?: boolean;
        already_completed?: boolean;
        saved_card_charged?: boolean;
        saved_card_attempted?: boolean;
        saved_card_error?: string | null;
        saved_card_state?: string | null;
      };
    },
    onSuccess: (data) => {
      invalidate();
      setLastErrorCode(null);
      setAttemptRef(data.payment_session_id ?? data.provider_order_id ?? null);
      if (data.already_completed) {
        setAttemptState(TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID);
        setCheckoutUrl(null);
        toast.success('Shortfall already collected', {
          description: data.message ?? 'Recovery payment already completed for this trip.',
        });
      } else if (data.saved_card_charged === true && data.requires_customer_action !== true) {
        const pending = data.status === TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING
          || isPendingSavedCardProviderState(data.saved_card_state);
        setAttemptState(
          pending
            ? TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING
            : TRIP_SHORTFALL_RECAPTURE_UI_STATE.SAVED_CARD_CHARGED,
        );
        setCheckoutUrl(null);
        if (pending) {
          toast.message('Recapture processing', {
            description: data.message ?? 'Saved-card charge is pending with the provider.',
          });
        } else {
          toast.success('Saved card charged', {
            description: data.message ?? 'Off-session charge accepted — waiting for provider confirmation.',
          });
        }
      } else if (data.status === TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_FAILED) {
        setAttemptState(TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_FAILED);
        setCheckoutUrl(null);
        setLastErrorCode(data.saved_card_error ?? 'RECAPTURE_FAILED');
        toast.error(data.message ?? 'Recapture failed');
      } else if (data.requires_customer_action === true) {
        setAttemptState(TRIP_SHORTFALL_RECAPTURE_UI_STATE.CUSTOMER_ACTION_REQUIRED);
        if (data.checkout_url) setCheckoutUrl(data.checkout_url);
        toast.message('Customer action required', {
          description: data.checkout_url
            ? 'Payment link ready — send to the customer. Use Mark paid only after Revolut shows completed.'
            : (data.message ?? 'Customer must complete authentication / checkout.'),
        });
        if (data.checkout_url) void copyCheckoutUrl(data.checkout_url);
      } else if (data.reused) {
        setAttemptState(TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING);
        setCheckoutUrl(null);
        toast.message('Recapture already processing', {
          description: 'Returning the existing open recovery attempt — no duplicate charge created.',
        });
      } else {
        setAttemptState(TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING);
        setCheckoutUrl(null);
        toast.message('Recapture processing', {
          description: data.message
            ?? `Requested ${currencySymbol}${((data.charged_pence ?? outstanding) / 100).toFixed(2)}. Final capture waits for provider webhook.`,
        });
      }
      onComplete?.();
    },
    onError: (err: Error & { shortfallError?: {
      code: string;
      retryable: boolean;
      attempt_id: string | null;
      provider_attempt_created: boolean;
    } }) => {
      const parsed = err.shortfallError;
      setLastErrorCode(parsed?.code ?? 'RECAPTURE_FAILED');
      setAttemptRef(parsed?.attempt_id ?? null);
      if (parsed?.code === 'PAYMENT_METHOD_UNAVAILABLE' || parsed?.code === 'payment_method_unavailable') {
        setAttemptState(TRIP_SHORTFALL_RECAPTURE_UI_STATE.PAYMENT_METHOD_UNAVAILABLE);
      } else if (parsed?.code === 'CUSTOMER_ACTION_REQUIRED' || parsed?.code === 'customer_action_required') {
        setAttemptState(TRIP_SHORTFALL_RECAPTURE_UI_STATE.CUSTOMER_ACTION_REQUIRED);
      } else {
        setAttemptState(TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_FAILED);
      }
      toast.error(err.message, {
        description: parsed?.provider_attempt_created
          ? 'A provider attempt may already exist — do not create another charge until reconciled.'
          : parsed?.code
            ? `Code: ${parsed.code}`
            : undefined,
      });
    },
  });

  const markPaidMutation = useMutation({
    mutationFn: async () => {
      const sessionId = liveSessionId ?? openRecovery?.id;
      if (!sessionId) {
        throw new Error('No open recovery payment session to mark paid.');
      }
      const { data, error } = await supabase.functions.invoke('admin-refresh-payment-sessions', {
        body: { session_ids: [sessionId] },
      });
      const payload = (data ?? null) as {
        ok?: boolean;
        error?: string;
        results?: Array<{
          session_id?: string;
          new_state?: string;
          new_status?: string;
          error?: string | null;
          skipped?: boolean;
          captured_amount_pence?: number;
        }>;
      } | null;
      if (error) throw new Error(error.message || 'Mark paid failed');
      if (payload?.error) throw new Error(payload.error);
      const result = payload?.results?.[0];
      if (result?.error) throw new Error(result.error);
      const state = String(result?.new_state ?? '').toUpperCase();
      const status = String(result?.new_status ?? '').toUpperCase();
      const completed =
        state === 'COMPLETED'
        || status === 'RECOVERY_COMPLETED'
        || status === 'CAPTURED';
      if (!completed) {
        throw new Error(
          state
            ? `Revolut still shows ${state}. Customer must finish the payment link before marking paid.`
            : 'Provider did not confirm payment as completed.',
        );
      }
      return result;
    },
    onSuccess: (result) => {
      invalidate();
      setAttemptState(TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID);
      setCheckoutUrl(null);
      toast.success('Marked paid', {
        description: result?.captured_amount_pence
          ? `Verified capture ${currencySymbol}${(result.captured_amount_pence / 100).toFixed(2)} from Revolut.`
          : 'Recovery confirmed COMPLETED with Revolut — Trip History will refresh.',
      });
      onComplete?.();
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Could not mark paid');
    },
  });

  const resolvedUi = resolveRecaptureAttemptUi({
    attemptState,
    hasOpenRecoverySession: hasLiveOpenRecovery,
    openRecoverySavedCardCharged: openRecovery?.saved_card_charged === true,
    openRecoverySavedCardPending: isPendingSavedCardProviderState(openRecovery?.saved_card_state),
    gateUiState: gate.ui_state,
  });
  const effectiveUi = resolvedUi.ui_state;
  const showPaymentLink = resolvedUi.show_payment_link;

  if (effectiveUi === TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID) {
    return (
      <Badge variant="outline" className="bg-green-500/10 text-green-700 border-green-500/30">
        {recaptureAttemptBadgeLabel(effectiveUi)}
      </Badge>
    );
  }

  if (effectiveUi === TRIP_SHORTFALL_RECAPTURE_UI_STATE.SAVED_CARD_CHARGED) {
    return (
      <div className="space-y-1">
        <Badge variant="outline" className="bg-green-500/10 text-green-700 border-green-500/30">
          {recaptureAttemptBadgeLabel(effectiveUi)}
        </Badge>
        {liveSessionId && (
          <div className="text-[10px] text-muted-foreground font-mono">
            Ref: {liveSessionId.slice(0, 12)}…
          </div>
        )}
      </div>
    );
  }

  if (
    effectiveUi === TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING
    || mutation.isPending
  ) {
    return (
      <div className="space-y-1">
        <Badge variant="outline" className="bg-amber-500/10 text-amber-800 border-amber-500/40">
          {recaptureAttemptBadgeLabel(TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING)}
        </Badge>
        {liveSessionId && (
          <div className="text-[10px] text-muted-foreground font-mono">
            Ref: {liveSessionId.slice(0, 12)}…
          </div>
        )}
      </div>
    );
  }

  if (effectiveUi === TRIP_SHORTFALL_RECAPTURE_UI_STATE.CUSTOMER_ACTION_REQUIRED && showPaymentLink) {
    const amountPence = openRecovery?.estimated_total_pence ?? outstanding;
    return (
      <div className="rounded-md border border-amber-400/60 bg-amber-500/5 p-3 space-y-2 text-sm">
        <Badge variant="outline" className="bg-amber-500/10 text-amber-800 border-amber-500/40">
          {recaptureAttemptBadgeLabel(TRIP_SHORTFALL_RECAPTURE_UI_STATE.CUSTOMER_ACTION_REQUIRED)}
        </Badge>
        <div className="text-xs text-muted-foreground">
          Send the payment link to the customer. Mark paid only after Revolut shows the payment completed
          {amountPence > 0 ? ` (${currencySymbol}${(amountPence / 100).toFixed(2)})` : ''}.
        </div>
        {liveCheckoutUrl ? (
          <div className="rounded border bg-background/60 px-2 py-1.5 text-[11px] font-mono break-all">
            {liveCheckoutUrl}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            Payment link not loaded yet.
            {recoveryQuery.isFetching ? ' Refreshing…' : ' Try Recapture again to reuse the open attempt.'}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!liveCheckoutUrl}
            onClick={() => liveCheckoutUrl && void copyCheckoutUrl(liveCheckoutUrl)}
          >
            <Copy className="h-3.5 w-3.5 mr-1" />
            Copy link
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!liveCheckoutUrl}
            onClick={() => {
              if (!liveCheckoutUrl) return;
              window.open(liveCheckoutUrl, '_blank', 'noopener,noreferrer');
            }}
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1" />
            Open link
          </Button>
          <Button
            size="sm"
            disabled={!liveSessionId || markPaidMutation.isPending}
            onClick={() => setMarkPaidOpen(true)}
          >
            {markPaidMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                Verifying…
              </>
            ) : (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                Mark paid
              </>
            )}
          </Button>
        </div>
        {liveSessionId && (
          <div className="text-[10px] text-muted-foreground font-mono">
            Ref: {liveSessionId.slice(0, 12)}…
          </div>
        )}

        <AlertDialog open={markPaidOpen} onOpenChange={setMarkPaidOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Mark recovery as paid?</AlertDialogTitle>
              <AlertDialogDescription>
                This checks Revolut for the open recovery order and only marks Trip History paid if
                the provider status is COMPLETED. It will not create a new charge or credit the
                driver wallet twice.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={markPaidMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={markPaidMutation.isPending}
                onClick={(e) => {
                  e.preventDefault();
                  setMarkPaidOpen(false);
                  markPaidMutation.mutate();
                }}
              >
                Mark paid
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  if (effectiveUi === TRIP_SHORTFALL_RECAPTURE_UI_STATE.PAYMENT_METHOD_UNAVAILABLE) {
    return (
      <div className="space-y-1">
        <Badge variant="outline" className="text-muted-foreground">
          Payment method unavailable
        </Badge>
        <div className="text-xs text-muted-foreground">
          The customer’s payment method is unavailable for recapture. Shortfall preserved.
        </div>
      </div>
    );
  }

  if (effectiveUi === TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_FAILED) {
    return (
      <div className="space-y-2">
        <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/40">
          Recapture failed
        </Badge>
        {lastErrorCode && (
          <div className="text-[10px] text-muted-foreground font-mono">
            {lastErrorCode}
            {liveSessionId ? ` · ${liveSessionId.slice(0, 12)}…` : ''}
          </div>
        )}
        {gate.eligible && outstanding > 0 && (
          <Button size="sm" variant="outline" onClick={() => setConfirmOpen(true)}>
            Retry {label}
          </Button>
        )}
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Recapture customer payment?</AlertDialogTitle>
              <AlertDialogDescription>
                This will create a Revolut payment link for the outstanding {currencySymbol}
                {(outstanding / 100).toFixed(2)} for Trip #
                {tripNumber || tripId.slice(0, 8)}. The customer must complete the link. The
                customer will not be charged more than the outstanding balance.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  setConfirmOpen(false);
                  setAttemptState(null);
                  mutation.mutate();
                }}
              >
                {label}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  if (!gate.eligible || outstanding <= 0) {
    if (effectiveUi === TRIP_SHORTFALL_RECAPTURE_UI_STATE.PROVIDER_SETTLEMENT_PENDING) {
      return (
        <Badge variant="outline" className="bg-amber-500/10 text-amber-800 border-amber-500/40">
          Provider settlement pending
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
        <p className="text-xs text-muted-foreground">
          Recapture first attempts an off-session charge on the customer's saved card. If the card is
          missing or the issuer requires authentication, a Revolut payment link is created instead.
        </p>
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
            <AlertDialogTitle>Create payment link?</AlertDialogTitle>
            <AlertDialogDescription>
              This creates a Revolut payment link for the outstanding {currencySymbol}
              {(outstanding / 100).toFixed(2)} on Trip #
              {tripNumber || tripId.slice(0, 8)}. Send the link to the customer. After they pay,
              use Mark paid (or wait for webhook) to update Trip History.
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
