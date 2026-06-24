import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatPence } from '@/hooks/useDriverWallet';
import { FileEdit, MinusCircle, PlusCircle } from 'lucide-react';
import type { FinanceRecoveryAction } from '@/components/payment/PaymentControlsCard';

export type FinanceRecoveryMismatchMetrics = {
  captureMismatch: boolean;
  capturedPence: number;
  settlementTotalPence: number;
  outstandingPence: number;
  currency?: string;
};

type FinanceRecoveryMismatchSummaryProps = FinanceRecoveryMismatchMetrics & {
  compact?: boolean;
  showActions?: boolean;
  onAction?: (action: FinanceRecoveryAction) => void;
  actionsDisabled?: boolean;
};

export function FinanceRecoveryMismatchSummary({
  captureMismatch,
  capturedPence,
  settlementTotalPence,
  outstandingPence,
  currency = 'GBP',
  compact = false,
  showActions = false,
  onAction,
  actionsDisabled = false,
}: FinanceRecoveryMismatchSummaryProps) {
  const canRecover = captureMismatch && outstandingPence > 0;

  return (
    <div
      className={
        compact
          ? 'space-y-1.5 text-xs min-w-[200px]'
          : 'rounded-md border border-amber-400/60 bg-amber-500/5 p-3 space-y-3 text-sm'
      }
    >
      <div className={compact ? 'flex flex-wrap items-center gap-1' : 'flex items-center justify-between gap-2'}>
        <span className={compact ? 'text-muted-foreground' : 'font-medium'}>Capture mismatch</span>
        <Badge
          variant="outline"
          className={
            captureMismatch
              ? 'border-amber-500/50 text-amber-800 bg-amber-500/10'
              : 'border-green-500/40 text-green-700 bg-green-500/10'
          }
        >
          {captureMismatch ? 'Yes' : 'No'}
        </Badge>
      </div>

      <div className={compact ? 'grid grid-cols-1 gap-0.5' : 'grid grid-cols-2 sm:grid-cols-4 gap-2'}>
        <Metric label="Captured amount" value={capturedPence} ccy={currency} compact={compact} />
        <Metric label="Settlement total" value={settlementTotalPence} ccy={currency} compact={compact} />
        <Metric
          label="Outstanding amount"
          value={outstandingPence}
          ccy={currency}
          compact={compact}
          highlight={outstandingPence > 0}
        />
      </div>

      {showActions && canRecover && onAction && (
        <div className="flex flex-col gap-1.5 pt-1">
          <Button
            size="sm"
            className={compact ? 'h-7 text-[11px] justify-start' : ''}
            onClick={() => onAction('extra_payment')}
            disabled={actionsDisabled}
          >
            <PlusCircle className="h-3.5 w-3.5 mr-1 shrink-0" />
            Request extra payment / Recapture difference
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={compact ? 'h-7 text-[11px] justify-start' : ''}
            onClick={() => onAction('waive')}
            disabled={actionsDisabled}
          >
            <MinusCircle className="h-3.5 w-3.5 mr-1 shrink-0" />
            Waive difference
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={compact ? 'h-7 text-[11px] justify-start' : ''}
            onClick={() => onAction('internal_adjustment')}
            disabled={actionsDisabled}
          >
            <FileEdit className="h-3.5 w-3.5 mr-1 shrink-0" />
            Mark internal adjustment
          </Button>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  ccy,
  compact,
  highlight,
}: {
  label: string;
  value: number;
  ccy: string;
  compact: boolean;
  highlight?: boolean;
}) {
  if (compact) {
    return (
      <div className="flex justify-between gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span className={highlight ? 'text-amber-700 font-semibold' : 'font-medium'}>
          {formatPence(value, ccy)}
        </span>
      </div>
    );
  }
  return (
    <div className="rounded-md border bg-background/80 p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`font-semibold ${highlight ? 'text-amber-700' : ''}`}>{formatPence(value, ccy)}</div>
    </div>
  );
}
