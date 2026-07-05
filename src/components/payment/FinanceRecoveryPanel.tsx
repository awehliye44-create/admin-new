import { Link } from 'react-router-dom';
import { Calculator } from 'lucide-react';
import { PaymentControlsCard, type PaymentControlsVariant, type FinanceRecoveryAction, type InitialPaymentAction } from '@/components/payment/PaymentControlsCard';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { financeReconciliationTripUrl } from '@/lib/financialReconciliationRoutes';

export { financeReconciliationTripUrl } from '@/lib/financialReconciliationRoutes';

export type FinanceRecoverySource =
  | 'financial-reconciliation'
  | 'payments'
  | 'trip-history';

const SOURCE_LABEL: Record<FinanceRecoverySource, string> = {
  'financial-reconciliation': 'Financial Reconciliation (SSOT)',
  payments: 'Payments & Transactions (SSOT)',
  'trip-history': 'Trip History (operational)',
};

type FinanceRecoveryPanelProps = {
  tripId: string;
  tripCode?: string | null;
  source: FinanceRecoverySource;
  variant?: PaymentControlsVariant;
  initialAction?: FinanceRecoveryAction | null;
  initialPaymentAction?: InitialPaymentAction | null;
  onInitialActionConsumed?: () => void;
  onActionComplete?: () => void;
  /** When true (FR degraded mode), recovery / adjustment actions are disabled. */
  readOnly?: boolean;
};

/**
 * Financial recovery SSOT shell — all capture / recapture / waive actions route through PaymentControlsCard.
 */
export function FinanceRecoveryPanel({
  tripId,
  tripCode,
  source,
  variant = 'finance',
  initialAction = null,
  initialPaymentAction = null,
  onInitialActionConsumed,
  onActionComplete,
  readOnly = false,
}: FinanceRecoveryPanelProps) {
  const isSummary = variant === 'summary';

  if (readOnly) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Recovery actions disabled</AlertTitle>
        <AlertDescription>
          Financial Reconciliation SSOT is unavailable. Capture, refund, and adjustment actions are disabled while
          displaying a read-only cached snapshot.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {SOURCE_LABEL[source]} — trip actions are always available; enabled/disabled by payment state only.
        Mismatch indicators are warnings, not gates. Amounts validated server-side via shared admin payment APIs.
      </p>
      {isSummary && (
        <Button asChild size="sm" variant="outline" className="h-7 text-xs">
          <Link to={financeReconciliationTripUrl(tripId, tripCode)}>
            <Calculator className="h-3.5 w-3.5 mr-1" />
            Open in Financial Reconciliation
          </Link>
        </Button>
      )}
      <PaymentControlsCard
        tripId={tripId}
        variant={variant}
        initialAction={initialAction}
        initialPaymentAction={initialPaymentAction}
        onInitialActionConsumed={onInitialActionConsumed}
        onActionComplete={onActionComplete}
      />
    </div>
  );
}
