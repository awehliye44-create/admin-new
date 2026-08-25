import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { Loader2, RefreshCw } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useAdminPaymentSessions,
  useInspectPaymentSessionProvider,
  usePaymentSessionHoldAction,
  usePaymentSessionRefund,
} from '@/hooks/useAdminPaymentSessions';
import type {
  AdminPaymentSessionsListRow,
  AdminPaymentSessionsTab,
} from '../../shared/adminPaymentSessionsSSOT';
import { paymentSessionsUrl } from '../../shared/adminPaymentSessionsSSOT';
import type { PaymentSessionPurpose } from '../../shared/paymentSessionPhase1SSOT';
import {
  financeReconciliationTripUrl,
  tripSettlementRecoverUrl,
} from '@/lib/financialReconciliationRoutes';
import { formatAgeMinutes, formatNullablePence } from '@/lib/formatNullablePence';
import {
  classifyCaptureConfirmation,
  collectOutstandingActionLabel,
  sendPaymentLinkActionLabel,
} from '../../shared/paymentSessionsCaptureConfirmationSSOT';
import { isValidConfirmedCapturePence } from '../../shared/paymentCaptureEvidenceSSOT';
import {
  DEFAULT_SERVICE_AREA_SELECTION,
  ServiceAreaFinanceFilter,
  type ServiceAreaFinanceSelection,
} from '@/components/finance/ServiceAreaFinanceFilter';
import { PaymentSessionsKpiStrip, type PaymentSessionsKpiDrill } from '@/components/finance/PaymentSessionsKpiStrip';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';


/** PS-owned lifecycle tabs only. Trip matching / settlement conclusions live on Financial Reconciliation. */
const TABS: Array<{ id: AdminPaymentSessionsTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'provider_payments', label: 'Provider Payments' },
  { id: 'active_holds', label: 'Active Holds' },
  { id: 'captured', label: 'Captured — Provider Confirmed' },
  { id: 'released', label: 'Released' },
  { id: 'refunded', label: 'Refunds' },
  { id: 'failed_recovery', label: 'Recovery' },
  { id: 'history', label: 'History' },
];

const FR_OWNED_TABS = new Set<AdminPaymentSessionsTab>([
  'completed_trips_paid',
  'payment_matching',
]);

const PURPOSES: PaymentSessionPurpose[] = [
  'RIDE_BOOKING',
  'SAVE_CARD',
  'PAYMENT_RECOVERY',
  'LEGACY_EVIDENCE',
];

type TriState = 'all' | 'true' | 'false';

function parseTab(raw: string | null): AdminPaymentSessionsTab {
  if (raw && FR_OWNED_TABS.has(raw as AdminPaymentSessionsTab)) {
    // Trip-match / settlement views moved to Financial Reconciliation.
    return 'overview';
  }
  if (raw && TABS.some((t) => t.id === raw)) return raw as AdminPaymentSessionsTab;
  return 'overview';
}

function pageStatusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'LIVE') return 'default';
  if (status === 'PROVIDER_UNAVAILABLE' || status === 'DEGRADED') return 'destructive';
  return 'secondary';
}

