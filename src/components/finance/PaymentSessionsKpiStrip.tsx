/**
 * @deprecated Replaced by PaymentSessionsOverviewTab (four-tab navigation).
 * Kept for import stability — drills now emit canonical four-tab URLs.
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AdminPaymentSessionsSummary } from '../../../shared/adminPaymentSessionsSSOT';
import {
  paymentSessionsNavUrl,
  type PaymentSessionsIssueChip,
  type PaymentSessionsStatusChip,
} from '../../../shared/paymentSessionsNavigationSSOT';
import { formatNullablePence } from '@/lib/formatNullablePence';

export type PaymentSessionsKpiDrill = {
  sessionFilter?: PaymentSessionsStatusChip;
  issueFilter?: PaymentSessionsIssueChip;
};

type WidgetDef = {
  id: string;
  label: string;
  value: string;
  onDrill: () => void;
  hint?: string;
};

/** @deprecated Use PaymentSessionsOverviewTab */
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
      label: 'Captured',
      value: formatNullablePence(summary.provider_captured_total_pence, currencyCode),
      onDrill: () => onDrill({ sessionFilter: 'captured' }),
      hint: 'Confirmed captures only',
    },
    {
      id: 'authorised_total',
      label: 'Authorised / held',
      value: formatNullablePence(summary.total_authorised_pence, currencyCode),
      onDrill: () => onDrill({ sessionFilter: 'authorised' }),
    },
    {
      id: 'refunded_total',
      label: 'Refunded',
      value: formatNullablePence(summary.refunded_total_pence, currencyCode),
      onDrill: () => onDrill({ sessionFilter: 'refunded' }),
    },
    {
      id: 'provider_fees',
      label: 'Provider fees',
      value: formatNullablePence(summary.provider_fees_total_pence, currencyCode),
      onDrill: () => onDrill({ issueFilter: 'provider_fee_pending' }),
    },
    {
      id: 'active',
      label: 'Active holds',
      value: String(summary.active_hold_count),
      onDrill: () => onDrill({ issueFilter: 'active_holds' }),
    },
  ];

  return (
    <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {widgets.map((w) => (
        <button key={w.id} type="button" className="text-left" onClick={w.onDrill}>
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
              ) : null}
            </CardContent>
          </Card>
        </button>
      ))}
    </div>
  );
}

export function paymentSessionsKpiDrillUrl(drill: PaymentSessionsKpiDrill): string {
  if (drill.issueFilter) {
    return paymentSessionsNavUrl({ tab: 'issues', issueFilter: drill.issueFilter });
  }
  return paymentSessionsNavUrl({
    tab: 'sessions',
    sessionFilter: drill.sessionFilter ?? 'all',
  });
}
