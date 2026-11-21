import { Card, CardContent } from '@/components/ui/card';
import type { DriverWalletSettlementHistoryRow } from '@/hooks/useDriverWalletSsot';
import { formatNullablePence } from '@/lib/formatNullablePence';

/**
 * Campaign bonuses summary — sums backend `authorised_campaign_credit_pence` from the
 * loaded settlement_history only (no derivation, no ledger mutation).
 */
export function DriverWalletCampaignBonusCard({
  settlementRows,
  currencyCode = 'GBP',
  periodLabel,
}: {
  settlementRows: DriverWalletSettlementHistoryRow[] | null | undefined;
  currencyCode?: string;
  periodLabel?: string;
}) {
  const rows = settlementRows ?? [];
  const reported = rows.filter((row) => row.authorised_campaign_credit_pence != null);
  const totalPence = reported.length > 0
    ? reported.reduce((sum, row) => sum + Number(row.authorised_campaign_credit_pence), 0)
    : null;
  const tripCount = reported.filter((row) => Number(row.authorised_campaign_credit_pence) > 0).length;

  return (
    <Card data-testid="driver-wallet-campaign-bonus-card">
      <CardContent className="pt-3 pb-3">
        <p className="text-xs text-muted-foreground">Campaign bonuses</p>
        <p className="text-lg font-semibold tabular-nums mt-0.5">
          {formatNullablePence(totalPence, currencyCode)}
        </p>
        <p className="text-[10px] text-muted-foreground mt-1">
          {totalPence == null
            ? 'No campaign credit data for this period'
            : `Authorised campaign credit on ${tripCount} trip${tripCount === 1 ? '' : 's'}`}
          {periodLabel ? ` · ${periodLabel}` : ''}
        </p>
      </CardContent>
    </Card>
  );
}
