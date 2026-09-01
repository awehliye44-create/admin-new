import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FinancialReconciliationRefreshBar } from '@/components/finance/FinancialReconciliationRefreshBar';
import { formatFinanceDateSafe } from '@/lib/financialReconciliationGuards';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';
import { driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';
import { payoutLedgerUrl } from '../../../shared/adminPayoutLedgerSSOT';
import { financialReconciliationTripsTabUrl } from '@/lib/financialReconciliationRoutes';
import type { FinanceMoneyFormat } from '@/hooks/useFinanceReconciliationMoney';
import type { TripFinancialAuditRow } from '@/hooks/useFinanceReconciliation';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';
import {
  exportFrAuditCsv,
  type FrAuditExportMeta,
} from '@/lib/financialReconciliationAuditExport';
import { isDriverCreditExceptionHealth } from '../../../shared/driverCreditMonitoringSSOT';
import {
  FR_ISSUE_FILTERS,
  FR_ISSUE_FILTER_LABELS,
  buildFrUnifiedIssues,
  countFrIssuesByFilter,
  filterFrUnifiedIssues,
  filterFrUnifiedIssuesByTripCodes,
  type FrIssueFilter,
} from '../../../shared/frIssuesSSOT';

type FinancialReconciliationIssuesTabProps = {
  rows: TripFinancialAuditRow[];
  money: FinanceMoneyFormat;
  readOnly?: boolean;
  ssotBadge?: FinanceDataSourceBadge;
  lastSyncedAt?: string | null;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  issueFilter: FrIssueFilter;
  onIssueFilterChange: (filter: FrIssueFilter) => void;
  issueTripCodes?: string[];
  periodLabel?: string;
  exportMeta?: FrAuditExportMeta | null;
};

function investigationLink(issue: ReturnType<typeof buildFrUnifiedIssues>[number]): {
  href: string;
  label: string;
} {
  if (issue.issue_type === 'driver_credit' || issue.issue_type === 'wallet_mismatch') {
    if (issue.driver_id) {
      return { href: driverWalletLedgerUrl(issue.driver_id), label: 'Driver Wallet' };
    }
  }
  if (issue.issue_type === 'payout') {
    if (issue.driver_id) {
      return { href: payoutLedgerUrl({ driverId: issue.driver_id }), label: 'Payout Ledger' };
    }
  }
  if (
    issue.issue_type === 'shortfall'
    || issue.issue_type === 'missing_capture'
    || issue.issue_type === 'missing_release'
    || issue.issue_type === 'capture_mismatch'
  ) {
    return {
      href: paymentSessionsUrl({
        paymentSessionId: issue.payment_session_id,
        tripId: issue.trip_id,
      }),
      label: 'Payment Sessions',
    };
  }
  return {
    href: financialReconciliationTripsTabUrl(issue.trip_id, issue.trip_code),
    label: 'View trip',
  };
}

export function FinancialReconciliationIssuesTab({
  rows,
  money,
  readOnly = false,
  ssotBadge = 'LIVE',
  lastSyncedAt = null,
  isRefreshing = false,
  onRefresh,
  issueFilter,
  onIssueFilterChange,
  issueTripCodes = [],
  periodLabel,
  exportMeta,
}: FinancialReconciliationIssuesTabProps) {
  const ccy = money.currencyCode ?? 'GBP';
  const [activeFilter, setActiveFilter] = useState(issueFilter);

  useEffect(() => {
    setActiveFilter(issueFilter);
  }, [issueFilter]);

  const allIssues = useMemo(() => buildFrUnifiedIssues(rows), [rows]);
  const filterCounts = useMemo(() => countFrIssuesByFilter(allIssues), [allIssues]);
  const visible = useMemo(() => {
    const filtered = filterFrUnifiedIssues(allIssues, activeFilter);
    return filterFrUnifiedIssuesByTripCodes(filtered, issueTripCodes);
  }, [allIssues, activeFilter, issueTripCodes]);
  const exportRows = useMemo(() => {
    const tripIds = new Set(visible.map((issue) => issue.trip_id));
    return rows.filter((row) => tripIds.has(row.trip_id));
  }, [rows, visible]);

  return (
    <div className="space-y-4">
      <FinancialReconciliationRefreshBar
        badge={isRefreshing ? 'REFRESHING' : ssotBadge}
        lastSyncedAt={lastSyncedAt}
        isRefreshing={isRefreshing}
        readOnly={readOnly}
        onRefresh={onRefresh}
        label="Open issues — read-only audit; actions live on Payment Sessions, Wallet, and Payout Ledger"
      />

      {periodLabel ? (
        <p className="text-xs text-muted-foreground">Period: {periodLabel}</p>
      ) : null}

      {issueTripCodes.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Showing {issueTripCodes.join(', ')} only.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {FR_ISSUE_FILTERS.map((filter) => {
          const count = filterCounts[filter];
          const active = activeFilter === filter;
          return (
            <Button
              key={filter}
              type="button"
              size="sm"
              variant={active ? 'default' : 'outline'}
              className="h-8 text-xs"
              onClick={() => {
                setActiveFilter(filter);
                onIssueFilterChange(filter);
              }}
            >
              {FR_ISSUE_FILTER_LABELS[filter]}
              {count > 0 ? ` ${count}` : ''}
            </Button>
          );
        })}
        {exportMeta && exportRows.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs ml-auto"
            onClick={() => exportFrAuditCsv(exportRows, exportMeta)}
          >
            <Download className="h-3 w-3 mr-1" />
            Export CSV
          </Button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No issues found for this period.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Trip code</TableHead>
                <TableHead>Driver</TableHead>
                <TableHead>Issue type</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead className="text-right">Difference</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Investigation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((issue) => {
                const link = investigationLink(issue);
                return (
                  <TableRow key={`${issue.trip_id}-${issue.issue_type}`}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatFinanceDateSafe(issue.date)}
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {issue.trip_code ?? issue.trip_id.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {issue.driver_name ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={issue.is_critical ? 'destructive' : issue.is_resolved ? 'secondary' : 'outline'}
                        className="text-[10px] whitespace-nowrap"
                      >
                        {issue.issue_label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {formatNullablePence(issue.expected_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {formatNullablePence(issue.actual_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {formatNullablePence(issue.difference_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {issue.driver_credit_health ? (
                        <Badge
                          variant={isDriverCreditExceptionHealth(issue.driver_credit_health) ? 'destructive' : 'outline'}
                          className="text-[10px]"
                        >
                          {issue.driver_credit_health}
                        </Badge>
                      ) : issue.status}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                        <Link to={link.href}>{link.label}</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Showing {visible.length} issue{visible.length === 1 ? '' : 's'}
        {activeFilter !== 'all' ? ` · ${FR_ISSUE_FILTER_LABELS[activeFilter]} filter` : ''}
      </p>
    </div>
  );
}
