import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { usePaymentHoldsReconciliation } from '@/hooks/usePaymentHoldsReconciliation';

/** Main dashboard banner — RED payment holds must be impossible to miss. */
export function PaymentHoldsDashboardAlert() {
  const { data, isLoading } = usePaymentHoldsReconciliation(true);
  const summary = data?.summary;
  const red = summary?.red ?? 0;
  const amber = summary?.amber ?? 0;

  if (isLoading || (red === 0 && amber === 0)) return null;

  return (
    <Alert variant={red > 0 ? 'destructive' : 'default'} className="mb-4">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        Payment holds requiring attention
        {red > 0 && <Badge variant="destructive">{red} RED</Badge>}
        {amber > 0 && <Badge variant="secondary">{amber} AMBER</Badge>}
      </AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2 mt-1">
        <span>
          Revolut pre-auth holds need release or recovery. Review in Financial Reconciliation immediately.
        </span>
        <Button asChild size="sm" variant={red > 0 ? 'secondary' : 'outline'}>
          <Link to="/financial-reconciliation?tab=overview">Review holds</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}
