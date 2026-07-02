import { Link } from 'react-router-dom';
import { Calculator, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { financialReconciliationTripsTabUrl } from '@/lib/financialReconciliationRoutes';
import { getTripDisplayId } from '@/lib/tripUtils';

export function FinancialReconciliationTripLink({
  tripId,
  tripCode,
  tripNumber,
  className,
  variant = 'link',
}: {
  tripId: string;
  tripCode?: string | null;
  tripNumber?: string | null;
  className?: string;
  variant?: 'link' | 'button';
}) {
  const displayId = getTripDisplayId({ id: tripId, trip_code: tripCode, trip_number: tripNumber });
  const href = financialReconciliationTripsTabUrl(tripId, displayId);

  if (variant === 'button') {
    return (
      <Button asChild variant="outline" size="sm" className={className}>
        <Link to={href}>
          <Calculator className="h-3.5 w-3.5 mr-1" />
          Open in Financial Reconciliation → Trips
          <ExternalLink className="h-3 w-3 ml-1 opacity-60" />
        </Link>
      </Button>
    );
  }

  return (
    <Button asChild variant="link" size="sm" className={`h-auto p-0 text-xs font-normal ${className ?? ''}`}>
      <Link to={href}>
        <Calculator className="h-3.5 w-3.5 mr-1 inline" />
        Open in Financial Reconciliation → Trips
        <ExternalLink className="h-3 w-3 ml-1 inline opacity-60" />
      </Link>
    </Button>
  );
}
