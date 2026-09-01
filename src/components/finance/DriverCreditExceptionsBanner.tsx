import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';
import { formatNullablePence } from '@/lib/formatNullablePence';

type DriverCreditExceptionsBannerProps = {
  exceptionTripCount: number;
  totalDifferencePence: number;
  currencyCode?: string;
  onFilterExceptions?: () => void;
  active?: boolean;
};

/**
 * Compact read-only alert shared across the four finance layers.
 * Click filters the current page table — never navigates away.
 */
export function DriverCreditExceptionsBanner({
  exceptionTripCount,
  totalDifferencePence,
  currencyCode = 'GBP',
  onFilterExceptions,
  active = false,
}: DriverCreditExceptionsBannerProps) {
  if (exceptionTripCount <= 0) return null;

  const diffLabel = formatNullablePence(totalDifferencePence, currencyCode);

  return (
    <Alert variant="destructive" className="py-2">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          Driver credit exceptions: {exceptionTripCount} trips · {diffLabel} difference
        </span>
        {onFilterExceptions ? (
          <Button
            type="button"
            size="sm"
            variant={active ? 'secondary' : 'outline'}
            className="h-7 text-xs"
            onClick={onFilterExceptions}
          >
            {active ? 'Showing exceptions' : 'Filter table'}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
