import { AlertTriangle } from 'lucide-react';
import { FinancialReconciliationTripLink } from '@/components/finance/FinancialReconciliationTripLink';
import { Label } from '@/components/ui/label';
import type { TripHistoryTerminalOutcomeDisplay } from '../../../shared/tripHistoryTerminalOutcomeDisplaySSOT';

type Props = {
  display: TripHistoryTerminalOutcomeDisplay;
  currencySymbol: string;
  tripId: string;
  tripCode?: string | null;
  tripNumber?: string | null;
};

export function TripHistoryTerminalOutcomePanel({
  display,
  currencySymbol,
  tripId,
  tripCode,
  tripNumber,
}: Props) {
  const fmt = (pence: number | null | undefined) => {
    if (pence == null) return '—';
    return `${currencySymbol}${(pence / 100).toFixed(2)}`;
  };

  return (
    <div className="col-span-2 rounded-md border border-amber-400/50 bg-amber-500/5 p-3 space-y-3">
      <div>
        <p className="text-sm font-semibold">Payment outcome</p>
        <p className="text-xs text-muted-foreground">
          Terminal fee settlement — not normal ride commission.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">{display.customer_charge_label}</Label>
          <p className="font-medium">{fmt(display.customer_charge_pence)}</p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Provider fee</Label>
          <p className="font-medium">{fmt(display.provider_fee_pence)}</p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Driver entitlement</Label>
          <p className={`font-medium ${display.entitlement_pending ? 'text-amber-700' : ''}`}>
            {display.entitlement_pending ? 'Pending verification' : fmt(display.driver_entitlement_pence)}
          </p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">ONECAB commission</Label>
          <p className="font-medium">{fmt(display.onecab_commission_pence)}</p>
        </div>
      </div>
      {display.original_quote_pence != null && (
        <div>
          <Label className="text-xs text-muted-foreground">Original quote (not charged)</Label>
          <p className="font-medium text-muted-foreground">{fmt(display.original_quote_pence)}</p>
        </div>
      )}
      {display.entitlement_pending && (
        <div className="flex flex-col gap-2 text-xs text-amber-800">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{display.entitlement_pending_message ?? 'Driver entitlement pending verification'}</span>
          </div>
          <FinancialReconciliationTripLink
            tripId={tripId}
            tripCode={tripCode}
            tripNumber={tripNumber}
            variant="button"
          />
        </div>
      )}
    </div>
  );
}
