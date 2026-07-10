import { Badge } from '@/components/ui/badge';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Info } from 'lucide-react';
import { Link } from 'react-router-dom';

const BADGE_STYLES: Record<string, string> = {
  LIVE: 'bg-emerald-600/15 text-emerald-800 border-emerald-600/30',
  PARTIAL: 'bg-amber-600/15 text-amber-900 border-amber-600/30',
  REFRESHING: 'bg-blue-600/15 text-blue-800 border-blue-600/30',
  DEGRADED: 'bg-amber-700/15 text-amber-950 border-amber-700/30',
  DEGRADED_SNAPSHOT: 'bg-amber-700/15 text-amber-950 border-amber-700/30',
  READ_ONLY: 'bg-slate-600/15 text-slate-800 border-slate-600/30',
  UNAVAILABLE: 'bg-red-600/15 text-red-800 border-red-600/30',
};

const BADGE_LABELS: Record<string, string> = {
  LIVE: 'LIVE',
  PARTIAL: 'PARTIAL',
  REFRESHING: 'REFRESHING',
  DEGRADED: 'DEGRADED',
  DEGRADED_SNAPSHOT: 'DEGRADED',
  READ_ONLY: 'READ-ONLY',
  UNAVAILABLE: 'UNAVAILABLE',
};

export function FinanceSSOTBadge({ badge }: { badge: FinanceDataSourceBadge | string }) {
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
        <Link to="/payment-sessions" className="underline">Payment Sessions (SSOT)</Link>
        {', '}
        <Link to="/financial-reconciliation" className="underline">Financial Reconciliation (SSOT)</Link>
        {', '}
        <Link to="/driver-wallet-ledger" className="underline">Driver Wallet Ledger (SSOT)</Link>
        {' '}and{' '}
        <Link to="/payout-ledger" className="underline">Payout Ledger (SSOT)</Link>.
        This page does not duplicate those calculations.
      </AlertDescription>
    </Alert>
  );
}