function triStateToBool(value: TriState): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function SessionActions({
  row,
  actingId,
  inspectingId,
  onAction,
  onRefund,
  onInspect,
  onRequestRecovery,
  onAbandonRecovery,
  onRefreshProvider,
}: {

  row: AdminPaymentSessionsListRow;
  actingId: string | null;
  inspectingId: string | null;
  onAction: (row: AdminPaymentSessionsListRow, action: 'release' | 'retry_release' | 'retry_recovery') => void;
  onRefund: (row: AdminPaymentSessionsListRow) => void;
  onInspect: (row: AdminPaymentSessionsListRow) => void;
  onRequestRecovery: (row: AdminPaymentSessionsListRow, mode?: 'collect_outstanding' | 'payment_link') => void;
  onAbandonRecovery: (row: AdminPaymentSessionsListRow) => void;
  onRefreshProvider?: (row: AdminPaymentSessionsListRow) => void;
}) {

  const key = row.provider_order_id || row.payment_session_id || row.id;
  const busy = actingId === key;
  const inspecting = inspectingId === key;
  const policy = row.action_policy;
  // Provider-truth SSOT: financial buttons come only from backend allowed_actions.
  // Empty array = no actions. Never fall back to local action_policy / stale columns.
  const allowedDefined = Array.isArray(row.allowed_actions);
  const allowedActions = new Set(row.allowed_actions ?? []);
  const canRelease = allowedDefined && allowedActions.has('release_hold');
  const canRetryRelease = allowedDefined && allowedActions.has('retry_release');
  const canRetryRecovery = allowedDefined && allowedActions.has('retry_recovery');
  const canCaptureFinal = allowedDefined && allowedActions.has('capture_final_amount');
  const canRefreshProvider = allowedDefined && allowedActions.has('refresh_provider_evidence');
  const captureConfirmation = classifyCaptureConfirmation({
    providerState: row.provider_state,
    providerCapturedPence: row.captured_amount_pence,
    localCapturedPence: row.captured_amount_pence,
    canonicalPayablePence: row.customer_payable_pence,
    authorisedPence: row.authorised_amount_pence,
    purpose: row.purpose,
  });
  const offerCollectOutstanding = allowedDefined
    ? allowedActions.has('collect_outstanding')
    : false;
  const offerSendPaymentLink = allowedDefined
    ? allowedActions.has('send_payment_link')
    : false;
  const overcaptureRefundRequired =
    captureConfirmation.classification === 'OVERCAPTURED_REFUND_REQUIRED'
    && captureConfirmation.difference_pence != null
    && captureConfirmation.difference_pence > 0;
  /** Every linked trip gets a manual refund entry — not only overcapture SSOT. */
  const canRefund = Boolean(row.trip_id);
  const outstandingForAction = row.outstanding_pence
    ?? captureConfirmation.outstanding_pence;
  const captureFullyConfirmed =
    (row.action_classification === 'CAPTURED_CONFIRMED'
      || row.action_classification === 'CAPTURE_CONFIRMED'
      || captureConfirmation.classification === 'CAPTURED_CONFIRMED')
    && isValidConfirmedCapturePence(row.captured_amount_pence);
  const noActionRequired =
    row.action_classification === 'NO_ACTIVE_HOLD'
    || row.action_classification === 'CAPTURED_CONFIRMED'
    || row.action_classification === 'CAPTURE_CONFIRMED'
    || row.action_classification === 'RELEASED_CONFIRMED'
    || row.action_classification === 'RELEASE_CONFIRMED'
    || row.action_classification === 'PROVIDER_ALREADY_RELEASED'
    || row.action_classification === 'AUTHORISATION_EXPIRED'
    || (captureFullyConfirmed && !offerCollectOutstanding && !overcaptureRefundRequired);
  return (
    <div className="flex flex-wrap gap-1">
      {row.customer_id && (
        <Button asChild size="sm" variant="outline">
          <Link to={`/riders?customerId=${encodeURIComponent(row.customer_id)}`}>
            Customer
          </Link>
        </Button>
      )}
      {row.trip_id && policy?.can_open_trip !== false && (
        <Button asChild size="sm" variant="outline">
          <Link to={tripSettlementRecoverUrl(row.trip_id, row.trip_code)}>Open completed trip</Link>
        </Button>
      )}
      {policy?.can_open_reconciliation && row.trip_id && (
        <Button asChild size="sm" variant="outline">
          <Link to={financeReconciliationTripUrl(row.trip_id, row.trip_code)}>
            Financial Reconciliation
          </Link>
        </Button>
      )}
      {canRelease && (
        <Button size="sm" disabled={busy} onClick={() => onAction(row, 'release')}>
          {busy
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : (row.releasable_pence != null && row.releasable_pence > 0
              ? `Release hold £${(row.releasable_pence / 100).toFixed(2)}`
              : 'Release hold')}
        </Button>
      )}
      {canCaptureFinal && row.trip_id && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onRequestRecovery(row, 'collect_outstanding')}
        >
          {outstandingForAction != null && outstandingForAction > 0
            ? `Capture Final Amount £${(outstandingForAction / 100).toFixed(2)}`
            : 'Capture Final Amount'}
        </Button>
      )}
      {canRetryRelease && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction(row, 'retry_release')}>
          Retry release
        </Button>
      )}
      {canRetryRecovery && !captureFullyConfirmed && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction(row, 'retry_recovery')}>
          Retry Recovery
        </Button>
      )}
      {canRefreshProvider && onRefreshProvider && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onRefreshProvider(row)}>
          Refresh provider evidence
        </Button>
      )}
      {canRefund && (
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => onRefund(row)}
        >
          {busy
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : overcaptureRefundRequired
              ? `Refund £${(captureConfirmation.difference_pence! / 100).toFixed(2)}`
              : 'Refund'}
        </Button>
      )}
      {row.trip_id
        && row.purpose !== 'PAYMENT_RECOVERY'
        && offerCollectOutstanding
        && outstandingForAction != null
        && outstandingForAction > 0
        && (
          <Button size="sm" variant="default" disabled={busy} onClick={() => onRequestRecovery(row, 'collect_outstanding')}>
            {collectOutstandingActionLabel(outstandingForAction)}
          </Button>
        )}
      {row.trip_id
        && row.purpose !== 'PAYMENT_RECOVERY'
        && offerSendPaymentLink
        && outstandingForAction != null
        && outstandingForAction > 0
        && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onRequestRecovery(row, 'payment_link')}>
            {sendPaymentLinkActionLabel(outstandingForAction)}
          </Button>
        )}

      {row.trip_id && row.purpose === 'PAYMENT_RECOVERY' && (
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => onAbandonRecovery(row)}>
          Abandon recovery &amp; release hold
        </Button>
      )}
      {row.provider_order_id && (
        <Button size="sm" variant="ghost" disabled={inspecting} onClick={() => onInspect(row)}>
          {inspecting ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Provider evidence'}
        </Button>
      )}
      {row.provider_verification_status === 'UNAVAILABLE' && (
        <Badge variant="destructive">Provider verification unavailable</Badge>
      )}
      {noActionRequired && (
        <Badge variant="outline">No action required</Badge>
      )}
      {row.action_classification === 'NO_ACTIVE_HOLD' && (
        <Badge variant="outline">Provider verified ✅</Badge>
      )}
      {(row.action_classification === 'PROVIDER_ALREADY_RELEASED'
        || row.action_classification === 'RELEASED_CONFIRMED'
        || row.action_classification === 'RELEASE_CONFIRMED') && (
        <Badge variant="outline">Provider verified ✅</Badge>
      )}
      {row.action_classification === 'PROVIDER_REFRESH_REQUIRED' && (
        <Badge variant="secondary">Provider refresh required</Badge>
      )}
      {row.releasable_pence != null && row.releasable_pence > 0 && canRelease && (
        <span className="text-[10px] text-muted-foreground self-center">
          Releasable {formatNullablePence(row.releasable_pence)}
        </span>
      )}
      {row.outstanding_pence != null && row.outstanding_pence > 0
        && (canRetryRecovery || offerCollectOutstanding) && (
        <span className="text-[10px] text-amber-700 self-center">
          Outstanding {formatNullablePence(row.outstanding_pence)}
        </span>
      )}

    </div>
  );
}

