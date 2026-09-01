import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { formatNullablePence } from '@/lib/formatNullablePence';
import type { AdminPaymentSessionsSummary } from '../../../shared/adminPaymentSessionsSSOT';
import {
  countOpenPaymentSessionIssues,
  paymentSessionsNavUrl,
  type PaymentSessionsIssueChip,
  type PaymentSessionsStatusChip,
} from '../../../shared/paymentSessionsNavigationSSOT';

type PaymentSessionsOverviewTabProps = {
  summary: AdminPaymentSessionsSummary | null | undefined;
  currencyCode?: string;
  onNavigateSessions: (chip: PaymentSessionsStatusChip) => void;
  onNavigateIssues: (chip: PaymentSessionsIssueChip) => void;
};

function OverviewCard({
  label,
  value,
  subtitle,
  onClick,
}: {
  label: string;
  value: string;
  subtitle?: string;
  onClick?: () => void;
}) {
  const inner = (
    <Card className={onClick ? 'h-full transition-colors hover:border-foreground/30 hover:bg-muted/40 cursor-pointer' : 'h-full'}>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold mt-1 tabular-nums">{value}</p>
        {subtitle ? <p className="text-[11px] text-muted-foreground mt-1">{subtitle}</p> : null}
      </CardContent>
    </Card>
  );
  if (!onClick) return inner;
  return (
    <button type="button" className="text-left w-full" onClick={onClick}>
      {inner}
    </button>
  );
}

/** Overview — at most five PS-owned summary cards (no dash-only placeholders). */
export function PaymentSessionsOverviewTab({
  summary,
  currencyCode = 'GBP',
  onNavigateSessions,
  onNavigateIssues,
}: PaymentSessionsOverviewTabProps) {
  if (!summary) return null;

  const capturedTotal = summary.provider_captured_total_pence
    ?? summary.total_customer_revenue_captured_pence;
  const authorisedTotal = summary.total_authorised_pence;
  const refundedTotal = summary.refunded_total_pence;
  const feesTotal = summary.provider_fees_total_pence;
  const openIssues = countOpenPaymentSessionIssues(summary);

  const cards: Array<{
    key: string;
    label: string;
    value: string;
    subtitle?: string;
    onClick?: () => void;
  }> = [];

  if (capturedTotal != null) {
    cards.push({
      key: 'captured',
      label: 'Captured',
      value: formatNullablePence(capturedTotal, currencyCode),
      subtitle: summary.captured_count > 0 ? `${summary.captured_count} sessions` : undefined,
      onClick: () => onNavigateSessions('captured'),
    });
  }

  if (authorisedTotal != null || summary.active_hold_count > 0) {
    cards.push({
      key: 'authorised',
      label: 'Authorised / held',
      value: authorisedTotal != null
        ? formatNullablePence(authorisedTotal, currencyCode)
        : String(summary.active_hold_count),
      subtitle: summary.active_hold_count > 0
        ? `${summary.active_hold_count} active holds`
        : undefined,
      onClick: () => onNavigateSessions('authorised'),
    });
  }

  if (refundedTotal != null) {
    cards.push({
      key: 'refunded',
      label: 'Refunded',
      value: formatNullablePence(refundedTotal, currencyCode),
      subtitle: summary.refunded_count > 0 ? `${summary.refunded_count} sessions` : undefined,
      onClick: () => onNavigateSessions('refunded'),
    });
  }

  if (feesTotal != null) {
    cards.push({
      key: 'fees',
      label: 'Provider fees',
      value: formatNullablePence(feesTotal, currencyCode),
      subtitle: (summary.provider_fees_pending_count ?? 0) > 0
        ? `${summary.provider_fees_pending_count} pending`
        : 'ACTUAL provider fees',
      onClick: () => onNavigateIssues('provider_fee_pending'),
    });
  }

  if (openIssues > 0) {
    cards.push({
      key: 'issues',
      label: 'Open issues',
      value: String(openIssues),
      subtitle: 'Needs attention on Issues tab',
      onClick: () => onNavigateIssues('all'),
    });
  }

  if (cards.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No summary totals in the current filter window. Adjust date or service area, or open{' '}
        <Link className="underline" to={paymentSessionsNavUrl({ tab: 'sessions' })}>Sessions</Link>.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Payment Sessions owns customer payment lifecycle. Trip settlement and wallet reconciliation live on{' '}
        <Link className="underline" to="/financial-reconciliation">Financial Reconciliation</Link>.
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {cards.map((c) => (
          <OverviewCard
            key={c.key}
            label={c.label}
            value={c.value}
            subtitle={c.subtitle}
            onClick={c.onClick}
          />
        ))}
      </div>
    </div>
  );
}
