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
  formatCapturedAmountDisplay,
  formatReleasedAmountDisplay,
  formatPaymentSessionsEvidenceStatus,
} from '../../shared/paymentSessionsDisplaySSOT';
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
import { PaymentSessionsCompletedTripsTable } from '@/components/finance/PaymentSessionsCompletedTripsTable';
import { PaymentSessionsMatchingTable } from '@/components/finance/PaymentSessionsMatchingTable';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import type { PaymentTripMatchStatus } from '../../shared/paymentSessionsTripMatchSSOT';


const TABS: Array<{ id: AdminPaymentSessionsTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'provider_payments', label: 'Provider Payments' },
  { id: 'completed_trips_paid', label: 'Completed Trips Paid' },
  { id: 'payment_matching', label: 'Payment Matching' },
  { id: 'active_holds', label: 'Active Holds' },
  { id: 'captured', label: 'Captured — Provider Confirmed' },
  { id: 'released', label: 'Released' },
  { id: 'refunded', label: 'Refunds' },
  { id: 'failed_recovery', label: 'Recovery' },
  { id: 'history', label: 'History' },
];

const PURPOSES: PaymentSessionPurpose[] = [
  'RIDE_BOOKING',
  'SAVE_CARD',
  'PAYMENT_RECOVERY',
  'LEGACY_EVIDENCE',
];

type TriState = 'all' | 'true' | 'false';