export default function PaymentSessions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const paymentSessionId = searchParams.get('paymentSessionId');
  const providerOrderId = searchParams.get('providerOrderId');
  const tripIdParam = searchParams.get('tripId');
  const customerIdParam = searchParams.get('customerId');

  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(
    DEFAULT_SERVICE_AREA_SELECTION,
  );
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [provider, setProvider] = useState<string>('all');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [purpose, setPurpose] = useState<string>('all');
  const [sessionStatus, setSessionStatus] = useState('');
  const [providerState, setProviderState] = useState('');
  const [customerId, setCustomerId] = useState(customerIdParam ?? '');
  const [tripIdFilter, setTripIdFilter] = useState(tripIdParam ?? '');
  const [hasTrip, setHasTrip] = useState<TriState>('all');
  const [activeHold, setActiveHold] = useState(false);
  const [releaseFailed, setReleaseFailed] = useState(searchParams.get('releaseFailed') === '1');
  const [recoveryPending, setRecoveryPending] = useState(searchParams.get('recoveryPending') === '1');
  const [providerFeesPending, setProviderFeesPending] = useState(
    searchParams.get('providerFeesPending') === '1',
  );
  const [captureFailed, setCaptureFailed] = useState(searchParams.get('captureFailed') === '1');
  const [refreshProviderState, setRefreshProviderState] = useState(false);
  const [listOffset, setListOffset] = useState(0);

  const [actingId, setActingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [inspectSnapshots, setInspectSnapshots] = useState<Record<string, Record<string, unknown>>>({});
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [refundRow, setRefundRow] = useState<AdminPaymentSessionsListRow | null>(null);
  const [refundAmountInput, setRefundAmountInput] = useState('');
  const [refundReason, setRefundReason] = useState('');

  useEffect(() => {
    if (customerIdParam) setCustomerId(customerIdParam);
  }, [customerIdParam]);

  useEffect(() => {
    if (tripIdParam) setTripIdFilter(tripIdParam);
  }, [tripIdParam]);

  useEffect(() => {
    setListOffset(0);
  }, [
    tab,
    paymentSessionId,
    providerOrderId,
    tripIdFilter,
    customerId,
    dateFrom,
    dateTo,
    serviceFilter.serviceAreaId,
    provider,
    paymentMethod,
    purpose,
    sessionStatus,
    providerState,
    hasTrip,
    activeHold,
    releaseFailed,
    recoveryPending,
    providerFeesPending,
    captureFailed,
  ]);

  const pageLimit = tab === 'history' || tab === 'overview' ? 100 : 100;

  const request = useMemo(
    () => ({
      tab,
      payment_session_id: paymentSessionId,
      provider_order_id: providerOrderId,
      trip_id: tripIdFilter.trim() || null,
      customer_id: customerId.trim() || null,
      limit: pageLimit,
      offset: listOffset,
      date_from: dateFrom || null,
      date_to: dateTo || null,
      service_area_id: serviceFilter.serviceAreaId,
      provider: provider === 'all' ? null : provider,
      payment_method: paymentMethod.trim() || null,
      purpose: purpose === 'all' ? null : (purpose as PaymentSessionPurpose),
      session_status: sessionStatus.trim() || null,
      provider_state: providerState.trim() || null,
      has_trip: triStateToBool(hasTrip),
      active_hold: activeHold ? true : null,
      release_failed: releaseFailed ? true : null,
      recovery_pending: recoveryPending ? true : null,
      provider_fees_pending: providerFeesPending ? true : null,
      capture_failed: captureFailed ? true : null,
      ...(refreshProviderState ? { refresh_provider_state: true as const } : {}),
    }),
    [
      tab,
      paymentSessionId,
      providerOrderId,
      tripIdFilter,
      customerId,
      pageLimit,
      listOffset,
      dateFrom,
      dateTo,
      serviceFilter.serviceAreaId,
      provider,
      paymentMethod,
      purpose,
      sessionStatus,
      providerState,
      hasTrip,
      activeHold,
      releaseFailed,
      recoveryPending,
      providerFeesPending,
      captureFailed,
      refreshProviderState,
    ],
  );

  const { data, isLoading, isFetching, error, refetch } = useAdminPaymentSessions(request);
  const holdAction = usePaymentSessionHoldAction();
  const refundAction = usePaymentSessionRefund();
  const inspectProvider = useInspectPaymentSessionProvider();

  useEffect(() => {
    if (!refreshProviderState) return;
    if (isFetching || isLoading) return;
    setRefreshProviderState(false);
  }, [refreshProviderState, isFetching, isLoading]);

  // Action tabs: refresh provider evidence so allowed_actions are not STALE-gated.
  useEffect(() => {
    if (tab === 'active_holds' || tab === 'failed_recovery') {
      setRefreshProviderState(true);
    }
  }, [tab]);

  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  const applyKpiDrill = (drill: PaymentSessionsKpiDrill) => {
    setProviderFeesPending(Boolean(drill.provider_fees_pending));
    setCaptureFailed(Boolean(drill.capture_failed));
    setRecoveryPending(Boolean(drill.recovery_pending));
    setReleaseFailed(Boolean(drill.release_failed));
    setListOffset(0);
    const params = new URLSearchParams(searchParams);
    params.set('tab', drill.tab);
    if (drill.provider_fees_pending) params.set('providerFeesPending', '1');
    else params.delete('providerFeesPending');
    if (drill.capture_failed) params.set('captureFailed', '1');
    else params.delete('captureFailed');
    if (drill.recovery_pending) params.set('recoveryPending', '1');
    else params.delete('recoveryPending');
    if (drill.release_failed) params.set('releaseFailed', '1');
    else params.delete('releaseFailed');
    params.delete('moneyAtRisk');
    params.delete('matchStatus');
    setSearchParams(params, { replace: true });
  };

  const clearLocalFilters = () => {
    setServiceFilter(DEFAULT_SERVICE_AREA_SELECTION);
    setDateFrom('');
    setDateTo('');
    setProvider('all');
    setPaymentMethod('');
    setPurpose('all');
    setSessionStatus('');
    setProviderState('');
    setCustomerId('');
    setTripIdFilter('');
    setHasTrip('all');
    setActiveHold(false);
    setReleaseFailed(false);
    setRecoveryPending(false);
    setProviderFeesPending(false);
    setCaptureFailed(false);
    setListOffset(0);
    const params = new URLSearchParams(searchParams);
    params.delete('customerId');
    params.delete('tripId');
    params.delete('providerFeesPending');
    params.delete('captureFailed');
    params.delete('recoveryPending');
    params.delete('releaseFailed');
    params.delete('moneyAtRisk');
    params.delete('matchStatus');
    setSearchParams(params, { replace: true });
  };

  const hasLocalFilters =
    !!serviceFilter.serviceAreaId
    || !!dateFrom
    || !!dateTo
    || provider !== 'all'
    || !!paymentMethod.trim()
    || purpose !== 'all'
    || !!sessionStatus.trim()
    || !!providerState.trim()
    || !!customerId.trim()
    || !!tripIdFilter.trim()
    || hasTrip !== 'all'
    || activeHold
    || releaseFailed
    || recoveryPending
    || providerFeesPending
    || captureFailed;

  const runAction = useCallback(
    async (
      row: AdminPaymentSessionsListRow,
      action: 'release' | 'retry_release' | 'retry_recovery',
    ) => {
      const actionKey = row.provider_order_id || row.payment_session_id || row.id;
      setActingId(actionKey);
      try {
        const result = await holdAction.mutateAsync({
          ...(row.source === 'payment_sessions' && row.payment_session_id
            ? { payment_session_id: row.payment_session_id }
            : {}),
          provider_order_id: row.provider_order_id ?? undefined,
          action,
        }) as { already_resolved?: boolean };
        if (result?.already_resolved) {
          toast.success('Already resolved at provider');
        } else {
          toast.success(`Hold ${action.replace('_', ' ')} requested`);
        }
        await refetch();
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err ?? '');
        if (
          msg.includes('PAYMENT_ACTION_STALE_REFRESH_REQUIRED')
          || msg.includes('NO_ACTIVE_HOLD')
          || msg.includes('PROVIDER_REFRESH_REQUIRED')
          || msg.includes('NOTHING_TO_RELEASE')
        ) {
          toast.error(`${msg} — refreshing row`);
          setRefreshProviderState(true);
          await refetch();
        } else {
          toast.error(msg || 'Action failed');
        }
      } finally {
        setActingId(null);
      }
    },
    [holdAction, refetch],
  );

  const openRefundSheet = useCallback((row: AdminPaymentSessionsListRow) => {
    if (!row.trip_id) {
      toast.error('Trip id is required to refund');
      return;
    }
    const confirmation = classifyCaptureConfirmation({
      providerState: row.provider_state,
      providerCapturedPence: row.captured_amount_pence,
      localCapturedPence: row.captured_amount_pence,
      canonicalPayablePence: row.customer_payable_pence,
      authorisedPence: row.authorised_amount_pence,
      purpose: row.purpose,
    });
    const suggestedPence = confirmation.difference_pence != null
      && confirmation.difference_pence > 0
      && confirmation.classification === 'OVERCAPTURED_REFUND_REQUIRED'
      ? confirmation.difference_pence
      : null;
    setRefundRow(row);
    setRefundAmountInput(
      suggestedPence != null ? (suggestedPence / 100).toFixed(2) : '',
    );
    setRefundReason(
      suggestedPence != null
        ? `Overcapture refund for ${row.trip_code ?? row.trip_id}`
        : `Payment Sessions refund for ${row.trip_code ?? row.trip_id}`,
    );
  }, []);

  const submitRefundSheet = useCallback(async () => {
    if (!refundRow?.trip_id) {
      toast.error('Trip id is required to refund');
      return;
    }
    const pounds = Number(refundAmountInput);
    if (!Number.isFinite(pounds) || pounds <= 0) {
      toast.error('Enter a refund amount greater than £0');
      return;
    }
    const amountPence = Math.round(pounds * 100);
    if (amountPence < 1) {
      toast.error('Enter a refund amount greater than £0');
      return;
    }
    const captured = refundRow.captured_amount_pence;
    const alreadyRefunded = refundRow.refunded_amount_pence ?? 0;
    if (captured != null) {
      const refundable = Math.max(0, captured - alreadyRefunded);
      if (amountPence > refundable) {
        toast.error(
          `Cannot refund more than £${(refundable / 100).toFixed(2)} remaining`,
        );
        return;
      }
    }
    const actionKey = refundRow.provider_order_id
      || refundRow.payment_session_id
      || refundRow.id;
    setActingId(actionKey);
    try {
      const data = await refundAction.mutateAsync({
        tripId: refundRow.trip_id,
        amountPence,
        reason: refundReason.trim() || undefined,
      });
      toast.success(
        data?.message ?? `Refunded £${(amountPence / 100).toFixed(2)}`,
      );
      setRefundRow(null);
      setRefundAmountInput('');
      setRefundReason('');
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refund failed');
    } finally {
      setActingId(null);
    }
  }, [refundRow, refundAmountInput, refundReason, refundAction, refetch]);

  const runRequestRecovery = useCallback(
    async (
      row: AdminPaymentSessionsListRow,
      mode: 'collect_outstanding' | 'payment_link' = 'collect_outstanding',
    ) => {
      if (!row.trip_id) {
        toast.error('Trip id is required to open a recovery payment');
        return;
      }
      const confirmation = classifyCaptureConfirmation({
        providerState: row.provider_state,
        providerCapturedPence: row.captured_amount_pence,
        localCapturedPence: row.captured_amount_pence,
        canonicalPayablePence: row.customer_payable_pence,
        authorisedPence: row.authorised_amount_pence,
        purpose: row.purpose,
      });
      // Backend `row.outstanding_pence` is the SSOT (set for active-auth capture
      // flows too); the local classifier only covers post-capture rows and
      // returns null for AUTHORISED_ACTIVE, so we must not gate on it alone.
      const outstanding = row.outstanding_pence ?? confirmation.outstanding_pence;
      if (outstanding == null || outstanding <= 0) {
        toast.error('No outstanding balance to collect — full-fare recapture is blocked');
        return;
      }
      const actionKey = row.provider_order_id || row.payment_session_id || row.id;
      setActingId(actionKey);
      try {
        const { data, error } = await supabase.functions.invoke('create-payment-recovery', {
          body: {
            trip_id: row.trip_id,
            parent_session_id: row.payment_session_id ?? null,
            amount_pence: outstanding,
            action_mode: mode,
          },
        });
        if (error) throw error;
        const payload = (data ?? {}) as {
          checkout_url?: string | null;
          reused?: boolean;
          already_completed?: boolean;
          message?: string;
          amount?: number;
          outstanding_pence?: number;
        };
        if (payload.already_completed) {
          toast.success(payload.message ?? 'Recovery payment is already completed; no duplicate charge was created');
          await refetch();
          return;
        }
        if (payload.checkout_url) {
          try { await navigator.clipboard.writeText(payload.checkout_url); } catch { /* ignore */ }
          toast.success(
            mode === 'payment_link'
              ? (payload.reused
                ? 'Existing payment link copied — charges outstanding only'
                : `Payment link for £${((payload.amount ?? outstanding) / 100).toFixed(2)} created and copied`)
              : (payload.reused
                ? 'Existing recovery link copied — outstanding only'
                : `Collect Outstanding £${((payload.amount ?? outstanding) / 100).toFixed(2)} link created and copied`),
          );
          window.open(payload.checkout_url, '_blank', 'noopener');
        } else {
          toast.success('Recovery session created for outstanding balance only');
        }
        await refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Recovery request failed');
      } finally {
        setActingId(null);
      }
    },
    [refetch],
  );

  const runAbandonRecovery = useCallback(
    async (row: AdminPaymentSessionsListRow) => {
      if (!row.trip_id) {
        toast.error('Trip id required');
        return;
      }
      const reason = window.prompt(
        'Abandon recovery and release the original hold?\nEnter reason (min 5 chars):',
        '',
      );
      if (!reason || reason.trim().length < 5) return;
      const actionKey = row.provider_order_id || row.payment_session_id || row.id;
      setActingId(actionKey);
      try {
        const { data, error } = await supabase.functions.invoke('admin-cancel-trip-payment', {
          body: { trip_id: row.trip_id, reason: reason.trim(), abandon_recovery: true },
        });
        if (error) throw error;
        const payload = (data ?? {}) as { released_pence?: number };
        toast.success(
          `Recovery abandoned. Hold released${
            typeof payload.released_pence === 'number' ? ` (${(payload.released_pence / 100).toFixed(2)})` : ''
          }.`,
        );
        await refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Abandon recovery failed');
      } finally {
        setActingId(null);
      }
    },
    [refetch],
  );

  const runInspect = useCallback(

    async (row: AdminPaymentSessionsListRow) => {
      if (!row.provider_order_id) {
        toast.error('Missing provider order id');
        return;
      }
      const key = row.id;
      const actionKey = row.provider_order_id || row.payment_session_id || row.id;
      setExpandedId(key);
      setInspectingId(actionKey);
      try {
        const snapshot = await inspectProvider.mutateAsync(row.provider_order_id);
        setInspectSnapshots((prev) => ({ ...prev, [key]: snapshot ?? {} }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Inspect failed');
      } finally {
        setInspectingId(null);
      }
    },
    [inspectProvider],
  );

  const rows = data?.rows ?? [];
  const summary = data?.summary;
  const filteredTotal = data?.filtered_total ?? rows.length;
  const hasMore = Boolean(data?.has_more);
  const pageStart = filteredTotal === 0 ? 0 : listOffset + 1;
  const pageEnd = listOffset + rows.length;

  return (
    <AdminLayout title="Payment Sessions (SSOT)">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              Canonical source for customer payment lifecycle: authorisation, capture, release, refund, provider fee, and provider state.
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge variant={pageStatusVariant(data?.page_status ?? 'PARTIAL')}>
                {data?.page_status ?? 'PARTIAL'}
              </Badge>
              {summary && (
                <>
                  <Badge variant="destructive">
                    Active Action Required: {summary.active_action_required_count ?? summary.red}
                  </Badge>
                  <Badge variant="secondary">
                    Automatically Recovering: {summary.automatically_recovering_count ?? summary.amber}
                  </Badge>
                  <Badge variant="outline">
                    Automatically Recovered: {summary.automatically_recovered_count ?? 0}
                  </Badge>
                  <Badge variant="outline">
                    Cancelled by Customer: {summary.cancelled_by_customer_count ?? 0}
                  </Badge>
                  <Badge variant="outline">
                    Test/Sandbox: {summary.test_sandbox_count ?? 0}
                  </Badge>
                  <Badge variant="outline">Active holds: {summary.active_hold_count}</Badge>
                  <Badge variant="destructive">
                    RED: {summary.active_action_required_count ?? summary.red}
                  </Badge>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                setRefreshProviderState(true);
                try {
                  const { data: r, error: e } = await supabase.functions.invoke(
                    'admin-refresh-payment-sessions',
                    { body: {} },
                  );
                  if (e) throw e;
                  const refreshed = (r as { refreshed?: number } | null)?.refreshed ?? 0;
                  toast.success(`Provider state refreshed for ${refreshed} session(s)`);
                  await refetch();
                } catch (err) {
                  toast.error(`Refresh failed: ${(err as Error).message ?? String(err)}`);
                } finally {
                  setRefreshProviderState(false);
                }
              }}
              disabled={isFetching || refreshProviderState}
            >
              {refreshProviderState
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RefreshCw className="h-4 w-4" />}
              <span className="ml-2">Force refresh provider</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span className="ml-2">Refresh</span>
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">From</Label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-[150px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">To</Label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-[150px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Service area</Label>
            <ServiceAreaFinanceFilter
              financialModel="PLATFORM_COLLECTED"
              value={serviceFilter}
              onChange={setServiceFilter}
              autoSelectFirstArea={false}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Provider</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="revolut">revolut</SelectItem>
                <SelectItem value="provider">provider — archived legacy</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Payment method</Label>
            <Input
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              placeholder="e.g. card"
              className="w-[140px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Purpose</Label>
            <Select value={purpose} onValueChange={setPurpose}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {PURPOSES.map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Session status</Label>
            <Input
              value={sessionStatus}
              onChange={(e) => setSessionStatus(e.target.value)}
              placeholder="status"
              className="w-[140px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Provider state</Label>
            <Input
              value={providerState}
              onChange={(e) => setProviderState(e.target.value)}
              placeholder="state"
              className="w-[140px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Customer ID</Label>
            <Input
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="customer uuid"
              className="w-[220px] font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Trip ID</Label>
            <Input
              value={tripIdFilter}
              onChange={(e) => setTripIdFilter(e.target.value)}
              placeholder="trip uuid"
              className="w-[220px] font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Has trip</Label>
            <Select value={hasTrip} onValueChange={(v) => setHasTrip(v as TriState)}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="true">true</SelectItem>
                <SelectItem value="false">false</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-3 pb-2">
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={activeHold} onCheckedChange={(v) => setActiveHold(v === true)} />
              active_hold
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={releaseFailed} onCheckedChange={(v) => setReleaseFailed(v === true)} />
              release_failed
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={recoveryPending} onCheckedChange={(v) => setRecoveryPending(v === true)} />
              recovery_pending
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={providerFeesPending} onCheckedChange={(v) => setProviderFeesPending(v === true)} />
              provider_fees_pending
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={captureFailed} onCheckedChange={(v) => setCaptureFailed(v === true)} />
              capture_failed
            </label>
          </div>
          {hasLocalFilters && (
            <Button variant="ghost" size="sm" onClick={clearLocalFilters}>
              Clear filters
            </Button>
          )}
        </div>

        {data?.provider_verification_message && (
          <Alert variant="destructive">
            <AlertTitle>Provider Sync Pending</AlertTitle>
            <AlertDescription>
              {data.provider_verification_message}
              {' '}
              Automatic retry will run while this page stays open.
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Payment Sessions failed to load</AlertTitle>
            <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
          </Alert>
        )}

        {data?.trip_evidence_message && (
          <Alert>
            <AlertTitle>Trip evidence</AlertTitle>
            <AlertDescription>{data.trip_evidence_message}</AlertDescription>
          </Alert>
        )}

        <PaymentSessionsKpiStrip
          summary={summary}
          currencyCode={serviceFilter.currencyCode ?? 'GBP'}
          onDrill={applyKpiDrill}
        />

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex h-auto flex-wrap">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>
            ))}
          </TabsList>

          {TABS.map((t) => (
            <TabsContent key={t.id} value={t.id} className="space-y-3">
              {t.id === 'overview' && (
                <p className="text-sm text-muted-foreground">
                  Payment Sessions owns customer payment lifecycle: authorisation, capture, release, refund,
                  provider fee, and provider state. Trip fare settlement, wallet credits, and reconciliation
                  conclusions live on Financial Reconciliation / Driver Wallet Ledger / Payout Ledger.
                </p>
              )}
              {t.id === 'provider_payments' && (
                <p className="text-sm text-muted-foreground">
                  Authoritative provider lifecycle. Never shows trip fare or authorised amount as captured.
                </p>
              )}
              {t.id === 'captured' && (
                <p className="text-sm text-muted-foreground">
                  Confirmed provider-captured payments only (captured amount present). Authorisations are excluded.
                </p>
              )}
              {t.id === 'active_holds' && (
                <p className="text-sm text-muted-foreground">
                  Live authorisations only — never captured, released, refunded, or cancelled.
                </p>
              )}
              {t.id === 'released' && (
                <p className="text-sm text-muted-foreground">
                  Released holds with amount, time, and provider verification.
                </p>
              )}
              {t.id === 'refunded' && (
                <p className="text-sm text-muted-foreground">Refunded payments only.</p>
              )}
              {t.id === 'failed_recovery' && (
                <p className="text-sm text-muted-foreground">
                  Payments needing operator intervention (release failed / recovery pending).
                </p>
              )}
              {t.id === 'history' && (
                <p className="text-sm text-muted-foreground">
                  Full immutable history. Supports date, trip, customer, provider, and status filters.
                </p>
              )}

              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : rows.length === 0 ? (
                <Alert>
                  <AlertTitle>No payment attempts match the selected filters.</AlertTitle>
                  <AlertDescription>
                    Try Overview or History, or clear deep-link filters.
                    {paymentSessionId || providerOrderId || tripIdFilter || hasLocalFilters ? (
                      <>
                        {' '}
                        <Link
                          className="underline"
                          to={paymentSessionsUrl({ tab: t.id })}
                          onClick={clearLocalFilters}
                        >
                          Clear filters
                        </Link>
                      </>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Created</TableHead>
                        <TableHead>Payment Session ID</TableHead>
                        <TableHead>Provider Refs</TableHead>
                        <TableHead>Trip ID</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>Service Area</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead>Payment Method</TableHead>
                        <TableHead>Purpose</TableHead>
                        <TableHead>Customer Payable</TableHead>
                        <TableHead>Pre-auth Buffer</TableHead>
                        <TableHead>Authorised</TableHead>
                        <TableHead>Captured</TableHead>
                        <TableHead>Difference</TableHead>
                        <TableHead>Reconciliation</TableHead>
                        <TableHead>Released</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Refunded</TableHead>
                        <TableHead>Provider Fee</TableHead>
                        <TableHead>Fee Status</TableHead>
                        <TableHead>Provider State</TableHead>
                        <TableHead>Verification Status</TableHead>
                        <TableHead>Session Status</TableHead>
                        <TableHead>Evidence Status</TableHead>
                        <TableHead>Age</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => {
                        const key = row.id;
                        const verificationLabel = (() => {
                          const v = row.provider_verification_status;
                          if (v === 'VERIFIED') return 'Verified';
                          if (v === 'STALE') return 'Cached / stale';
                          if (v === 'UNAVAILABLE') return 'Provider record unavailable';
                          if (!row.provider_order_id) return 'Refresh required';
                          return v ?? 'UNKNOWN';
                        })();
                        const evidenceLabel = (() => {
                          const s = String(row.evidence_status ?? '').toUpperCase();
                          if (s === 'COMPLETE') return 'Provider evidence';
                          if (s === 'PENDING_PROVIDER_FEE') return 'Pending provider fee';
                          if (s === 'LOCAL_BACKFILL_REQUIRED' || s.includes('BACKFILL')) {
                            return row.evidence_label?.includes('PROVIDER REFRESH')
                              ? 'Refresh required'
                              : 'Backfill required';
                          }
                          if (s.includes('CAPTURE')) return row.evidence_label ?? 'Local evidence';
                          if (row.source === 'orphan_payments') return 'Historical evidence';
                          return row.evidence_label ?? (row.evidence_status ? String(row.evidence_status) : '—');
                        })();
                        const lifecycleLabel =
                          row.session_status_display
                          ?? row.session_status_label
                          ?? row.session_status
                          ?? '—';
                        return (
                          <Fragment key={key}>
                            <TableRow>
                              <TableCell className="whitespace-nowrap text-xs">
                                {format(new Date(row.created_at), 'dd MMM HH:mm')}
                                {row.source === 'orphan_payments' && (
                                  <Badge className="ml-1" variant="outline">ORPHAN_EVIDENCE</Badge>
                                )}
                              </TableCell>
                              <TableCell className="font-mono text-[11px]">
                                {row.payment_session_id
                                  ? row.payment_session_id.slice(0, 8)
                                  : row.orphan_payment_id
                                  ? `orphan:${row.orphan_payment_id.slice(0, 8)}`
                                  : '—'}
                              </TableCell>
                              <TableCell className="font-mono text-[10px] text-muted-foreground max-w-[160px]">
                                <div>order: {row.provider_order_id ? row.provider_order_id.slice(0, 10) : '—'}</div>
                                <div>pay: {row.provider_payment_id ? row.provider_payment_id.slice(0, 10) : '—'}</div>
                                <div>cap: {row.provider_capture_id ? row.provider_capture_id.slice(0, 10) : '—'}</div>
                              </TableCell>
                              <TableCell className="text-xs">
                                {row.trip_id ? (
                                  <Link
                                    className="underline"
                                    to={tripSettlementRecoverUrl(row.trip_id, row.trip_code)}
                                  >
                                    {row.trip_code ?? row.trip_id.slice(0, 8)}
                                  </Link>
                                ) : (
                                  'No linked trip'
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                {row.customer_id ? (
                                  <Link
                                    className="underline"
                                    to={`/riders?customerId=${encodeURIComponent(row.customer_id)}`}
                                  >
                                    {row.customer_name ?? row.customer_email ?? row.customer_id.slice(0, 8)}
                                  </Link>
                                ) : (
                                  row.customer_name ?? row.customer_email ?? '—'
                                )}
                              </TableCell>
                              <TableCell className="text-xs">{row.service_area_name ?? '—'}</TableCell>
                              <TableCell className="text-xs">{row.payment_provider}</TableCell>
                              <TableCell className="text-xs">{row.payment_method ?? '—'}</TableCell>
                              <TableCell className="text-xs">{row.purpose ?? '—'}</TableCell>
                              <TableCell className="text-xs tabular-nums">
                                {formatNullablePence(row.customer_payable_pence)}
                              </TableCell>
                              <TableCell className="text-xs tabular-nums">
                                {formatNullablePence(row.buffer_pence)}
                              </TableCell>
                              <TableCell className="text-xs tabular-nums">
                                {formatNullablePence(row.authorised_amount_pence)}
                              </TableCell>
                              <TableCell className="text-xs tabular-nums">
                                {/* Money only — lifecycle / auth labels belong elsewhere. */}
                                {formatNullablePence(row.captured_amount_pence)}
                              </TableCell>
                              <TableCell className="text-xs tabular-nums">
                                {row.difference_pence == null
                                  ? '—'
                                  : formatNullablePence(row.difference_pence)}
                              </TableCell>
                              <TableCell className="text-xs">
                                {row.reconciliation_status
                                  ? row.reconciliation_status
                                  : (
                                    <Link
                                      className="underline text-muted-foreground"
                                      to={row.trip_id
                                        ? financeReconciliationTripUrl(row.trip_id, row.trip_code)
                                        : '/financial-reconciliation'}
                                    >
                                      Financial Reconciliation
                                    </Link>
                                  )}
                              </TableCell>
                              <TableCell className="text-xs tabular-nums">
                                {formatNullablePence(row.released_amount_pence)}
                              </TableCell>
                              <TableCell className="text-xs max-w-[160px] break-words">
                                {row.release_reason
                                  ?? row.hold_terminal_reason
                                  ?? row.release_failure_reason
                                  ?? '—'}
                              </TableCell>
                              <TableCell className="text-xs tabular-nums">
                                {formatNullablePence(row.refunded_amount_pence)}
                              </TableCell>
                              <TableCell className="text-xs tabular-nums">
                                {row.provider_processing_fee_pence != null
                                  && row.fee_display_badge !== 'PENDING'
                                  && row.fee_display_badge !== 'UNAVAILABLE'
                                  && row.fee_display_badge !== 'ESTIMATED'
                                  && String(row.fee_status ?? '').toUpperCase() !== 'PENDING'
                                  && String(row.fee_status ?? '').toUpperCase() !== 'UNAVAILABLE'
                                  && String(row.fee_status ?? '').toUpperCase() !== 'ESTIMATED'
                                  ? formatNullablePence(row.provider_processing_fee_pence)
                                  : '—'}
                              </TableCell>
                              <TableCell className="text-xs">
                                {row.fee_display_badge ? (
                                  <Badge variant="outline">{row.fee_display_badge}</Badge>
                                ) : (
                                  row.fee_status ?? '—'
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                <div className="font-medium">{row.provider_state ?? 'UNKNOWN'}</div>
                                {row.provider_state_label && (
                                  <div className="text-[10px] text-muted-foreground">{row.provider_state_label}</div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                <Badge
                                  variant={
                                    row.provider_verification_status === 'VERIFIED'
                                      ? 'default'
                                      : row.provider_verification_status === 'UNAVAILABLE'
                                      ? 'destructive'
                                      : 'secondary'
                                  }
                                >
                                  {verificationLabel}
                                </Badge>
                                {row.provider_state_verified_at && (
                                  <div className="mt-1 text-[10px] text-muted-foreground">
                                    {format(new Date(row.provider_state_verified_at), 'dd MMM HH:mm')}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                <div className="font-medium">{lifecycleLabel}</div>
                                {row.technical_status
                                  && row.technical_status !== row.session_status_display && (
                                  <div className="text-[10px] text-muted-foreground">
                                    tech: {row.technical_status}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                <Badge
                                  variant={
                                    row.evidence_status === 'COMPLETE'
                                      ? 'default'
                                      : row.evidence_status === 'CAPTURE_ZERO_INVALID'
                                      || row.evidence_status === 'CAPTURE_AMOUNT_MISMATCH'
                                      || row.session_status_display === 'CAPTURE_EVIDENCE_MISMATCH'
                                      ? 'destructive'
                                      : 'secondary'
                                  }
                                >
                                  {evidenceLabel}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs">{formatAgeMinutes(row.age_minutes)}</TableCell>
                              <TableCell>
                                <SessionActions
                                  row={row}
                                  actingId={actingId}
                                  inspectingId={inspectingId}
                                  onAction={runAction}
                                  onRefund={openRefundSheet}
                                  onInspect={runInspect}
                                  onRequestRecovery={runRequestRecovery}
                                  onAbandonRecovery={runAbandonRecovery}
                                  onRefreshProvider={() => {
                                    setRefreshProviderState(true);
                                    void refetch();
                                  }}
                                />

                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="mt-1"
                                  onClick={() => setExpandedId(expandedId === key ? null : key)}
                                >
                                  {expandedId === key ? 'Hide evidence' : 'Show evidence'}
                                </Button>
                              </TableCell>
                            </TableRow>
                            {expandedId === key && (
                              <TableRow>
                                <TableCell colSpan={26} className="bg-muted/40 text-xs">
                                  <div className="space-y-3">
                                    <div>
                                      <div className="mb-1 font-medium">Session evidence (audit)</div>
                                      <pre className="whitespace-pre-wrap">
                                        {JSON.stringify(
                                          {
                                            payment_session_id: row.payment_session_id,
                                            trip_id: row.trip_id,
                                            customer_payable_pence: row.customer_payable_pence,
                                            buffer_pence: row.buffer_pence,
                                            provider_order_id: row.provider_order_id,
                                            provider_payment_id: row.provider_payment_id,
                                            provider_capture_id: row.provider_capture_id,
                                            authorised_amount_pence: row.authorised_amount_pence,
                                            captured_amount_pence: row.captured_amount_pence,
                                            released_amount_pence: row.released_amount_pence,
                                            refunded_amount_pence: row.refunded_amount_pence,
                                            provider_processing_fee_pence: row.provider_processing_fee_pence,
                                            fee_status: row.fee_status,
                                            provider_state: row.provider_state,
                                            provider_verification_status: row.provider_verification_status,
                                            provider_state_verified_at: row.provider_state_verified_at,
                                            session_status_display: row.session_status_display,
                                            technical_status: row.technical_status,
                                            evidence_status: row.evidence_status,
                                            evidence_label: row.evidence_label,
                                            evidence_warnings: row.evidence_warnings,
                                            fr_reconciliation_status: row.reconciliation_status,
                                            fr_difference_pence: row.difference_pence,
                                            capture_classification_action_only: row.capture_classification,
                                            action_classification: row.action_classification,
                                            attention_class: row.attention_class,
                                            webhook_timeline: row.webhook_timeline,
                                            admin_refresh_timeline: row.admin_refresh_timeline,
                                            allowed_actions: row.allowed_actions,
                                          },
                                          null,
                                          2,
                                        )}
                                      </pre>
                                    </div>
                                    {(row.evidence_warnings?.length ?? 0) > 0 && (
                                      <div>
                                        <div className="mb-1 font-medium">Evidence warnings</div>
                                        <ul className="list-disc pl-4 text-amber-800">
                                          {row.evidence_warnings.map((w) => (
                                            <li key={w}>{w}</li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                    <div>
                                      <div className="mb-1 font-medium">Webhook timeline</div>
                                      <pre className="whitespace-pre-wrap">
                                        {JSON.stringify(row.webhook_timeline ?? [], null, 2)}
                                      </pre>
                                    </div>
                                    <div>
                                      <div className="mb-1 font-medium">Admin refresh timeline</div>
                                      <pre className="whitespace-pre-wrap">
                                        {JSON.stringify(row.admin_refresh_timeline ?? [], null, 2)}
                                      </pre>
                                    </div>
                                    <div>
                                      <div className="mb-1 font-medium">Sanitised provider snapshot</div>
                                      {inspectSnapshots[key] ? (
                                        <pre className="whitespace-pre-wrap">
                                          {JSON.stringify(inspectSnapshots[key], null, 2)}
                                        </pre>
                                      ) : (
                                        <p className="text-muted-foreground">
                                          Use Provider evidence to load a sanitised provider snapshot (no raw secrets).
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
              {(rows.length > 0) && (
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    Showing {pageStart}–{pageEnd} of {filteredTotal}
                    {filteredTotal >= 1000 ? ' (window capped at 1000 — narrow with date/customer/trip filters)' : ''}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={listOffset <= 0 || isFetching}
                      onClick={() => setListOffset((o) => Math.max(0, o - pageLimit))}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!hasMore || isFetching}
                      onClick={() => setListOffset((o) => o + pageLimit)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </div>

      <Dialog
        open={refundRow != null}
        onOpenChange={(open) => {
          if (!open && actingId == null) {
            setRefundRow(null);
            setRefundAmountInput('');
            setRefundReason('');
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Refund</DialogTitle>
            <DialogDescription>
              {refundRow?.trip_code
                ? `Enter the amount to refund for ${refundRow.trip_code}.`
                : 'Enter the amount to refund for this trip.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground space-y-0.5">
              <div>
                Captured:{' '}
                {formatNullablePence(refundRow?.captured_amount_pence ?? null)}
              </div>
              <div>
                Already refunded:{' '}
                {formatNullablePence(refundRow?.refunded_amount_pence ?? null)}
              </div>
              {refundRow?.captured_amount_pence != null && (
                <div>
                  Remaining:{' '}
                  {formatNullablePence(
                    Math.max(
                      0,
                      refundRow.captured_amount_pence
                        - (refundRow.refunded_amount_pence ?? 0),
                    ),
                  )}
                </div>
              )}
            </div>
            <div>
              <Label htmlFor="ps-refund-amount">Amount (GBP)</Label>
              <Input
                id="ps-refund-amount"
                type="number"
                step="0.01"
                min="0.01"
                inputMode="decimal"
                placeholder="0.00"
                value={refundAmountInput}
                onChange={(e) => setRefundAmountInput(e.target.value)}
                disabled={actingId != null}
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="ps-refund-reason">Reason</Label>
              <Textarea
                id="ps-refund-reason"
                rows={2}
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                disabled={actingId != null}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={actingId != null}
              onClick={() => {
                setRefundRow(null);
                setRefundAmountInput('');
                setRefundReason('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={actingId != null}
              onClick={() => void submitRefundSheet()}
            >
              {actingId != null
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : 'Confirm refund'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
