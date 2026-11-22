import { Card, CardContent } from '@/components/ui/card';
import { formatNullablePence } from '@/lib/formatNullablePence';
import type { AdminPaymentSessionsSummary } from '../../../shared/adminPaymentSessionsSSOT';

function SummaryCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | null;
}) {
  return (
    <Card>
      <CardContent className="pt-3 pb-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold tabular-nums mt-0.5">{value}</p>
        {hint ? (
          <p className="text-[10px] text-muted-foreground mt-1 leading-snug">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** PS-owned summary cards — collected money lifecycle only (never authorisations as revenue). */
export function PaymentSessionsSummaryCards({
  summary,
  currencyCode = 'GBP',
}: {
  summary: AdminPaymentSessionsSummary | null | undefined;
  currencyCode?: string;
}) {
  if (!summary) return null;
  // Never coerce null → £0 — unknown money must render as "—".
  const fmt = (p: number | null | undefined) => formatNullablePence(p, currencyCode);
  const unavailable = summary.money_totals_unavailable_reason ?? null;

  // Canonical captured field first; alias only when primary is null (not when £0).
  const capturedTotal = summary.provider_captured_total_pence
    ?? summary.total_customer_revenue_captured_pence
    ?? null;
  const releasedTotal = summary.released_buffer_total_pence ?? null;
  const expectedResidual = summary.expected_residual_release_total_pence ?? null;
  const refundedTotal = summary.refunded_total_pence ?? null;
  const feesTotal = summary.provider_fees_total_pence ?? null;

  const unavailableHint = unavailable;

  return (
    <div className="space-y-2" data-testid="payment-sessions-summary-cards">
      {unavailable ? (
        <p className="text-xs text-muted-foreground" data-testid="payment-sessions-money-unavailable">
          {unavailable}
        </p>
      ) : null}
      <div className="grid gap-2 grid-cols-2 lg:grid-cols-5">
        <SummaryCard
          label="Captured total"
          value={fmt(capturedTotal)}
          hint={unavailableHint}
        />
        <SummaryCard
          label="Released buffer total"
          value={fmt(releasedTotal)}
          hint={
            unavailableHint
              ?? (releasedTotal == null
                ? 'Confirmed residual releases only — unconfirmed amounts excluded'
                : 'Provider-confirmed residual releases')
          }
        />
        <SummaryCard
          label="Expected residual"
          value={fmt(expectedResidual)}
          hint={
            unavailableHint
              ?? 'Authorised − captured (audit). Not a confirmed release total.'
          }
        />
        <SummaryCard
          label="Refunded total"
          value={fmt(refundedTotal)}
          hint={unavailableHint}
        />
        <SummaryCard
          label="Provider fees (actual)"
          value={fmt(feesTotal)}
          hint={unavailableHint}
        />
      </div>
    </div>
  );
}
