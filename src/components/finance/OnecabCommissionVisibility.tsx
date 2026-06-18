import { Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatPence } from '@/hooks/useDriverWallet';
import { FinanceSSOT, useFinancialReconciliationSSOT } from '@/hooks/useFinancialReconciliationSSOT';
import type { FinanceReconciliationSummary } from '@/hooks/useFinanceReconciliation';

export function OnecabCommissionVisibility({
  summary,
  currencyCode,
}: {
  summary: FinanceReconciliationSummary | null | undefined;
  currencyCode: string;
}) {
  if (!summary) return null;

  const gross = FinanceSSOT.onecabGrossCommission(summary);
  const stripeFees = FinanceSSOT.providerProcessingFee(summary);
  const net = FinanceSSOT.onecabNetCommission(summary);
  const cashDue = summary.driver_money.onecab_cash_commission_owed_pence
    ?? summary.onecab_money.onecab_cash_commission_receivable_pence
    ?? 0;
  const cashReceivable = summary.onecab_money.onecab_cash_commission_receivable_pence ?? 0;
  const cashRecovered = Math.max(0, cashReceivable - cashDue);
  const bankPayout = summary.onecab_money.onecab_bank_payout_pence ?? 0;
  const status = summary.onecab_money.onecab_commission_status ?? 'calculated_only';

  const swept = bankPayout > 0 ? bankPayout : 0;
  const pending = Math.max(0, net - swept);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">ONECAB Commission</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Commission sweep not implemented yet</AlertTitle>
          <AlertDescription>
            Values below are visibility only. No automatic transfer to ONECAB bank account runs in this phase.
          </AlertDescription>
        </Alert>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <Metric label="ONECAB gross commission" value={formatPence(gross, currencyCode)} />
          <Metric label="Stripe provider fees" value={formatPence(stripeFees, currencyCode)} />
          <Metric label="ONECAB net commission" value={formatPence(net, currencyCode)} highlight />
          <Metric label="Cash commission due" value={formatPence(cashDue, currencyCode)} />
          <Metric label="Cash commission recovered" value={formatPence(cashRecovered, currencyCode)} />
          <Metric label="Commission paid / swept" value={formatPence(swept, currencyCode)} />
          <Metric label="Commission pending / unswept" value={formatPence(pending, currencyCode)} />
        </div>

        <p className="text-xs text-muted-foreground">
          Status: {summary.onecab_money.onecab_commission_status_label ?? status}
        </p>
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-semibold ${highlight ? 'text-blue-600' : ''}`}>{value}</p>
    </div>
  );
}
