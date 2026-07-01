import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { formatPence } from '@/hooks/useDriverWallet';
import type { LegacyManualReviewItem } from '@/hooks/useFinanceReconciliation';
import { Info } from 'lucide-react';

type Props = {
  items: LegacyManualReviewItem[];
  currencyCode: string;
};

export function LegacyManualReviewPanel({ items, currencyCode }: Props) {
  if (items.length === 0) return null;

  const totalPence = items.reduce((sum, item) => sum + item.amount_pence, 0);

  return (
    <Alert className="border-amber-200 bg-amber-50/80 dark:border-amber-900 dark:bg-amber-950/30">
      <Info className="h-4 w-4 text-amber-700 dark:text-amber-400" />
      <AlertTitle className="text-amber-900 dark:text-amber-100">Legacy Manual Review</AlertTitle>
      <AlertDescription className="space-y-3 text-amber-900/90 dark:text-amber-100/90">
        <p>
          Historical payouts that cannot be mapped to specific earnings with certainty are excluded from
          automatic earning allocation. This is informational only — accounting balances are unchanged.
        </p>
        <ul className="space-y-2 text-sm">
          {items.map((item) => (
            <li
              key={item.payout_item_id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-200/80 bg-background/60 px-3 py-2 dark:border-amber-900/60"
            >
              <Badge variant="outline" className="font-normal">
                Legacy Manual Review
              </Badge>
              <span className="font-semibold">{formatPence(item.amount_pence, currencyCode)}</span>
              <span className="text-muted-foreground">
                Excluded from automatic earning allocation.
              </span>
            </li>
          ))}
        </ul>
        {items.length > 1 && (
          <p className="text-xs text-muted-foreground">
            Total legacy manual-review exclusions: {formatPence(totalPence, currencyCode)}
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
