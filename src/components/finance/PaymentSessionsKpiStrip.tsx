import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AdminPaymentSessionsTab } from '../../../shared/adminPaymentSessionsSSOT';
import type { AdminPaymentSessionsSummary } from '../../../shared/adminPaymentSessionsSSOT';
import type { PaymentTripMatchStatus } from '../../../shared/paymentSessionsTripMatchSSOT';
import { formatNullablePence } from '@/lib/formatNullablePence';

export type PaymentSessionsKpiDrill = {
  tab: AdminPaymentSessionsTab;
  provider_fees_pending?: boolean;
  capture_failed?: boolean;
  recovery_pending?: boolean;
  release_failed?: boolean;
  money_at_risk?: boolean;
  match_status?: PaymentTripMatchStatus;
};

type WidgetDef = {
  id: string;
  label: string;
  value: string;
  drill: PaymentSessionsKpiDrill;
  hint?: string;
};

/** Stripe-like KPI strip — values from edge summary only (no client money math). */
export function PaymentSessionsKpiStrip({
  summary,
  currencyCode = 'GBP',
  onDrill,
}: {
  summary: AdminPaymentSessionsSummary | null | undefined;
  currencyCode?: string;
  onDrill: (drill: PaymentSessionsKpiDrill) => void;
}) {
  if (!summary) return null;

  const widgets: WidgetDef[] = [
    {
      id: 'provider_captured',
      label: 'Provider Captured Total',
      value: formatNullablePence(summary.provider_captured_total_pence, currencyCode),
      drill: { tab: 'provider_payments' },
      hint: 'Confirmed captures only',
    },
    {
      id: 'trip_fare_total',
      label: 'Completed Trip Fare Total',
      value: formatNullablePence(summary.completed_trip_fare_total_pence, currencyCode),
      drill: { tab: 'completed_trips_paid' },
    },
    {
      id: 'matched',
      label: 'Matched Trips',
      value: String(summary.matched_trips_count ?? 0),
      drill: { tab: 'payment_matching', match_status: 'MATCHED' },
    },
    {
      id: 'shortfall',
      label: 'Capture Shortfall',
      value: formatNullablePence(summary.capture_shortfall_pence, currencyCode),
      drill: { tab: 'payment_matching', match_status: 'CAPTURE_SHORTFALL' },
    },
    {
      id: 'overcapture',
      label: 'Overcaptured Amount',
      value: formatNullablePence(summary.overcaptured_amount_pence, currencyCode),
      drill: { tab: 'payment_matching', match_status: 'OVERCAPTURE' },
    },
    {
      id: 'missing_sessions',
      label: 'Missing Payment Sessions',
      value: String(summary.missing_payment_sessions_count ?? 0),
      drill: { tab: 'payment_matching', match_status: 'NO_PAYMENT_SESSION' },
    },
    {
      id: 'active',
      label: 'Active Holds',
      value: String(summary.active_hold_count),
      drill: { tab: 'active_holds' },
    },
    {
      id: 'released_buffer',
      label: 'Released Buffer Total',
      value: formatNullablePence(summary.released_buffer_total_pence, currencyCode),
      drill: { tab: 'released' },
    },
    {
      id: 'refunded_total',
      label: 'Refunded Total',
      value: formatNullablePence(summary.refunded_total_pence, currencyCode),
      drill: { tab: 'refunded' },
    },
    {
      id: 'provider_fees',
      label: 'Provider Fees',
      value: formatNullablePence(summary.provider_fees_total_pence, currencyCode),
      drill: { tab: 'provider_payments' },
      hint: 'ACTUAL fees only',
    },
  ];

  return (
    <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {widgets.map((w) => (
        <button
          key={w.id}
          type="button"
          className="text-left"
          onClick={() => onDrill(w.drill)}
        >
          <Card className="h-full transition-colors hover:border-foreground/30 hover:bg-muted/40">
            <CardHeader className="pb-1 pt-3 px-3">
              <CardTitle className="text-[11px] font-medium text-muted-foreground tracking-wide uppercase">
                {w.label}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <p className="text-lg font-semibold tabular-nums">{w.value}</p>
              {w.hint ? (
                <p className="text-[10px] text-muted-foreground mt-0.5">{w.hint}</p>
              ) : (
                <p className="text-[10px] text-muted-foreground mt-0.5">Click to filter</p>
              )}
            </CardContent>
          </Card>
        </button>
      ))}
    </div>
  );
}
