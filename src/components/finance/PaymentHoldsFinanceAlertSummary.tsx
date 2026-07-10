import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usePaymentHoldsReconciliation } from '@/hooks/usePaymentHoldsReconciliation';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';
import { formatNullablePence } from '@/lib/formatNullablePence';

/**
 * Compact finance alert summary for Financial Reconciliation.
 * Hold operations live on Payment Sessions — this is not the operational manager.
 */
export function PaymentHoldsFinanceAlertSummary() {
  const { data, isLoading, error } = usePaymentHoldsReconciliation(true);
  const summary = data?.summary;
  const red = summary?.red ?? 0;
  const amber = summary?.amber ?? 0;
  const active = summary?.active_hold_count ?? 0;
  const atRisk = summary?.active_hold_amount_pence ?? null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          Payment holds — finance alert summary
        </CardTitle>
        <CardDescription>
          Counts and money-at-risk from Payment Sessions SSOT. Manage holds on Payment Sessions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading hold summary…
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Hold summary unavailable</AlertTitle>
            <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
          </Alert>
        )}
        {!isLoading && !error && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={red > 0 ? 'destructive' : 'secondary'}>RED {red}</Badge>
            <Badge variant="secondary">AMBER {amber}</Badge>
            <Badge variant="outline">Active {active}</Badge>
            <Badge variant="outline">At risk {formatNullablePence(atRisk)}</Badge>
            <Button asChild size="sm">
              <Link to={paymentSessionsUrl({ tab: 'active_holds' })}>Open Payment Sessions</Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
