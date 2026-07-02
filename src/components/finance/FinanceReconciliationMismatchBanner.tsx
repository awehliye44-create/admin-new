import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useContinuousReconciliation } from '@/hooks/useContinuousReconciliation';
import { AlertTriangle } from 'lucide-react';
import { DriverWalletLedgerLink } from '@/components/finance/DriverWalletLedgerLink';

export function FinanceReconciliationMismatchBanner({ regionId }: { regionId?: string | null }) {
  const { data } = useContinuousReconciliation(regionId);
  if (!data?.summary) return null;

  const { mismatch = 0, local_only = 0, stripe_only = 0, pending = 0 } = data.summary;
  const totalIssues = mismatch + local_only + stripe_only;
  if (totalIssues === 0 && pending === 0) return null;

  const issueRows = (data.rows ?? []).filter(
    (r) => r.classification !== 'matched',
  ).slice(0, 5);

  return (
    <Alert variant={totalIssues > 0 ? 'destructive' : 'default'}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Reconciliation compare (ledger vs Stripe)</AlertTitle>
      <AlertDescription className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {mismatch > 0 ? <Badge variant="destructive">{mismatch} mismatch</Badge> : null}
          {local_only > 0 ? <Badge variant="secondary">{local_only} local only</Badge> : null}
          {stripe_only > 0 ? <Badge variant="secondary">{stripe_only} Stripe only</Badge> : null}
          {pending > 0 ? <Badge variant="outline">{pending} pending batch</Badge> : null}
        </div>
        <p className="text-sm">
          Not marked BALANCED when provider balance is negative, Stripe payout lacks ledger debit,
          local payout lacks Stripe evidence, or failed payout stuck processing.
        </p>
        {issueRows.length > 0 ? (
          <ul className="text-xs list-none pl-0 space-y-1">
            {issueRows.map((r) => (
              <li key={r.driver_id}>
                <DriverWalletLedgerLink driverId={r.driver_id} tab="overview">
                  {r.driver_code ?? r.driver_id.slice(0, 8)}
                </DriverWalletLedgerLink>
                {' — '}
                {r.classification}
                {r.reasons[0] ? `: ${r.reasons[0]}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
