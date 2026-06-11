import { AlertTriangle, Banknote, CheckCircle2, Clock, CreditCard, Info, Landmark, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getCurrencySymbol } from '@/lib/regionSettings';
import type { AdminFinanceSummary, CommissionStatus, FinanceCurrencyGroup } from '@/hooks/useAdminFinanceSummary';

function fmt(pence: number, cc: string): string {
  return `${getCurrencySymbol(cc)}${(pence / 100).toFixed(2)}`;
}

const STATUS_META: Record<CommissionStatus, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive'; className: string }> = {
  stripe_confirmed:    { label: 'Commission available in Stripe',        variant: 'default',   className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  stripe_paid_out:     { label: 'Commission paid to ONECAB bank',        variant: 'default',   className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  calculated_pending:  { label: 'Calculated commission — Stripe settlement pending', variant: 'secondary', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  legacy_fallback:     { label: 'Legacy fallback — calculated from trip commission', variant: 'outline',   className: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
};

function CardStat({
  title, value, sub, icon, tone = 'default', tooltip,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  tone?: 'default' | 'positive' | 'warning' | 'platform';
  tooltip?: string;
}) {
  const toneClass =
    tone === 'positive' ? 'text-emerald-400' :
    tone === 'warning'  ? 'text-amber-400' :
    tone === 'platform' ? 'text-slate-300' : '';
  return (
    <Card className={tone === 'platform' ? 'border-dashed border-slate-500/40 bg-slate-500/5' : undefined}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-1.5">
          {title}
          {tooltip && (
            <TooltipProvider><Tooltip><TooltipTrigger asChild><Info className="h-3 w-3 text-muted-foreground" /></TooltipTrigger>
              <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
            </Tooltip></TooltipProvider>
          )}
        </CardTitle>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${toneClass}`}>{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function GroupBlock({
  group,
  stripeBalance,
  showStripeBalance,
}: {
  group: FinanceCurrencyGroup;
  stripeBalance: AdminFinanceSummary['stripe_platform_balance'];
  showStripeBalance: boolean;
}) {
  const cc = group.currency_code;
  const t = group.totals;
  const status = STATUS_META[group.commission_status];
  const isFallback = group.commission_status === 'legacy_fallback' || group.commission_status === 'calculated_pending';

  return (
    <section className="space-y-3">
      {group.validation_warnings.map((w, i) => (
        <Alert key={i} variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{w}</AlertDescription>
        </Alert>
      ))}

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-muted-foreground tracking-wide uppercase">
          {cc} accounting
        </h3>
        <div className="flex items-center gap-2">
          <Badge className={status.className} variant={status.variant}>
            {group.commission_status === 'stripe_paid_out' ? <CheckCircle2 className="h-3 w-3 mr-1" /> : null}
            {status.label}
          </Badge>
          {isFallback && (
            <Badge variant="outline" className="border-amber-500/40 text-amber-300">Fallback</Badge>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-4">
        <CardStat
          title="Total customer revenue"
          value={fmt(t.customer_revenue_pence, cc)}
          sub="Sum of captured payments"
          icon={<CreditCard className="h-4 w-4" />}
        />
        <CardStat
          title="ONECAB gross commission"
          value={fmt(t.onecab_gross_commission_pence, cc)}
          sub="From driver_wallet_ledger"
          icon={<TrendingUp className="h-4 w-4" />}
          tone="positive"
        />
        <CardStat
          title="Stripe processing fees"
          value={fmt(t.stripe_fees_pence, cc)}
          sub="Deducted before net"
          icon={<TrendingDown className="h-4 w-4" />}
          tone="warning"
        />
        <CardStat
          title="ONECAB net after Stripe fees"
          value={fmt(t.onecab_net_commission_pence, cc)}
          sub="Gross commission − Stripe fees"
          icon={<TrendingUp className="h-4 w-4" />}
          tone="positive"
        />

        {showStripeBalance && (
          <CardStat
            title="Platform balance — not commission"
            value={
              stripeBalance.source === 'stripe_api'
                ? fmt(stripeBalance.available_pence, cc)
                : '—'
            }
            sub={
              stripeBalance.source === 'stripe_api'
                ? `Pending: ${fmt(stripeBalance.pending_pence, cc)}`
                : 'Stripe API unavailable'
            }
            icon={<Landmark className="h-4 w-4" />}
            tone="platform"
            tooltip="Stripe's account balance is unallocated cash. It is NOT ONECAB commission and must not be reported as such."
          />
        )}

        <CardStat
          title="Driver payout liability"
          value={fmt(t.driver_payout_liability_pence, cc)}
          sub="Total owed to drivers"
          icon={<Wallet className="h-4 w-4" />}
        />
        <CardStat
          title="Driver available payout"
          value={fmt(t.driver_available_payout_pence, cc)}
          sub="Net of in-flight cashouts"
          icon={<Banknote className="h-4 w-4" />}
          tone="positive"
        />
        <CardStat
          title="Driver pending payout"
          value={fmt(t.driver_pending_payout_pence, cc)}
          sub="Captured but not Stripe-available yet"
          icon={<Clock className="h-4 w-4" />}
          tone="warning"
        />
      </div>
    </section>
  );
}

export function FinanceTotalsCards({
  data,
  isLoading,
  error,
}: {
  data?: AdminFinanceSummary;
  isLoading?: boolean;
  error?: Error | null;
}) {
  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="h-[110px] animate-pulse bg-muted/30" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>Finance summary unavailable: {error.message}</AlertDescription>
      </Alert>
    );
  }
  if (!data || data.currencies.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No finance data yet.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      {data.currencies.map((g, idx) => (
        <GroupBlock
          key={g.currency_code}
          group={g}
          stripeBalance={data.stripe_platform_balance}
          showStripeBalance={idx === 0 /* show once at top */}
        />
      ))}
    </div>
  );
}
