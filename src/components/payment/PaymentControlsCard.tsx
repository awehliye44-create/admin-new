import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  ChevronDown, RefreshCw, Pencil, ShieldCheck, AlertTriangle,
  PlusCircle, MinusCircle, FileEdit,
} from 'lucide-react';
import { useFinanceActionPermission } from '@/hooks/useFinanceActionPermission';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { formatMoneyMinor } from '@/lib/formatMoneyMinor';
import { FinanceRecoveryMismatchSummary } from '@/components/payment/FinanceRecoveryMismatchSummary';
import { FinanceTripActionsPanel } from '@/components/finance/FinanceTripActionsPanel';
import {
  captureStatusColorClass,
  getCapturedTotalPence,
  getTripCaptureStatus,
  getTripSettlementBreakdown,
  getTripTipPence,
  isCardTrip,
  summarizeTripPayments,
  type TripCaptureFields,
} from '@/lib/tripCaptureStatus';

interface PaymentState {
  trip_id: string;
  payment_provider?: 'stripe' | 'revolut' | 'unknown';
  provider_order_id?: string | null;
  legacy_stripe_trip?: boolean;
  payment_intent_id: string | null;
  charge_id: string | null;
  payment_method: string | null;
  payment_method_brand: string | null;
  last4: string | null;
  provider_status?: string | null;
  payment_status: string | null;
  stripe_status: string | null;
  stripe_currency: string | null;
  authorized_pence: number;
  captured_pence: number;
  refunded_pence: number;
  net_captured_pence: number;
  refundable_pence: number;
  amount_capturable_pence: number | null;
  final_fare_pence: number;
  settlement_total_pence: number;
  gross_fare_pence?: number;
  discount_pence?: number;
  buffer_pence: number;
  commission_pence: number;
  stripe_fee_pence: number;
  onecab_net_pence: number;
  driver_net_pence: number | null;
  outstanding_pence?: number;
  capture_mismatch?: boolean;
  ssot_source?: string;
  stripe_application_fee_id: string | null;
  stripe_application_fee_amount_pence: number | null;
  stripe_destination_account_id: string | null;
  stripe_transfer_id: string | null;
  stripe_transfer_amount_pence: number | null;
  stripe_settlement_verified: boolean;
  stripe_settlement_warning: string | null;
  stripe_settlement_warning_severity?: 'info' | 'error' | null;
  stripe_settlement_warning_label?: string | null;
  customer_email: string | null;
  payment_created_at: string | null;
  captured_at: string | null;
  refunded_at: string | null;
  trip_code?: string | null;
  driver_id?: string | null;
  passenger_id?: string | null;
  recovery_debt_pence?: number;
  debt_recovered_pence?: number;
  available_payout_created_pence?: number | null;
  refund_status?: 'none' | 'partial' | 'full';
  actions_allowed?: {
    can_capture: boolean;
    can_refund: boolean;
    can_partial_refund: boolean;
    can_cancel_authorisation?: boolean;
    can_sync_stripe: boolean;
    can_add_note: boolean;
  };
}