function parseTab(raw: string | null): AdminPaymentSessionsTab {
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
  const canRefund = allowedDefined && allowedActions.has('refund_difference');
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
    || (captureFullyConfirmed && !offerCollectOutstanding && !canRefund);
  return (
    <div className="flex flex-wrap gap-1">
      {row.customer_id && (
        <Button asChild size="sm" variant="outline">
          <Link to={`/riders?customerId=${encodeURIComponent(row.customer_id)}`}>
            Customer
          </Link>
        </Button>
      )}
      {row.trip_id && policy.can_open_trip !== false && (
        <Button asChild size="sm" variant="outline">
          <Link to={tripSettlementRecoverUrl(row.trip_id, row.trip_code)}>Open completed trip</Link>
        </Button>
      )}
      {policy.can_open_reconciliation && row.trip_id && (
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
          disabled={busy || !row.provider_order_id}
          onClick={() => onRefund(row)}
        >
          {busy
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : captureConfirmation.classification === 'OVERCAPTURED_REFUND_REQUIRED'
              && captureConfirmation.difference_pence != null
              && captureConfirmation.difference_pence > 0
              ? `Refund Difference £${(captureConfirmation.difference_pence / 100).toFixed(2)}`
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
  const [moneyAtRisk, setMoneyAtRisk] = useState(searchParams.get('moneyAtRisk') === '1');
  const [matchStatus, setMatchStatus] = useState<PaymentTripMatchStatus | ''>(
    (searchParams.get('matchStatus') as PaymentTripMatchStatus | null) ?? '',
  );
  const [legacyEvidence, setLegacyEvidence] = useState(false);
  const [refreshProviderState, setRefreshProviderState] = useState(false);
  const [listOffset, setListOffset] = useState(0);

  const [actingId, setActingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [inspectSnapshots, setInspectSnapshots] = useState<Record<string, Record<string, unknown>>>({});
  const [inspectingId, setInspectingId] = useState<string | null>(null);

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
    moneyAtRisk,
    matchStatus,
    legacyEvidence,
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
      money_at_risk: moneyAtRisk ? true : null,
      match_status: matchStatus || null,
      legacy_evidence: legacyEvidence ? true : null,
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
      moneyAtRisk,
      matchStatus,
      legacyEvidence,
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
    setMoneyAtRisk(Boolean(drill.money_at_risk));
    setMatchStatus(drill.match_status ?? '');
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
    if (drill.money_at_risk) params.set('moneyAtRisk', '1');
    else params.delete('moneyAtRisk');
    if (drill.match_status) params.set('matchStatus', drill.match_status);
    else params.delete('matchStatus');
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
    setMoneyAtRisk(false);
    setMatchStatus('');
    setLegacyEvidence(false);
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
    || captureFailed
    || moneyAtRisk
    || !!matchStatus
    || legacyEvidence;

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
        const msg = err instanceof Error ? err.message : String(err);
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

  const runRefund = useCallback(
    async (row: AdminPaymentSessionsListRow) => {
      if (!row.provider_order_id) {
        toast.error('Missing provider order id');
        return;
      }
      const actionKey = row.provider_order_id || row.payment_session_id || row.id;
      setActingId(actionKey);
      try {
        await refundAction.mutateAsync({ providerOrderId: row.provider_order_id });
        toast.success('Refund requested');
        await refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Refund failed');
      } finally {
        setActingId(null);
      }
    },
    [refundAction, refetch],
  );

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
      const outstanding = confirmation.outstanding_pence;
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
  const completedTripRows = data?.completed_trip_rows ?? [];
  const matchingRows = data?.matching_rows ?? [];
  const summary = data?.summary;
  const filteredTotal = data?.filtered_total
    ?? (tab === 'completed_trips_paid'
      ? completedTripRows.length
      : tab === 'payment_matching'
      ? matchingRows.length
      : rows.length);
  const hasMore = Boolean(data?.has_more);
  const pageStart = filteredTotal === 0 ? 0 : listOffset + 1;
  const pageEnd = listOffset + (
    tab === 'completed_trips_paid'
      ? completedTripRows.length
      : tab === 'payment_matching'
      ? matchingRows.length
      : rows.length
  );

  return (
    <AdminLayout title="Payment Sessions (SSOT)">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              ONECAB Payments — canonical source for every customer payment lifecycle.
              Financial Reconciliation audits these values; it never invents them.
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
                  <Badge variant="outline">
                    Historical Evidence: {summary.historical_evidence_count ?? 0}
                  </Badge>
                  <Badge variant="outline">Active holds: {summary.active_hold_count}</Badge>
                  <Badge variant="destructive">
                    RED: {summary.active_action_required_count ?? summary.red}
                  </Badge>
                  <Badge variant="secondary">
                    At risk: {formatNullablePence(summary.money_at_risk_pence)}
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
                <SelectItem value="stripe">stripe — archived legacy</SelectItem>
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
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={moneyAtRisk} onCheckedChange={(v) => setMoneyAtRisk(v === true)} />
              money_at_risk
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={legacyEvidence} onCheckedChange={(v) => setLegacyEvidence(v === true)} />
              legacy_evidence
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
                  Payment Sessions are the customer payment source of truth. Provider Payments owns provider amounts;
                  Completed Trips Paid shows backend fares; Payment Matching compares them.
                  Financial Reconciliation audits these values — it never invents payment amounts.
                </p>
              )}
              {t.id === 'provider_payments' && (
                <p className="text-sm text-muted-foreground">
                  Authoritative provider lifecycle. Never shows trip fare or authorised amount as captured.
                </p>
              )}
              {t.id === 'completed_trips_paid' && (
                <p className="text-sm text-muted-foreground">
                  Completed ONECAB trips with canonical final fares from trip settlement fields.
                  Does not own provider payment state.
                </p>
              )}
              {t.id === 'payment_matching' && (
                <p className="text-sm text-muted-foreground">
                  Comparison only: expected capture (trip final fare) vs provider-confirmed capture.
                </p>
              )}
              {t.id === 'captured' && (
                <p className="text-sm text-muted-foreground">
                  Confirmed provider-captured payments only (amount present). Authorisations are excluded.
                  Healthy captures show CAPTURED — CONFIRMED; manual review is for unresolved contradictions only.
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
              ) : t.id === 'completed_trips_paid' ? (
                <PaymentSessionsCompletedTripsTable
                  rows={completedTripRows}
                  currencyCode={serviceFilter.currencyCode ?? 'GBP'}
                />
              ) : t.id === 'payment_matching' ? (
                <PaymentSessionsMatchingTable
                  rows={matchingRows}
                  currencyCode={serviceFilter.currencyCode ?? 'GBP'}
                  onInspectProvider={(orderId) => {
                    void (async () => {
                      setInspectingId(orderId);
                      try {
                        const snap = await inspectProvider.mutateAsync(orderId);
                        setInspectSnapshots((prev) => ({ ...prev, [orderId]: snap }));
                        toast.success('Provider evidence loaded');
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : 'Inspect failed');
                      } finally {
                        setInspectingId(null);
                      }
                    })();
                  }}
                />
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
                        const captureConfirmation = classifyCaptureConfirmation({
                          providerState: row.provider_state,
                          providerCapturedPence: row.captured_amount_pence,
                          localCapturedPence: row.captured_amount_pence,
                          canonicalPayablePence: row.customer_payable_pence,
                          authorisedPence: row.authorised_amount_pence,
                          purpose: row.purpose,
                        });
                        const captureConfirmed =
                          captureConfirmation.classification === 'CAPTURED_CONFIRMED'
                          && isValidConfirmedCapturePence(row.captured_amount_pence);
                        const expectedResidualRelease =
                          row.authorised_amount_pence != null
                          && row.captured_amount_pence != null
                          && Number(row.authorised_amount_pence) > Number(row.captured_amount_pence)
                            ? Math.round(Number(row.authorised_amount_pence) - Number(row.captured_amount_pence))
                            : null;
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
                                {row.refunded_amount_pence != null && (
                                  <div>refund: {formatNullablePence(row.refunded_amount_pence)}</div>
                                )}
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
                                  'No trip'
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
                              <TableCell className="text-xs">
                                {formatNullablePence(row.customer_payable_pence)}
                              </TableCell>
                              <TableCell className="text-xs">
                                {formatNullablePence(row.buffer_pence)}
                              </TableCell>
                              <TableCell className="text-xs">
                                {formatNullablePence(row.authorised_amount_pence)}
                              </TableCell>
                              <TableCell className="text-xs">
                                <span
                                  className={
                                    formatCapturedAmountDisplay({
                                      captured_amount_pence: row.captured_amount_pence,
                                      currencyFormatter: () => '',
                                    }) === 'Not recorded locally'
                                      ? 'text-amber-800'
                                      : undefined
                                  }
                                >
                                  {formatCapturedAmountDisplay({
                                    captured_amount_pence: row.captured_amount_pence,
                                    currencyFormatter: (p) => formatNullablePence(p),
                                  })}
                                </span>
                                {row.captured_at && Number(row.captured_amount_pence) > 0 && (
                                  <div className="mt-1 text-[10px] text-muted-foreground">
                                    {format(new Date(row.captured_at), 'dd MMM HH:mm')}
                                  </div>
                                )}
                                {captureConfirmed && (
                                  <div className="mt-1 text-[10px] text-emerald-700">
                                    CAPTURED — CONFIRMED ✓
                                  </div>
                                )}
                                {!captureConfirmed && captureConfirmation.label && (
                                  <div className="mt-1 text-[10px] text-amber-700">
                                    {captureConfirmation.label}
                                  </div>
                                )}
                                {(row.evidence_status === 'CAPTURE_ZERO_INVALID'
                                  || row.evidence_status === 'CAPTURE_AMOUNT_MISSING'
                                  || row.evidence_status === 'CAPTURE_AMOUNT_MISMATCH') && (
                                  <div className="mt-1 text-[10px] text-amber-700">{row.evidence_label ?? row.evidence_status}</div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                {captureConfirmation.difference_pence == null
                                  ? '—'
                                  : formatNullablePence(captureConfirmation.difference_pence)}
                                {captureConfirmed && (
                                  <div className="mt-1 text-[10px] text-muted-foreground">No action required</div>
                                )}
                                {captureConfirmation.classification === 'UNDERCAPTURED_RECOVERY_REQUIRED'
                                  && captureConfirmation.outstanding_pence != null && (
                                  <div className="mt-1 text-[10px] text-amber-700">
                                    Outstanding {formatNullablePence(captureConfirmation.outstanding_pence)}
                                  </div>
                                )}
                                {captureConfirmation.classification === 'OVERCAPTURED_REFUND_REQUIRED'
                                  && captureConfirmation.difference_pence != null && (
                                  <div className="mt-1 text-[10px] text-amber-700">
                                    Overcharged {formatNullablePence(captureConfirmation.difference_pence)}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                <div className="font-medium">
                                  {row.action_classification_label
                                    ?? row.capture_classification_label
                                    ?? captureConfirmation.label
                                    ?? row.reconciliation_status
                                    ?? '—'}
                                </div>
                                {captureConfirmation.manual_review_reason && (
                                  <div className="mt-1 text-[10px] text-amber-700">
                                    {captureConfirmation.manual_review_reason}
                                  </div>
                                )}
                                {row.provider_state_verified_at && (
                                  <div className="mt-1 text-[10px] text-muted-foreground">
                                    Last verified {format(new Date(row.provider_state_verified_at), 'dd MMM HH:mm')}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                {(() => {
                                  const released = formatReleasedAmountDisplay({
                                    released_amount_pence: row.released_amount_pence,
                                    released_at: row.released_at,
                                    release_evidence_status: row.release_evidence_status,
                                    currencyFormatter: (p) => formatNullablePence(p),
                                    captureConfirmed,
                                    providerState: row.provider_state,
                                    capturedAmountPence: row.captured_amount_pence,
                                    expectedReleasePence: expectedResidualRelease,
                                  });
                                  const showManualReview = released.primary === 'MANUAL_REVIEW_REQUIRED';
                                  return (
                                    <>
                                      <span className={showManualReview ? 'text-amber-800' : undefined}>
                                        {released.primary}
                                      </span>
                                      {released.secondary && (
                                        <div className="mt-1 text-[10px] text-muted-foreground">
                                          {released.secondary}
                                        </div>
                                      )}
                                    </>
                                  );
                                })()}
                                {row.released_at && (
                                  <div className="mt-1 text-[10px] text-muted-foreground">
                                    {format(new Date(row.released_at), 'dd MMM HH:mm')}
                                  </div>
                                )}
                                {row.provider_verification_status
                                  && (row.released_at || tab === 'released')
                                  && !(captureConfirmed && row.provider_verification_status === 'STALE')
                                  && (
                                  <div className="mt-1 text-[10px] text-muted-foreground">
                                    {row.provider_verification_status === 'STALE'
                                      ? 'Provider reconciliation pending'
                                      : `Provider: ${row.provider_verification_status}`}
                                  </div>
                                )}
                                {captureConfirmed && row.provider_state_verified_at && (
                                  <div className="mt-1 text-[10px] text-muted-foreground">
                                    Last verified {format(new Date(row.provider_state_verified_at), 'dd MMM HH:mm')}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs max-w-[160px] break-words">
                                {row.release_reason
                                  ?? row.hold_terminal_reason
                                  ?? row.release_failure_reason
                                  ?? '—'}
                              </TableCell>
                              <TableCell className="text-xs">
                                {formatNullablePence(row.refunded_amount_pence)}
                                {row.refunded_at && (
                                  <div className="mt-1 text-[10px] text-muted-foreground">
                                    {format(new Date(row.refunded_at), 'dd MMM HH:mm')}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                {row.fee_display_badge === 'UNAVAILABLE'
                                  ? (row.fee_display_label ?? 'Fee unavailable')
                                  : row.fee_display_badge === 'PENDING'
                                    || row.provider_processing_fee_pence == null
                                  ? (row.fee_display_label ?? 'Pending provider fee')
                                  : formatNullablePence(row.provider_processing_fee_pence)}
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
                                      || (captureConfirmed && row.provider_verification_status === 'STALE')
                                      ? 'default'
                                      : row.provider_verification_status === 'UNAVAILABLE'
                                      ? 'destructive'
                                      : 'secondary'
                                  }
                                >
                                  {captureConfirmed && row.provider_verification_status === 'STALE'
                                    ? 'VERIFIED (cached)'
                                    : (row.provider_verification_status ?? 'UNKNOWN')}
                                </Badge>
                                {row.provider_state_verified_at && (
                                  <div className="mt-1 text-[10px] text-muted-foreground">
                                    {format(new Date(row.provider_state_verified_at), 'dd MMM HH:mm')}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                <div className="font-medium">
                                  {row.action_classification_label
                                    ?? (row.session_status_label
                                      && !/incomplete/i.test(row.session_status_label)
                                      ? row.session_status_label
                                      : null)
                                    ?? row.session_status
                                    ?? '—'}
                                </div>
                                {row.technical_status && row.technical_status !== row.session_status_display && (
                                  <div className="text-[10px] text-muted-foreground">tech: {row.technical_status}</div>
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
                                      : row.evidence_status === 'CAPTURE_AMOUNT_MISSING'
                                      || row.evidence_status === 'INCOMPLETE'
                                      || row.evidence_status === 'LOCAL_BACKFILL_REQUIRED'
                                      ? 'secondary'
                                      : 'outline'
                                  }
                                >
                                  {formatPaymentSessionsEvidenceStatus(
                                    row.evidence_status,
                                    row.evidence_label,
                                  )}
                                </Badge>
                                {row.evidence_label
                                  && row.evidence_status !== 'COMPLETE'
                                  && !/incomplete/i.test(row.evidence_label) && (
                                  <div className="mt-1 text-[10px] text-muted-foreground">{row.evidence_label}</div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">{formatAgeMinutes(row.age_minutes)}</TableCell>
                              <TableCell>
                                <SessionActions
                                  row={row}
                                  actingId={actingId}
                                  inspectingId={inspectingId}
                                  onAction={runAction}
                                  onRefund={runRefund}
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
                                      <div className="mb-1 font-medium">Session evidence</div>
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
                                            capture_confirmation: captureConfirmation,
                                            difference_pence: captureConfirmation.difference_pence,
                                            released_amount_pence: row.released_amount_pence,
                                            release_evidence_status: row.release_evidence_status,
                                            release_evidence_source: row.release_evidence_source,
                                            release_display: formatReleasedAmountDisplay({
                                              released_amount_pence: row.released_amount_pence,
                                              released_at: row.released_at,
                                              release_evidence_status: row.release_evidence_status,
                                              currencyFormatter: (p) => formatNullablePence(p),
                                              captureConfirmed,
                                              providerState: row.provider_state,
                                              capturedAmountPence: row.captured_amount_pence,
                                              expectedReleasePence: expectedResidualRelease,
                                            }),
                                            refunded_amount_pence: row.refunded_amount_pence,
                                            provider_processing_fee_pence: row.provider_processing_fee_pence,
                                            fee_status: row.fee_status,
                                            provider_state: row.provider_state,
                                            provider_state_verified_at: row.provider_state_verified_at,
                                            session_status_canonical: row.session_status_display,
                                            'Technical status': row.technical_status,
                                            captured_at: row.captured_at,
                                            released_at: row.released_at,
                                            refunded_at: row.refunded_at,
                                            evidence_status: row.evidence_status,
                                            evidence_label: row.evidence_label,
                                            evidence_warnings: row.evidence_warnings,
                                            reconciliation_status: row.reconciliation_status,
                                            attention_class: row.attention_class,
                                            webhook_timeline: row.webhook_timeline,
                                            admin_refresh_timeline: row.admin_refresh_timeline,
                                            action_policy: row.action_policy,
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
              {(rows.length > 0 || completedTripRows.length > 0 || matchingRows.length > 0) && (
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
    </AdminLayout>
  );
}
