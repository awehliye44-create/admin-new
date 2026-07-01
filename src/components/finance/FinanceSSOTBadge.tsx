import { Badge } from '@/components/ui/badge';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';

const BADGE_STYLES: Record<FinanceDataSourceBadge, string> = {
  LIVE: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  SUMMARY: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  LEDGER: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  RECONSTRUCTED: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
};

const BADGE_HINTS: Record<FinanceDataSourceBadge, string> = {
  LIVE: 'Financial Reconciliation Live — official SSOT calculations',
  SUMMARY: 'Driver Financial Summary fallback',
  LEDGER: 'ONECAB wallet ledger liability (excludes platform commission & cash trip earning)',
  RECONSTRUCTED: 'Historical payout reconstruction',
};

export function FinanceSSOTBadge({ badge }: { badge: FinanceDataSourceBadge }) {
  const safe = badge in BADGE_STYLES ? badge : 'RECONSTRUCTED';
  return (
    <Badge variant="outline" className={BADGE_STYLES[safe]} title={BADGE_HINTS[safe]}>
      {safe}
    </Badge>
  );
}
