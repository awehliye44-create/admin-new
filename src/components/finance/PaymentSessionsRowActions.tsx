import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { AdminPaymentSessionsListRow } from '../../../shared/adminPaymentSessionsSSOT';
import {
  financeReconciliationTripUrl,
  tripSettlementRecoverUrl,
} from '@/lib/financialReconciliationRoutes';
import { formatNullablePence } from '@/lib/formatNullablePence';
import {
  classifyCaptureConfirmation,
  collectOutstandingActionLabel,
  sendPaymentLinkActionLabel,
} from '../../../shared/paymentSessionsCaptureConfirmationSSOT';
import { isValidConfirmedCapturePence } from '../../../shared/paymentCaptureEvidenceSSOT';

export function PaymentSessionsRowActions({
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
// alias for tests
export { PaymentSessionsRowActions as SessionActions };
