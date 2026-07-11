import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AdminPaymentSessionsTab } from '../../shared/adminPaymentSessionsSSOT';
import type { AdminPaymentSessionsSummary } from '../../shared/adminPaymentSessionsSSOT';
import { formatNullablePence } from '@/lib/formatNullablePence';

export type PaymentSessionsKpiDrill = {
  tab: AdminPaymentSessionsTab;
  provider_fees_pending?: boolean;
  capture_failed?: boolean;
  recovery_pending?: boolean;
  release_failed?: boolean;
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
      id: 'total',
      label: 'Total Sessions',
      value: String(summary.total),
      drill: { tab: 'history' },
    },
    {
      id: 'captured',
      label: 'Captured Payments',
      value: String(summary.captured_count),
      drill: { tab: 'captured' },
    },
    {
      id: 'active',
      label: 'Active Holds',
      value: String(summary.active_hold_count),
      drill: { tab: 'active_holds' },
    },
    {
      id: 'released',
      label: 'Released Holds',
      value: String(summary.released_count),
      drill: { tab: 'released' },
    },
    {
      id: 'refunded',
      label: 'Refunded',
      value: String(summary.refunded_count),
      drill: { tab: 'refunded' },
    },
    {
      id: 'recovery',
      label: 'Recovery Pending',
      value: String(summary.recovery_pending_count ?? summary.failed_recovery_count),
      drill: { tab: 'failed_recovery', recovery_pending: true },
    },
    {
      id: 'fees_pending',
      label: 'Provider Fees Pending',
      value: String(summary.provider_fees_pending_count ?? 0),
      drill: { tab: 'history', provider_fees_pending: true },
      hint: 'Fee status PENDING only',
    },
    {
      id: 'revenue',
      label: 'Total Customer Revenue Captured',
      value: formatNullablePence(summary.total_customer_revenue_captured_pence, currencyCode),
      drill: { tab: 'captured' },
      hint: 'SUM(confirmed captures) only',
    },
    {
      id: 'authorised',
      label: 'Total Authorised',
      value: formatNullablePence(summary.total_authorised_pence, currencyCode),
      drill: { tab: 'active_holds' },
      hint: 'Active holds only',
    },
    {
      id: 'success',
      label: 'Capture Success Rate',
      value: summary.capture_success_rate_pct == null
        ? '—'
        : `${summary.capture_success_rate_pct}%`,
      drill: { tab: 'history', capture_failed: true },
      hint: 'Drill shows capture failures / missing amounts',
    },
    {
      id: 'risk',
      label: 'Money At Risk',
      value: formatNullablePence(summary.money_at_risk_pence, currencyCode),
      drill: { tab: 'active_holds' },
      hint: 'Non-green active authorisations',
    },
  ];

  return (
    <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
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
