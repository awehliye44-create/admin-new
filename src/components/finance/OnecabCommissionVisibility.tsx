import { Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatPence } from '@/hooks/useDriverWallet';
import { FinanceSSOT } from '@/hooks/useFinancialReconciliationSSOT';
import type { FinanceReconciliationSummary } from '@/hooks/useFinanceReconciliation';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';
import { useFinanceBackendAudit } from '@/hooks/useFinanceBackendAudit';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { formatFinanceDateSafe } from '@/lib/financialReconciliationGuards';

export function OnecabCommissionVisibility({
  summary,
  currencyCode,
  filter,
  dataBadge,
}: {
  summary: FinanceReconciliationSummary | null | undefined;
  currencyCode: string;
  filter?: ServiceAreaFinanceSelection;
  dataBadge?: FinanceDataSourceBadge;
}) {
  const backendAudit = useFinanceBackendAudit({ filter, enabled: true });
  const stripePayouts = backendAudit.data?.stripe_platform_payouts;
  const audit = backendAudit.data?.finance_backend_audit_v1;

  if (!summary) return null;

  const gross = FinanceSSOT.onecabGrossCommission(summary);
  const stripeFees = FinanceSSOT.providerProcessingFee(summary);
  const net = FinanceSSOT.onecabNetCommission(summary);
  const cashDue = summary.driver_money.onecab_cash_commission_owed_pence
    ?? summary.onecab_money.onecab_cash_commission_receivable_pence
    ?? 0;
  const cashReceivable = summary.onecab_money.onecab_cash_commission_receivable_pence ?? 0;
  const cashRecovered = Math.max(0, cashReceivable - cashDue);
  const providerAvailable = summary.provider_money.provider_available_balance_pence ?? 0;
  const providerPending = summary.provider_money.provider_pending_balance_pence ?? 0;

  const stripePaidToday = stripePayouts?.paid_today_pence ?? 0;
  const stripePaidAllTime =
    stripePayouts?.paid_all_time_pence ??
    audit?.paid_out.onecab_paid_to_bank_pence ??
    0;
  const status = summary.onecab_money.onecab_commission_status ?? 'calculated_only';
  const statusLabel = summary.onecab_money.onecab_commission_status_label ?? status;

  const tripCommissionEmpty = gross === 0 && net === 0;
  const needsServiceArea = tripCommissionEmpty && dataBadge !== 'LIVE';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">ONECAB Commission & Platform Bank</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Two different money paths</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>
              <strong>Trip commission</strong> (below) is calculated from completed trips — not from your bank statement.
            </p>
            <p>
              <strong>Stripe → ONECAB bank</strong> is Stripe&apos;s automatic weekly platform payout of platform balance
              (application fees + net card revenue). That happens in Stripe even though admin &quot;commission sweep&quot; batches are not built yet.
            </p>
          </AlertDescription>
        </Alert>

        {needsServiceArea && (
          <Alert>
            <AlertTitle>Select a service area for trip commission</AlertTitle>
            <AlertDescription>
              Trip-derived commission is £0.00 because no LIVE reconciliation is loaded. Choose Milton Keynes (or your
              region) in the filter above — or open Financial Reconciliation for the full period.
            </AlertDescription>
          </Alert>
        )}

        <div>
          <p className="text-sm font-medium mb-2">Stripe platform → ONECAB business bank</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <Metric
              label="Received in bank today (Stripe)"
              value={formatPence(stripePaidToday, currencyCode)}
              highlight={stripePaidToday > 0}
            />
            <Metric
              label="Platform paid to bank (all time, Stripe)"
              value={formatPence(stripePaidAllTime, currencyCode)}
            />
            <Metric
              label="In Stripe now (available + pending)"
              value={formatPence(providerAvailable + providerPending, currencyCode)}
            />
          </div>
          {stripePayouts?.recent && stripePayouts.recent.length > 0 && (
            <div className="mt-3 rounded-md border text-xs overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left p-2 font-medium">Stripe payout ID</th>
                    <th className="text-right p-2 font-medium">Amount</th>
                    <th className="text-left p-2 font-medium">Status</th>
                    <th className="text-left p-2 font-medium">Bank arrival</th>
                  </tr>
                </thead>
                <tbody>
                  {stripePayouts.recent.slice(0, 5).map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="p-2 font-mono truncate max-w-[140px]" title={p.id}>
                        {p.id}
                      </td>
                      <td className="p-2 text-right">{formatPence(p.amount_pence, currencyCode)}</td>
                      <td className="p-2">{p.status}</td>
                      <td className="p-2 whitespace-nowrap">
                        {p.arrival_date
                          ? formatFinanceDateSafe(p.arrival_date, 'd MMM yyyy HH:mm')
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {backendAudit.isLoading && (
            <p className="text-xs text-muted-foreground mt-2">Loading Stripe platform payout proof…</p>
          )}
          {backendAudit.error && (
            <p className="text-xs text-destructive mt-2">
              Stripe payout proof unavailable: {(backendAudit.error as Error).message}
            </p>
          )}
        </div>

        <div>
          <p className="text-sm font-medium mb-2">Trip-derived commission (Financial Reconciliation SSOT)</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <Metric label="ONECAB gross commission" value={formatPence(gross, currencyCode)} />
            <Metric label="Stripe provider fees" value={formatPence(stripeFees, currencyCode)} />
            <Metric label="ONECAB net commission" value={formatPence(net, currencyCode)} highlight />
            <Metric label="Cash commission due" value={formatPence(cashDue, currencyCode)} />
            <Metric label="Cash commission recovered" value={formatPence(cashRecovered, currencyCode)} />
            <Metric
              label="Admin sweep batches (not built)"
              value={formatPence(summary.onecab_money.onecab_bank_payout_pence ?? 0, currencyCode)}
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Trip settlement status: {statusLabel}. This describes whether trip commission is verified in Stripe balance —
          not whether your bank received money today. Bank receipts come from Stripe platform payouts above.
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
      <p className={`font-semibold ${highlight ? 'text-emerald-600' : ''}`}>{value}</p>
    </div>
  );
}
