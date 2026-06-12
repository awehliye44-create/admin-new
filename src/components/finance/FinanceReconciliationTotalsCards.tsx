import { AlertTriangle, Banknote, CheckCircle2, Clock, CreditCard, Landmark, TrendingUp, Wallet } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { FinanceSSOT, type FinancialReconciliationSSOTResult } from '@/hooks/useFinancialReconciliationSSOT';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';

function fmt(pence: number, cc: string): string {
  return `${getCurrencySymbol(cc)}${(pence / 100).toFixed(2)}`;
}

export function FinanceReconciliationTotalsCards({
  ssot,
}: {
  ssot: FinancialReconciliationSSOTResult;
}) {
  const { summary, currencyCode, badge, isLoading, error } = ssot;
  const cc = currencyCode.toLowerCase();

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} className="h-[120px] animate-pulse" />
        ))}
      </div>
    );
  }

  if (error || !summary) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>Financial Reconciliation unavailable: {error?.message ?? 'No data'}</AlertDescription>
      </Alert>
    );
  }

  const mismatch = FinanceSSOT.reconciliationStatus(summary) === 'RECONCILIATION_MISMATCH';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>Source of truth:</span>
        <FinanceSSOTBadge badge={badge} />
        <span className="text-xs">Financial Reconciliation — read-only calculations</span>
      </div>

      {mismatch && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            RECONCILIATION_MISMATCH — variance {fmt(FinanceSSOT.reconciliationVariance(summary), cc)}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Net Card Revenue</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{fmt(FinanceSSOT.netCardRevenue(summary), cc)}</div>
            <p className="text-xs text-muted-foreground">
              Card {fmt(FinanceSSOT.cardCustomerRevenue(summary), cc)} · Cash collected {fmt(FinanceSSOT.cashCollectedByDriver(summary), cc)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">ONECAB Net Commission</CardTitle>
            <TrendingUp className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-500">{fmt(FinanceSSOT.onecabNetCommission(summary), cc)}</div>
            <p className="text-xs text-muted-foreground">
              Gross {fmt(FinanceSSOT.onecabGrossCommission(summary), cc)} − fees {fmt(FinanceSSOT.providerProcessingFee(summary), cc)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Driver Available Now</CardTitle>
            <Wallet className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-500">{fmt(FinanceSSOT.driverAvailableNow(summary), cc)}</div>
            <p className="text-xs text-muted-foreground">
              Liability {fmt(FinanceSSOT.driverRemainingLiability(summary), cc)} · Paid {fmt(FinanceSSOT.driverPaidOut(summary), cc)}
            </p>
          </CardContent>
        </Card>

        <Card className="border-dashed">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Provider Available</CardTitle>
            <Landmark className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{fmt(FinanceSSOT.providerAvailableBalance(summary), cc)}</div>
            <p className="text-xs text-muted-foreground">
              Pending {fmt(FinanceSSOT.providerPendingBalance(summary), cc)} — cash position only
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Driver Money</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex justify-between"><span>Card payable</span><span>{fmt(FinanceSSOT.cardDriverPayable(summary), cc)}</span></div>
            <div className="flex justify-between"><span>Cash already received</span><span>{fmt(FinanceSSOT.cashDriverAlreadyReceived(summary), cc)}</span></div>
            <div className="flex justify-between"><span>Pending payout</span><span>{fmt(FinanceSSOT.driverPendingPayout(summary), cc)}</span></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Paid Out</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex justify-between items-center">
              <span className="flex items-center gap-1"><Banknote className="h-3 w-3" /> Driver paid out</span>
              <span>{fmt(FinanceSSOT.driverPaidOut(summary), cc)}</span>
            </div>
            <div className="flex justify-between"><span>Remaining liability</span><span>{fmt(FinanceSSOT.driverRemainingLiability(summary), cc)}</span></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Reconciliation</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {mismatch ? (
              <span className="text-destructive flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> MISMATCH</span>
            ) : (
              <span className="text-emerald-500 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> BALANCED</span>
            )}
            <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              <Clock className="h-3 w-3" /> Period {ssot.period.from.slice(0, 10)} → {ssot.period.to.slice(0, 10)}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