interface AuditEntry {
  id: string;
  action: 'capture' | 'refund' | 'edit_fare' | 'cancel' | 'extra_payment' | 'finance_note' | 'sync_stripe';
  reason: string;
  amount_pence_before: number | null;
  amount_pence_after: number | null;
  delta_pence: number | null;
  stripe_payment_intent_id: string | null;
  stripe_refund_id: string | null;
  admin_user_id: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

const formatPence = (pence: number, currency?: string | null) => {
  if (!currency) return '—';
  return formatMoneyMinor(pence, currency);
};

const fmtTime = (iso: string | null) => (iso ? format(new Date(iso), 'dd MMM yyyy HH:mm') : '—');

type Mode = 'capture' | 'refund' | 'partial_refund' | 'edit' | 'cancel' | 'extra_payment';

const ACTION_LABEL: Record<AuditEntry['action'] | 'extra_payment', string> = {
  capture: 'Capture',
  refund: 'Refund',
  edit_fare: 'Edit fare',
  cancel: 'Hold released',
  extra_payment: 'Extra payment',
  finance_note: 'Finance note',
  sync_stripe: 'Sync Provider',
};

const INFORMATIONAL_SETTLEMENT_WARNINGS = new Set([
  'SEPARATE_CHARGE_TRANSFER_USED_NO_APPLICATION_FEE_OBJECT',
  'NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_RETAINED_FULL_CHARGE_MANUAL_PAYOUT_REQUIRED',
  'NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_CHARGE_ONLY_UNTIL_MANUAL_PAYOUT',
]);

const SETTLEMENT_WARNING_LABELS: Record<string, string> = {
  SEPARATE_CHARGE_TRANSFER_USED_NO_APPLICATION_FEE_OBJECT:
    'Driver payout verified via separate Connect transfer (no application fee object on charge).',
  NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_RETAINED_FULL_CHARGE_MANUAL_PAYOUT_REQUIRED:
    'No driver Connect account — platform retained the full charge; manual driver payout required.',
  NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_CHARGE_ONLY_UNTIL_MANUAL_PAYOUT:
    'No driver Connect account at booking — platform charge only until manual payout.',
};

function settlementWarningSeverity(
  verified: boolean,
  warning: string | null,
  apiSeverity?: 'info' | 'error' | null,
): 'info' | 'error' | null {
  if (!warning) return null;
  if (apiSeverity) return apiSeverity;
  if (verified && INFORMATIONAL_SETTLEMENT_WARNINGS.has(warning)) return 'info';
  if (!verified || warning.startsWith('STRIPE_SETTLEMENT_NOT_VERIFIED')) return 'error';
  if (
    warning.startsWith('DESTINATION_CHARGE_APP_FEE_MISMATCH') ||
    warning.startsWith('SEPARATE_TRANSFER_MISMATCH')
  ) {
    return 'error';
  }
  return verified ? 'info' : 'error';
}

function settlementWarningLabel(
  warning: string | null,
  apiLabel?: string | null,
): string | null {
  if (!warning) return null;
  return apiLabel ?? SETTLEMENT_WARNING_LABELS[warning] ?? warning;
}

export type PaymentControlsVariant = 'finance' | 'summary';

export type FinanceRecoveryAction = 'extra_payment' | 'waive' | 'internal_adjustment';
export type InitialPaymentAction = 'capture' | 'refund' | 'partial_refund';

export function PaymentControlsCard({
  tripId,
  variant = 'finance',
  initialAction = null,
  initialPaymentAction = null,
  onInitialActionConsumed,
  onActionComplete,
}: {
  tripId: string;
  variant?: PaymentControlsVariant;
  initialAction?: FinanceRecoveryAction | null;
  initialPaymentAction?: InitialPaymentAction | null;
  onInitialActionConsumed?: () => void;
  onActionComplete?: () => void;
}) {
  const { isAdmin } = useAuth();
  const { canUseFinanceActions } = useFinanceActionPermission();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode | null>(null);
  const [amountInput, setAmountInput] = useState<string>('');
  const [reason, setReason] = useState('');
  const [auditOpen, setAuditOpen] = useState(true);

  const stateQuery = useQuery<PaymentState>({
    queryKey: ['admin-payment-state', tripId],
    enabled: !!tripId && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('admin-get-trip-payment-state', {
        body: { trip_id: tripId },
      });
      if (error) throw new Error(data?.error || error.message);
      return data as PaymentState;
    },
  });

  const captureContextQuery = useQuery<TripCaptureFields & { payment_count: number }>({
    queryKey: ['admin-payment-capture-context', tripId],
    enabled: !!tripId && isAdmin,
    queryFn: async () => {
      const [tripRes, paymentsRes, ledgerRes] = await Promise.all([
        supabase
          .from('trips')
          .select('payment_method, payment_status, final_fare_pence, final_customer_fare_pence, gross_fare_pence, capture_amount_pence, authorised_amount_pence, estimated_fare, tip_pence, tip_amount_pence, fare_breakdown, arrival_cancellation_applied, arrival_cancellation_fee, driver_net_pence, total_waiting_charge_pence, waiting_charge_pence, pickup_waiting_charge_pence')
          .eq('id', tripId)
          .single(),
        supabase
          .from('payments')
          .select('captured_amount_pence, amount_pence, status, fee_type, metadata')
          .eq('trip_id', tripId),
        supabase
          .from('driver_wallet_ledger')
          .select('type, amount_pence')
          .eq('related_trip_id', tripId)
          .eq('type', 'TRIP_EARNING_NET'),
      ]);
      if (tripRes.error) throw tripRes.error;
      const payments = (paymentsRes.data ?? []) as unknown as Parameters<typeof summarizeTripPayments>[0];
      const summary = summarizeTripPayments(payments);
      const ledgerEarning = ledgerRes.data?.[0];
      return {
        ...(tripRes.data as TripCaptureFields & { authorised_amount_pence?: number | null; estimated_fare_pence?: number | null }),
        payment_captured_pence: summary.capturedTotalPence,
        payment_tip_pence: summary.tipFromMeta,
        payment_count: summary.paymentCount,
        has_shortfall_payment_intent: summary.hasShortfallPaymentIntent,
        payment_lifecycle_fees_pence: summary.lifecycleFeesPence,
        payment_metadata_lifecycle_fees_pence: summary.metadataLifecycleFeesPence,
        ledger_trip_earning_net_pence: ledgerEarning?.amount_pence ?? null,
      };
    },
  });

