import { Card, CardContent } from '@/components/ui/card';
import { formatNullablePence } from '@/lib/formatNullablePence';
import type { AdminPaymentSessionsSummary } from '../../../shared/adminPaymentSessionsSSOT';

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-3 pb-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold tabular-nums mt-0.5">{value}</p>
      </CardContent>
    </Card>
  );
}

/** PS-owned summary cards — customer payment lifecycle totals only. */
export function PaymentSessionsSummaryCards({
  summary,
  currencyCode = 'GBP',
}: {
  summary: AdminPaymentSessionsSummary | null | undefined;
  currencyCode?: string;
}) {
  if (!summary) return null;
  const fmt = (p: number | null | undefined) => formatNullablePence(p, currencyCode);

  const capturedTotal = summary.provider_captured_total_pence
    ?? summary.total_customer_revenue_captured_pence;
  const authorisedActive = summary.total_authorised_pence;
  const releasedTotal = summary.released_buffer_total_pence;
  const refundedTotal = summary.refunded_total_pence;
  const feesTotal = summary.provider_fees_total_pence;

  return (
    <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
      <SummaryCard label="Captured total" value={fmt(capturedTotal)} />
      <SummaryCard
        label="Authorised active total"
        value={authorisedActive != null ? fmt(authorisedActive) : String(summary.active_hold_count ?? '—')}
      />
      <SummaryCard label="Released total" value={fmt(releasedTotal)} />
      <SummaryCard label="Refunded total" value={fmt(refundedTotal)} />
      <SummaryCard label="Provider fees" value={fmt(feesTotal)} />
    </div>
  );
}
