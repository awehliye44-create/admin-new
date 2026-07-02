import { Badge } from '@/components/ui/badge';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Info } from 'lucide-react';
import { Link } from 'react-router-dom';

const BADGE_STYLES: Record<FinanceDataSourceBadge, string> = {
  LIVE: 'bg-emerald-600/15 text-emerald-800 border-emerald-600/30',
  DEGRADED_SNAPSHOT: 'bg-red-600/15 text-red-800 border-red-600/30',
  UNAVAILABLE: 'bg-red-600/15 text-red-800 border-red-600/30',
};

const BADGE_LABELS: Record<FinanceDataSourceBadge, string> = {
  LIVE: 'LIVE',
  DEGRADED_SNAPSHOT: 'DEGRADED_SNAPSHOT',
  UNAVAILABLE: 'UNAVAILABLE',
};

export function FinanceSSOTBadge({ badge }: { badge: FinanceDataSourceBadge }) {
  return (
    <Badge variant="outline" className={BADGE_STYLES[badge] ?? ''}>
      {BADGE_LABELS[badge] ?? badge}
    </Badge>
  );
}

/** Operational finance pages that are not SSOT — point admins to canonical pages. */
export function FinanceSsotOperationalNotice() {
  return (
    <Alert>
      <Info className="h-4 w-4" />
      <AlertTitle>Finance SSOT</AlertTitle>
      <AlertDescription>
        Driver wallets, trip audit, platform KPIs, and reconciliation alerts live only in{' '}
        <Link to="/driver-wallet-ledger" className="underline">Driver Wallet Ledger (SSOT)</Link>
        {' '}and{' '}
        <Link to="/financial-reconciliation" className="underline">Financial Reconciliation (SSOT)</Link>.
        This page does not duplicate those calculations.
      </AlertDescription>
    </Alert>
  );
}