  const auditQuery = useQuery<AuditEntry[]>({
    queryKey: ['admin-payment-audit', tripId],
    enabled: !!tripId && isAdmin && auditOpen,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_payment_audit')
        .select('*')
        .eq('trip_id', tripId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as AuditEntry[];
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-payment-state', tripId] });
    queryClient.invalidateQueries({ queryKey: ['admin-payment-capture-context', tripId] });
    queryClient.invalidateQueries({ queryKey: ['admin-payment-audit', tripId] });
    queryClient.invalidateQueries({ queryKey: ['admin-payment-detail', tripId] });
    queryClient.invalidateQueries({ queryKey: ['admin-payments-list'] });
    queryClient.invalidateQueries({ queryKey: ['admin-payments-summary'] });
    queryClient.invalidateQueries({ queryKey: ['finance-reconciliation-summary'] });
  };

  const repairCommissionsMutation = useMutation({
    mutationFn: async (driverId: string) => {
      const { data, error } = await supabase.functions.invoke('repair-commissions', {
        body: { driver_id: driverId, dry_run: false },
      });
      if (error) throw new Error(data?.error || error.message);
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast.success(data.message || 'Commission recalculation queued');
      refresh();
      onActionComplete?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const actionMutation = useMutation({
    mutationFn: async (input: { mode: Mode; amount_pence?: number; new_total_pence?: number; reason: string }) => {
      const fn =
        input.mode === 'capture' ? 'admin-capture-trip-payment'
        : input.mode === 'refund' || input.mode === 'partial_refund' ? 'admin-refund-trip-payment'
        : input.mode === 'cancel' ? 'admin-cancel-trip-payment'
        : input.mode === 'extra_payment' ? 'admin-request-extra-payment'
        : 'admin-edit-trip-fare';
      const body: Record<string, unknown> = { trip_id: tripId, reason: input.reason };
      if (input.mode === 'edit') body.new_total_pence = input.new_total_pence;
      else if (input.mode === 'extra_payment') {
        // Server computes charge from settlement − captured; never trust UI amount.
      } else if (input.mode !== 'cancel' && input.amount_pence !== undefined) {
        body.amount_pence = input.amount_pence;
      }
      const { data, error } = await supabase.functions.invoke(fn, { body });
      if (error) throw new Error(data?.error || error.message);
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      const id = data.stripe_refund_id || data.stripe_charge_id || data.stripe_payment_intent_id;
      toast.success(data.message || 'Action completed', { description: id ? `Provider ref: ${id}` : undefined });
      setMode(null);
      setReason('');
      setAmountInput('');
      refresh();
      onActionComplete?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const isFinanceVariant = variant === 'finance';
  const showTripActionsPanel = isFinanceVariant;

  if (!isAdmin || !canUseFinanceActions) return null;

  const state = stateQuery.data;
  const captureContext = captureContextQuery.data;
  const captureStatus = captureContext ? getTripCaptureStatus(captureContext) : null;
  const currency = state?.stripe_currency ?? '';
  const isUncaptured = state?.actions_allowed?.can_capture
    ?? (state?.payment_provider === 'revolut'
      ? String(state?.provider_status ?? state?.stripe_status ?? '').toLowerCase() === 'authorised'
      : state?.stripe_status === 'requires_capture');
  const canSyncStripe = false;
  const isCancelled = state?.stripe_status === 'canceled' || String(state?.payment_status ?? '').includes('cancel');
  const hasCharge = !!state && (state.actions_allowed?.can_refund || state.actions_allowed?.can_partial_refund || state.captured_pence > 0);
  const refundable = state ? Math.max(0, state.refundable_pence ?? state.captured_pence - state.refunded_pence) : 0;
  const canRefund = state?.actions_allowed?.can_refund ?? (hasCharge && refundable > 0);
  const canPartialRefund = state?.actions_allowed?.can_partial_refund ?? canRefund;
  const isFullyRefunded = state ? state.captured_pence > 0 && refundable === 0 : false;
  const settlementWarning = state
    ? settlementWarningSeverity(
        state.stripe_settlement_verified,
        state.stripe_settlement_warning,
        state.stripe_settlement_warning_severity,
      )
    : null;
  const settlementWarningText = state
    ? settlementWarningLabel(state.stripe_settlement_warning, state.stripe_settlement_warning_label)
    : null;

  // ---- Extra-payment derivation (with legacy/past-trip fallbacks) ----
  const ctx = captureContext as (TripCaptureFields & {
    authorised_amount_pence?: number | null;
    estimated_fare?: number | null;
  }) | undefined;
  const authorisedPence = Math.max(0, state?.authorized_pence ?? ctx?.authorised_amount_pence ?? 0);
  const capturedPence = Math.max(0, state?.captured_pence ?? ctx?.capture_amount_pence ?? getCapturedTotalPence(ctx ?? {}) ?? 0);
  const settlementTotalPence = state?.settlement_total_pence ?? state?.final_fare_pence ?? 0;
  const settlementBreakdown = ctx ? getTripSettlementBreakdown(ctx) : null;
  const driverNetPence = state?.driver_net_pence ?? null;
  const quotedEstimatePence = Math.max(0, Math.round((ctx?.estimated_fare ?? 0) * 100));
  const extraDuePence = state ? Math.max(0, state.outstanding_pence ?? 0) : 0;
  const releasedBufferPence = Math.max(0, authorisedPence - capturedPence);
  const paymentFullyPaid = state
    ? extraDuePence <= 0 && settlementTotalPence > 0
    : capturedPence >= settlementTotalPence && settlementTotalPence > 0;
  const isLegacyTrip = !!ctx
    && (ctx.final_fare_pence == null || ctx.final_fare_pence === 0)
    && capturedPence > 0;
  const isLegacyIncomplete = !!ctx
    && (ctx.final_fare_pence == null || ctx.final_fare_pence === 0)
    && capturedPence === 0
    && authorisedPence === 0;
  const isHistoricalShortfall = !!ctx && extraDuePence > 0 && capturedPence > 0
    && authorisedPence > 0 && releasedBufferPence === 0;

  const blockEditFareForOutstanding = extraDuePence > 0 && !isLegacyIncomplete;

  const openMode = (m: Mode) => {
    if (m === 'edit' && blockEditFareForOutstanding) {
      toast.error('Use Request extra payment on Financial Reconciliation — Edit Fare cannot charge outstanding balance.');
      return;
    }
    setMode(m);
    setReason('');
    if (!state) { setAmountInput(''); return; }
    if (m === 'capture') setAmountInput(((state.final_fare_pence || state.amount_capturable_pence || state.authorized_pence) / 100).toFixed(2));
    else if (m === 'refund') setAmountInput((refundable / 100).toFixed(2));
    else if (m === 'partial_refund') setAmountInput('');
    else if (m === 'edit') setAmountInput((state.final_fare_pence / 100).toFixed(2));
    else setAmountInput('');
  };

  const openExtraPayment = () => {
    setMode('extra_payment');
    setReason('');
    setAmountInput((extraDuePence / 100).toFixed(2));
  };
  const openWaive = () => {
    setMode('edit');
    setReason('Waive extra amount — set fare to captured total. ');
    setAmountInput((capturedPence / 100).toFixed(2));
  };
  const openInternalAdjustment = () => {
    setMode('edit');
    setReason('Internal adjustment — ');
    setAmountInput((settlementTotalPence / 100).toFixed(2));
  };

  useEffect(() => {
    if (!initialAction || !state || stateQuery.isLoading) return;
    if (initialAction === 'extra_payment') openExtraPayment();
    else if (initialAction === 'waive') openWaive();
    else if (initialAction === 'internal_adjustment') openInternalAdjustment();
    onInitialActionConsumed?.();
  }, [initialAction, state, stateQuery.isLoading]);

  useEffect(() => {
    if (!initialPaymentAction || !state || stateQuery.isLoading) return;
    if (initialPaymentAction === 'capture' && isUncaptured) openMode('capture');
    else if (initialPaymentAction === 'refund' && canRefund) openMode('refund');
    else if (initialPaymentAction === 'partial_refund' && canPartialRefund) openMode('partial_refund');
    onInitialActionConsumed?.();
  }, [initialPaymentAction, state, stateQuery.isLoading]);

  const submit = () => {
    if (reason.trim().length < 5) {
      toast.error('Reason must be at least 5 characters');
      return;
    }
    if (mode === 'cancel') {
      actionMutation.mutate({ mode, reason: reason.trim() });
      return;
    }
    if (mode === 'extra_payment') {
      actionMutation.mutate({ mode, reason: reason.trim() });
      return;
    }
    if (mode === 'edit' && blockEditFareForOutstanding) {
      toast.error('Use Request extra payment — Edit Fare cannot charge outstanding balance.');
      return;
    }
    const value = Number(amountInput);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter a valid amount greater than 0');
      return;
    }
    const pence = Math.round(value * 100);
    if (mode === 'partial_refund' && pence > refundable) {
      toast.error(`Cannot refund more than ${formatPence(refundable, currency)}`);
      return;
    }
    if (mode === 'capture' && state && pence > (state.amount_capturable_pence ?? state.authorized_pence)) {
      toast.error(`Cannot capture more than authorized (${formatPence(state.amount_capturable_pence ?? state.authorized_pence, currency)})`);
      return;
    }
    // 'extra_payment' and 'cancel' handled above; mode is narrowed to capture | edit | partial_refund | refund here.

    if (mode === 'edit') actionMutation.mutate({ mode, new_total_pence: pence, reason: reason.trim() });
    else if (mode) actionMutation.mutate({ mode, amount_pence: pence, reason: reason.trim() });
  };

  const dialogTitle = {
    capture: 'Capture payment',
    refund: 'Full refund',
    partial_refund: 'Partial refund',
    edit: 'Edit trip fare',
    cancel: 'Cancel hold (release authorization)',
    extra_payment: 'Request extra payment',
  }[mode ?? 'capture'];

  const dialogDesc = {
    capture: 'Capture an authorized PaymentIntent. Default is the final trip fare; any unused buffer is released automatically.',
    refund: 'Refund the full remaining captured amount. This cannot be undone.',
    partial_refund: 'Enter the amount to refund. Cannot exceed the refundable balance.',
    edit: 'Sets the trip fare. Captures or refunds the difference automatically.',
    cancel: 'Cancels the uncaptured PaymentIntent and releases the customer’s bank hold. No money will move.',
    extra_payment: 'Charges the outstanding balance only via a new PaymentIntent. Does not edit the trip fare.',
  }[mode ?? 'capture'];

  const captureMismatch = !!captureStatus && !!captureContext && isCardTrip(captureContext)
    && (captureStatus.kind === 'capture_mismatch' || extraDuePence > 0);

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" />
            {isFinanceVariant ? 'Trip Actions (SSOT)' : 'Payment status (read-only)'}
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => stateQuery.refetch()} disabled={stateQuery.isFetching}>
            <RefreshCw className={`h-4 w-4 ${stateQuery.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {stateQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : stateQuery.error ? (
          <div className="text-sm text-destructive flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {(stateQuery.error as Error).message}
          </div>
        ) : state ? (
          <>
            {/* Finance recovery SSOT — required mismatch metrics + actions */}
            {isFinanceVariant && (
              <FinanceRecoveryMismatchSummary
                captureMismatch={captureMismatch}
                capturedPence={capturedPence}
                settlementTotalPence={settlementTotalPence}
                outstandingPence={extraDuePence}
                currency={currency}
                showActions={extraDuePence > 0 && !isLegacyIncomplete}
                onAction={(action) => {
                  if (action === 'extra_payment') openExtraPayment();
                  else if (action === 'waive') openWaive();
                  else openInternalAdjustment();
                }}
                actionsDisabled={actionMutation.isPending}
              />
            )}

            {/* Capture confirmation — payments SSOT vs fare + tip */}
            {captureStatus && isCardTrip(captureContext!) && (
              <div
                className={`rounded-md border px-3 py-2 text-xs ${
                  captureStatus.kind === 'capture_mismatch'
                    ? 'border-amber-400 bg-amber-500/10 text-amber-800'
                    : captureStatus.kind === 'captured' || captureStatus.kind === 'captured_split'
                      ? 'border-green-500/40 bg-green-500/10 text-green-800'
                      : 'border-muted bg-muted/30 text-muted-foreground'
                }`}
              >
                <div className={`font-medium ${captureStatusColorClass(captureStatus.kind)}`}>
                  {captureStatus.label}
                </div>
                {captureStatus.expectedTotalPence != null && captureStatus.capturedTotalPence != null && (
                  <div className="mt-1 text-muted-foreground">
                    Settlement {formatPence(captureStatus.expectedTotalPence, currency)} (final_fare + tip + fees)
                    {' · '}
                    Captured {formatPence(captureStatus.capturedTotalPence, currency)}
                    {captureStatus.paymentCount > 1 ? ` across ${captureStatus.paymentCount} PIs` : ''}
                  </div>
                )}
                {captureStatus.tooltip && (
                  <div className="mt-1 text-muted-foreground">{captureStatus.tooltip}</div>
                )}
                {captureStatus.kind === 'captured_split' && (
                  <div className="mt-1 text-muted-foreground">
                    Split capture: primary PI plus shortfall PI (auth cap) — combined total is settlement source of truth.
                  </div>
                )}
              </div>
            )}

            {/* Status row */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline">
                {state.payment_provider === 'revolut' ? 'Revolut' : state.legacy_stripe_trip ? 'Legacy Stripe' : 'Provider'}
              </Badge>
              <Badge variant="outline">Status: {state.stripe_status || state.provider_status || state.payment_status || '—'}</Badge>
              {state.payment_method && (
                <Badge variant="secondary">
                  {state.payment_method_brand ? `${state.payment_method_brand} •••• ${state.last4 ?? ''}` : state.payment_method}
                </Badge>
              )}
              {state.payment_intent_id && (
                <code className="bg-muted px-2 py-0.5 rounded">{state.payment_intent_id}</code>
              )}
              <Badge
                variant="outline"
                className={
                  state.stripe_settlement_verified
                    ? 'bg-green-500/10 text-green-600 border-green-500/30'
                    : 'bg-destructive/10 text-destructive border-destructive/40'
                }
              >
                {state.stripe_settlement_verified ? 'Provider settlement verified' : 'Provider settlement not verified'}
              </Badge>
            </div>

            {/* Money grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">Authorized</div>
                <div className="font-semibold">{formatPence(state.authorized_pence, currency)}</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">Captured (primary PI)</div>
                <div className="font-semibold">{formatPence(state.captured_pence, currency)}</div>
                {captureContext && (() => {
                  const paymentsTotal = getCapturedTotalPence(captureContext);
                  if (paymentsTotal != null && paymentsTotal !== state.captured_pence) {
                    return (
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        All PIs: {formatPence(paymentsTotal, currency)}
                        {getTripTipPence(captureContext) > 0 && ` incl. tip`}
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">Refunded</div>
                <div className="font-semibold">{formatPence(state.refunded_pence, currency)}</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">Refundable</div>
                <div className="font-semibold">{formatPence(state.refundable_pence, currency)}</div>
              </div>
            </div>

            {/* Extra-payment status (legacy / historical context) */}
            <div
              className={`rounded-md border p-3 text-xs space-y-2 ${
                paymentFullyPaid
                  ? 'border-green-500/40 bg-green-500/5'
                  : extraDuePence > 0
                    ? 'border-amber-400 bg-amber-500/10'
                    : 'bg-muted/30'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">Payment coverage</span>
                {paymentFullyPaid ? (
                  <Badge variant="outline" className="bg-green-500/10 text-green-700 border-green-500/30">
                    Fully paid / Captured
                  </Badge>
                ) : extraDuePence > 0 ? (
                  <Badge variant="outline" className="bg-amber-500/10 text-amber-700 border-amber-500/40">
                    Partially paid
                  </Badge>
                ) : (
                  <Badge variant="outline">No fare recorded</Badge>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1">
                {quotedEstimatePence > 0 && quotedEstimatePence !== settlementTotalPence && (
                  <div className="flex justify-between col-span-full">
                    <span className="text-muted-foreground">Quoted / Estimated</span>
                    <span>{formatPence(quotedEstimatePence, currency)}</span>
                  </div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">Final Settlement Total</span><span>{formatPence(settlementTotalPence, currency)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Authorised hold</span><span>{formatPence(authorisedPence, currency)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Captured</span><span>{formatPence(capturedPence, currency)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Released buffer</span><span>{formatPence(releasedBufferPence, currency)}</span></div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Outstanding amount</span>
                  <span className={extraDuePence > 0 ? 'text-amber-700 font-semibold' : ''}>{formatPence(extraDuePence, currency)}</span>
                </div>
              </div>
              {isLegacyTrip && (
                <div className="text-[11px] text-muted-foreground italic">
                  Legacy reconciled from Provider capture — final fare derived from captured amount.
                </div>
              )}
              {isLegacyIncomplete && (
                <div className="text-[11px] text-amber-700 italic">
                  Legacy trip — payment data incomplete. Manual admin confirmation required before any extra charge.
                </div>
              )}
              {isHistoricalShortfall && (
                <div className="rounded border border-amber-400 bg-amber-500/10 p-2 text-amber-800 flex items-start gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>Historical shortfall detected — final fare exceeds captured amount and authorised buffer is exhausted. No automatic charge will be made.</span>
                </div>
              )}
            </div>


            {/* Detailed finance breakdown — Financial Reconciliation (SSOT) only */}
            {isFinanceVariant ? (
            <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1.5">
              <div className="flex justify-between"><span className="text-muted-foreground">Final Settlement Total</span><span>{formatPence(settlementTotalPence, currency)}</span></div>
              {settlementBreakdown?.showBreakdown && settlementBreakdown.waitingPence > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">Waiting time</span><span>{formatPence(settlementBreakdown.waitingPence, currency)}</span></div>
              )}
              <div className="flex justify-between"><span className="text-muted-foreground">Buffer (auth − settlement)</span><span>{formatPence(state.buffer_pence, currency)}</span></div>
              <Separator className="my-1" />
              {state.debt_recovered_pence != null && state.debt_recovered_pence > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">Recovery deduction</span><span>{formatPence(state.debt_recovered_pence, currency)}</span></div>
              )}
              {state.available_payout_created_pence != null && (
                <div className="flex justify-between"><span className="text-muted-foreground">Available payout created</span><span>{formatPence(state.available_payout_created_pence, currency)}</span></div>
              )}
              <div className="flex justify-between"><span className="text-muted-foreground">Gross commission</span><span>{formatPence(state.commission_pence, currency)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Provider fee</span><span className="text-orange-600">{state.stripe_fee_pence > 0 ? `−${formatPence(state.stripe_fee_pence, currency)}` : '—'}</span></div>
              <div className="flex justify-between font-medium"><span>ONECAB net</span><span className="text-blue-600">{formatPence(state.onecab_net_pence, currency)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Driver net</span><span className="text-green-600">{driverNetPence != null ? formatPence(driverNetPence, currency) : 'Unknown'}</span></div>
              <Separator className="my-1" />
              <div className="flex justify-between"><span className="text-muted-foreground">Provider application fee</span><span>{state.stripe_application_fee_amount_pence != null ? formatPence(state.stripe_application_fee_amount_pence, currency) : '—'}</span></div>
              {state.stripe_application_fee_id && <div className="flex justify-between gap-2"><span className="text-muted-foreground">Application fee ID</span><code className="text-[10px] truncate">{state.stripe_application_fee_id}</code></div>}
              {state.stripe_destination_account_id && <div className="flex justify-between gap-2"><span className="text-muted-foreground">Driver destination</span><code className="text-[10px] truncate">{state.stripe_destination_account_id}</code></div>}
              {state.stripe_transfer_id && <div className="flex justify-between gap-2"><span className="text-muted-foreground">Driver transfer</span><code className="text-[10px] truncate">{state.stripe_transfer_id}</code></div>}
              {state.stripe_transfer_amount_pence != null && <div className="flex justify-between"><span className="text-muted-foreground">Transfer amount</span><span>{formatPence(state.stripe_transfer_amount_pence, currency)}</span></div>}
              {settlementWarningText && settlementWarning === 'error' && (
                <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive flex items-start gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{settlementWarningText}</span>
                </div>
              )}
              {settlementWarningText && settlementWarning === 'info' && (
                <div className="rounded border border-blue-500/30 bg-blue-500/5 p-2 text-muted-foreground flex items-start gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-500" />
                  <span>{settlementWarningText}</span>
                </div>
              )}
              <Separator className="my-1" />
              {state.charge_id && <div className="flex justify-between gap-2"><span className="text-muted-foreground">Charge ID</span><code className="text-[10px] truncate">{state.charge_id}</code></div>}
              {state.customer_email && <div className="flex justify-between"><span className="text-muted-foreground">Customer email</span><span className="truncate">{state.customer_email}</span></div>}
              <div className="flex justify-between"><span className="text-muted-foreground">Created</span><span>{fmtTime(state.payment_created_at)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Captured at</span><span>{fmtTime(state.captured_at)}</span></div>
              {state.refunded_at && <div className="flex justify-between"><span className="text-muted-foreground">Refunded at</span><span>{fmtTime(state.refunded_at)}</span></div>}
            </div>
            ) : (
            <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1.5">
              <div className="flex justify-between"><span className="text-muted-foreground">Payment status</span><span>{state.stripe_status || state.payment_status || '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Captured</span><span>{formatPence(capturedPence, currency)}</span></div>
              {captureStatus?.shortLabel && (
                <div className="flex justify-between"><span className="text-muted-foreground">Capture</span><span>{captureStatus.shortLabel}</span></div>
              )}
              <p className="text-[11px] text-muted-foreground pt-1">
                Commission, driver net, and settlement totals: Financial Reconciliation → Trips only.
              </p>
            </div>
            )}

            {/* Trip Actions SSOT — always visible; enabled/disabled by payment state only */}
            {showTripActionsPanel && (
              <FinanceTripActionsPanel
                context={{
                  tripId,
                  tripCode: state.trip_code,
                  paymentIntentId: state.payment_intent_id,
                  chargeId: state.charge_id,
                  driverId: state.driver_id ?? null,
                  passengerId: state.passenger_id ?? null,
                }}
                paymentInput={{
                  paymentMethod: state.payment_method,
                  stripeStatus: state.stripe_status,
                  paymentStatus: state.payment_status,
                  capturedPence,
                  refundedPence: state.refunded_pence,
                  refundablePence: refundable,
                  authorizedPence: authorisedPence,
                  amountCapturablePence: state.amount_capturable_pence,
                  outstandingPence: extraDuePence,
                  hasPaymentIntent: !!state.payment_intent_id,
                  hasCharge: !!state.charge_id || hasCharge,
                  tripCancelled: isCancelled,
                  stripeSettlementVerified: state.stripe_settlement_verified,
                  actionsAllowed: state.actions_allowed,
                }}
                actionsDisabled={actionMutation.isPending || syncStripeMutation.isPending || repairCommissionsMutation.isPending}
                isPending={actionMutation.isPending || syncStripeMutation.isPending || repairCommissionsMutation.isPending}
                onCapture={() => openMode('capture')}
                onRefundFull={() => openMode('refund')}
                onRefundPartial={() => openMode('partial_refund')}
                onCancelAuthorisation={() => openMode('cancel')}
                onResyncStripe={() => syncStripeMutation.mutate()}
                onRequestExtraPayment={() => openExtraPayment()}
                onRepairSettlement={() => syncStripeMutation.mutate()}
                onRecalculateSettlement={() => {
                  const driverId = state.driver_id;
                  if (!driverId) {
                    toast.error('No driver on trip — cannot recalculate commission');
                    return;
                  }
                  repairCommissionsMutation.mutate(driverId);
                }}
                onCommissionAdjustment={() => {
                  const driverId = state.driver_id;
                  if (!driverId) {
                    toast.error('No driver on trip — cannot adjust commission');
                    return;
                  }
                  repairCommissionsMutation.mutate(driverId);
                }}
                onViewAuditLog={() => setAuditOpen(true)}
                onPlatformAdjustment={() => openInternalAdjustment()}
                onDriverCredit={() => {
                  if (!state.driver_id) {
                    toast.error('No driver assigned');
                    return;
                  }
                  const params = new URLSearchParams({
                    driverId: state.driver_id,
                    tab: 'ledger',
                    tripId,
                    adjust: 'credit',
                  });
                  window.open(`/driver-wallet-ledger?${params.toString()}`, '_blank');
                }}
                onDriverDebit={() => {
                  if (!state.driver_id) {
                    toast.error('No driver assigned');
                    return;
                  }
                  const params = new URLSearchParams({
                    driverId: state.driver_id,
                    tab: 'ledger',
                    tripId,
                    adjust: 'debit',
                  });
                  window.open(`/driver-wallet-ledger?${params.toString()}`, '_blank');
                }}
                onCustomerCredit={() => {
                  if (!state.passenger_id) {
                    toast.error('No customer linked');
                    return;
                  }
                  toast.message('Customer credit', {
                    description: 'Use Refund Full/Partial for card credits, or contact support for wallet credits.',
                  });
                }}
                onCustomerDebit={() => {
                  if (!state.passenger_id) {
                    toast.error('No customer linked');
                    return;
                  }
                  toast.message('Customer debit', {
                    description: 'Use platform adjustment or Provider dispute workflow for customer debits.',
                  });
                }}
              />
            )}

            {isFullyRefunded && (
              <Badge variant="outline" className="text-xs">Fully refunded — refund actions disabled; history remains visible above.</Badge>
            )}

            {/* Legacy quick actions retained for edit fare when no outstanding balance */}
            {showTripActionsPanel && (isUncaptured || hasCharge) && !blockEditFareForOutstanding && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => openMode('edit')} disabled={actionMutation.isPending}>
                  <Pencil className="h-4 w-4 mr-1" /> Edit Fare
                </Button>
              </div>
            )}
            {blockEditFareForOutstanding && (
              <p className="text-xs text-amber-700 w-full">
                Edit Fare is disabled while an outstanding balance exists — use Request extra payment (SSOT).
              </p>
            )}

            {/* Audit log */}
            <Collapsible open={auditOpen} onOpenChange={setAuditOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full justify-between">
                  <span className="text-sm">Payment logs ({auditQuery.data?.length ?? 0})</span>
                  <ChevronDown className={`h-4 w-4 transition-transform ${auditOpen ? 'rotate-180' : ''}`} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                {auditQuery.isLoading ? (
                  <Skeleton className="h-12 w-full" />
                ) : !auditQuery.data || auditQuery.data.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">No admin actions recorded.</p>
                ) : (
                  <div className="space-y-2 max-h-72 overflow-y-auto">
                    {auditQuery.data.map((e) => (
                      <div key={e.id} className="rounded-md border p-2 text-xs space-y-1">
                        <div className="flex items-center justify-between">
                          <Badge variant="secondary" className="capitalize">{ACTION_LABEL[e.action] || e.action}</Badge>
                          <span className="text-muted-foreground">{format(new Date(e.created_at), 'dd MMM yyyy HH:mm')}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Before → After</span>
                          <span>{formatPence(e.amount_pence_before ?? 0, currency)} → {formatPence(e.amount_pence_after ?? 0, currency)}</span>
                        </div>
                        {e.delta_pence !== null && e.delta_pence !== 0 && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Delta</span>
                            <span>{formatPence(e.delta_pence, currency)}</span>
                          </div>
                        )}
                        <div><span className="text-muted-foreground">Reason: </span>{e.reason}</div>
                        {e.stripe_refund_id && <div className="text-muted-foreground break-all">Refund: {e.stripe_refund_id}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          </>
        ) : null}
      </CardContent>

      <Dialog open={!!mode} onOpenChange={(o) => !o && !actionMutation.isPending && setMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDesc}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {mode !== 'cancel' && mode !== 'extra_payment' && (
              <div>
                <Label>{mode === 'edit' ? 'New total' : 'Amount'} ({currency})</Label>
                <Input
                  type="number" step="0.01" min="0.01"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  disabled={mode === 'refund'}
                />
                {mode === 'partial_refund' && state && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Refundable: {formatPence(refundable, currency)}
                  </p>
                )}
              </div>
            )}
            {mode === 'extra_payment' && (
              <p className="text-sm text-muted-foreground">
                Server will charge the outstanding delta only ({formatPence(extraDuePence, currency)}).
              </p>
            )}
            <div>
              <Label>Reason (required, min 5 chars)</Label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMode(null)} disabled={actionMutation.isPending}>Cancel</Button>
            <Button
              onClick={submit}
              disabled={actionMutation.isPending}
              variant={mode === 'cancel' || mode === 'refund' || mode === 'partial_refund' ? 'destructive' : 'default'}
            >
              {actionMutation.isPending && <RefreshCw className="h-4 w-4 mr-2 animate-spin" />}
              Confirm {dialogTitle}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
