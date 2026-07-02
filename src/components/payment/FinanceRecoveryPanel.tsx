import { Link } from 'react-router-dom';
import { Calculator } from 'lucide-react';
import { PaymentControlsCard, type PaymentControlsVariant, type FinanceRecoveryAction } from '@/components/payment/PaymentControlsCard';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

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
  onInitialActionConsumed?: () => void;
  /** When true (FR degraded mode), recovery / adjustment actions are disabled. */
  readOnly?: boolean;
};

export function financeReconciliationTripUrl(tripId: string, tripCode?: string | null): string {
  const q = tripCode?.trim()
    ? `trip=${encodeURIComponent(tripCode.trim())}&recover=1`
    : `tripId=${encodeURIComponent(tripId)}&recover=1`;
  return `/financial-reconciliation?${q}`;
}

/**
 * Financial recovery SSOT shell — all capture / recapture / waive actions route through PaymentControlsCard.
 */
export function FinanceRecoveryPanel({
  tripId,
  tripCode,
  source,
  variant = 'finance',
  initialAction = null,
  onInitialActionConsumed,
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
      {isSummary ? (
        <Alert className="border-amber-500/40 bg-amber-500/5">
          <AlertTitle className="text-sm">Capture mismatch — finance action required</AlertTitle>
          <AlertDescription className="text-xs space-y-2">
            <p>
              Money recovery (recapture, waive, internal adjustment) is owned by{' '}
              <strong>Financial Reconciliation</strong>, not Trip History alone.
            </p>
            <Button asChild size="sm" variant="default" className="mt-1">
              <Link to={financeReconciliationTripUrl(tripId, tripCode)}>
                <Calculator className="h-4 w-4 mr-1" />
                Open Financial Reconciliation
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-xs text-muted-foreground">
          {SOURCE_LABEL[source]} — recovery uses shared backend{' '}
          <code className="text-[10px]">admin-request-extra-payment</code> /{' '}
          <code className="text-[10px]">admin-edit-trip-fare</code>. Amounts are validated server-side.
        </p>
      )}
      <PaymentControlsCard
        tripId={tripId}
        variant={variant}
        initialAction={initialAction}
        onInitialActionConsumed={onInitialActionConsumed}
      />
    </div>
  );
}
