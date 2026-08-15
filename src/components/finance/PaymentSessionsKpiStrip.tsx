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
  /** FR-owned chips — navigate to Financial Reconciliation; do not invent PS filters. */
  open_financial_reconciliation?: boolean;
};

type WidgetDef = {
  id: string;
  label: string;
  value: string;
  drill: PaymentSessionsKpiDrill;
  hint?: string;
};

/** provider-like KPI strip — values from edge summary only (no client money math). */
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
      hint: 'SUM of stamped Trip Fare final_fare_pence (not provider capture, not tips)',
    },
    {
      id: 'matched',
      label: 'Matched Trips (FR)',
      value: summary.fr_match_chips_available === false
        ? 'Open FR'
        : String(summary.matched_trips_count ?? '—'),
      drill: { tab: 'payment_matching', open_financial_reconciliation: true },
      hint: summary.fr_match_chips_message
        ?? 'FR-owned — not calculated in Payment Sessions',
    },
    {
      id: 'shortfall',
      label: 'Capture Shortfall (FR)',
      value: summary.fr_match_chips_available === false
        ? 'Open FR'
        : formatNullablePence(summary.capture_shortfall_pence, currencyCode),
      drill: { tab: 'payment_matching', open_financial_reconciliation: true },
      hint: summary.fr_match_chips_message
        ?? 'FR-owned — not calculated in Payment Sessions',
    },
    {
      id: 'gross_overcapture',
      label: 'Gross Overcapture (FR)',
      value: summary.fr_match_chips_available === false
        ? 'Open FR'
        : formatNullablePence(
          summary.gross_overcapture_pence ?? summary.overcaptured_amount_pence,
          currencyCode,
        ),
      drill: { tab: 'payment_matching', open_financial_reconciliation: true },
      hint: summary.fr_match_chips_message
        ?? 'FR-owned — open Financial Reconciliation for audit conclusion',
    },
    {
      id: 'resolved_overcapture',
      label: 'Refunded / Resolved Overcapture (FR)',
      value: summary.fr_match_chips_available === false
        ? 'Open FR'
        : formatNullablePence(summary.resolved_overcapture_pence, currencyCode),
      drill: { tab: 'payment_matching', open_financial_reconciliation: true },
      hint: 'FR-owned when persisted; PS still shows per-row refunded amounts',
    },
    {
      id: 'outstanding_overcharge',
      label: 'Outstanding Customer Overcharge (FR)',
      value: summary.fr_match_chips_available === false
        ? 'Open FR'
        : formatNullablePence(summary.outstanding_customer_overcharge_pence, currencyCode),
      drill: { tab: 'payment_matching', open_financial_reconciliation: true },
      hint: 'FR-owned when persisted',
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
      hint: 'Post-capture buffer releases only',
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
    {
      id: 'gross_onecab_commission',
      label: 'ONECAB Gross Commission (Settlement)',
      value: formatNullablePence(summary.gross_onecab_commission_pence, currencyCode),
      drill: { tab: 'completed_trips_paid' },
      hint: 'Settlement SSOT stamp SUM(commission_pence) — not provider capture',
    },
    {
      id: 'net_onecab_commission',
      label: 'ONECAB Net Commission (Settlement)',
      value: formatNullablePence(summary.net_onecab_commission_pence, currencyCode),
      drill: { tab: 'completed_trips_paid' },
      hint: 'Settlement commission − PS provider fees',
    },
    {
      id: 'driver_net_total',
      label: 'Driver Net Total (Settlement)',
      value: formatNullablePence(summary.driver_net_total_pence, currencyCode),
      drill: { tab: 'completed_trips_paid' },
      hint: 'Settlement SSOT stamp SUM(driver_net_pence)',
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
