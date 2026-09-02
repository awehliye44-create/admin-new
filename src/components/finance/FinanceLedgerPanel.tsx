import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatPence } from '@/hooks/useDriverWallet';
import { useFinanceLedgerTransactions, type FinanceLedgerTransactionRow } from '@/hooks/useFinanceLedgerTransactions';
import {
  driverWalletAdminAdjustmentReasonLabel,
  useDriverWalletAdminAdjustments,
} from '@/hooks/useDriverWalletAdminAdjustments';
import {
  formatDriverWalletAdminAdjustmentAuditNotes,
  formatDriverWalletAdminIdShort,
} from '../../../shared/driverWalletManualAdjustmentSSOT';
import { isAdminDebtRecoveryDebit } from '@/lib/adminFinanceLedgerDisplay';
import {
  DRIVER_WALLET_LEDGER_FILTER_LABELS,
  driverWalletFilterToAdminFilter,
  type DriverWalletLedgerFilter,
} from '@/lib/driverWalletLedgerFilters';
import { getTripDisplayId } from '@/lib/tripUtils';
import { ledgerAuditTypeLabel } from '@/lib/driverWalletLedgerRoutes';
import { canonicalDriverWalletTxType } from '@/lib/driverWalletTransactionTypes';
import { Download, Printer, Search } from 'lucide-react';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { downloadCsv, downloadRecordsAsExcel, printFinanceReport } from '@/lib/financeExport';
import { filterDriverWalletMovementRows } from '@/lib/driverWalletMovementDisplaySSOT';
import { isDriverCreditExceptionHealth } from '../../../shared/driverCreditMonitoringSSOT';

const DRIVER_FILTER_TABS = Object.entries(DRIVER_WALLET_LEDGER_FILTER_LABELS) as [DriverWalletLedgerFilter, string][];

function partyBadgeClass(party: string): string {
  switch (party) {
    case 'customer':
      return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
    case 'driver':
      return 'bg-violet-500/15 text-violet-300 border-violet-500/30';
    case 'ONECAB':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    case 'Provider':
      return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

export function FinanceLedgerPanel({
  serviceFilter,
  periodFrom,
  periodTo,
  driverId,
  initialFilter = 'driver_earnings',
  hideFilterTabs = false,
  variant = 'default',
  creditByTripId,
  creditExceptionsOnly = false,
}: {
  serviceFilter: ServiceAreaFinanceSelection;
  periodFrom?: string;
  periodTo?: string;
  driverId: string;
  initialFilter?: DriverWalletLedgerFilter;
  hideFilterTabs?: boolean;
  /** driver_wallet: Credit/Debit + canonical Type enum columns. */
  variant?: 'default' | 'driver_wallet';
  creditByTripId?: Record<string, {
    driver_credit_health?: string | null;
    expected_driver_credit_pence?: number | null;
    actual_driver_credit_pence?: number | null;
    credit_difference_pence?: number | null;
  }>;
  /** When true, show only trip rows with driver credit exception health. */
  creditExceptionsOnly?: boolean;
}) {
  const [filter, setFilter] = useState<DriverWalletLedgerFilter>(initialFilter);

  useEffect(() => {
    setFilter(initialFilter);
  }, [initialFilter]);
  const [search, setSearch] = useState('');

  const isWallet = variant === 'driver_wallet';

  const { data: rows = [], isLoading } = useFinanceLedgerTransactions({
    filter: driverWalletFilterToAdminFilter(filter),
    regionId: serviceFilter.regionId,
    driverId,
    limit: 300,
    from: periodFrom,
    to: periodTo,
    /** Driver Wallet: skip React running-balance attach; filter commissions client-side too. */
    skipRunningBalance: isWallet,
  });

  const { data: adminAdjustments = [] } = useDriverWalletAdminAdjustments(
    isWallet && filter === 'adjustments' ? driverId : null,
  );

  const ledgerEntryIds = useMemo(
    () => new Set(rows.map((r) => r.id)),
    [rows],
  );

  const mergedRows = useMemo(() => {
    if (!isWallet || filter !== 'adjustments') return rows;
    const pendingRows: FinanceLedgerTransactionRow[] = adminAdjustments
      .filter((adj) => adj.status !== 'APPLIED' || !adj.ledger_entry_id || !ledgerEntryIds.has(adj.ledger_entry_id))
      .filter((adj) => adj.status === 'PENDING_APPROVAL' || adj.status === 'REJECTED')
      .map((adj) => {
        const signed = adj.signed_amount_pence ?? (adj.direction === 'DEBIT' ? -adj.amount_pence : adj.amount_pence);
        const reasonLabel = driverWalletAdminAdjustmentReasonLabel(adj.reason_category);
        return {
          id: `admin-adj-${adj.id}`,
          created_at: adj.created_at,
          trip_id: adj.related_trip_id,
          trip_code: null,
          driver_id: driverId,
          driver_name: null,
          customer_name: null,
          type: adj.ledger_type,
          type_label: adj.ledger_type === 'ADMIN_WALLET_CREDIT' ? 'Admin wallet credit' : 'Admin wallet debit',
          party: 'driver',
          direction: signed >= 0 ? 'credit' : 'debit',
          amount_pence: signed,
          currency: 'GBP',
          payment_method: null,
          source: 'admin_manual_adjustment',
          status: adj.status === 'PENDING_APPROVAL' ? 'Pending approval' : 'Rejected',
          ledger_reference: adj.id,
          description: reasonLabel,
          notes: formatDriverWalletAdminAdjustmentAuditNotes({
            reasonCategoryLabel: reasonLabel,
            reasonNote: adj.reason_note,
            createdByAdminId: adj.created_by_admin_id,
            approvedByAdminId: adj.approved_by_admin_id,
          }),
          evidence: adj.evidence_reference,
          adjustment_status: adj.status === 'PENDING_APPROVAL' ? 'Pending approval' : 'Rejected',
          adjustment_reason_category: reasonLabel,
          adjustment_created_by: adj.created_by_admin_id,
          adjustment_approved_by: adj.approved_by_admin_id,
          related_payout_item_id: adj.related_payout_item_id,
        } satisfies FinanceLedgerTransactionRow;
      });
    return [...pendingRows, ...rows].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [rows, adminAdjustments, filter, isWallet, driverId, ledgerEntryIds]);

  const showCreditHealth = Boolean(creditByTripId && Object.keys(creditByTripId).length > 0);

  const filteredRows = useMemo(() => {
    const movementRows = isWallet ? filterDriverWalletMovementRows(mergedRows) : mergedRows;
    const creditScopedRows = creditExceptionsOnly && creditByTripId
      ? movementRows.filter((row) => {
        if (!row.trip_id) return false;
        const health = creditByTripId[row.trip_id]?.driver_credit_health;
        return isDriverCreditExceptionHealth(health);
      })
      : movementRows;
    const q = search.trim().toLowerCase();
    if (!q) return creditScopedRows;
    return creditScopedRows.filter((row) => {
      const tripRef = row.trip_code ?? row.trip_id ?? '';
      return (
        row.type_label.toLowerCase().includes(q)
        || row.customer_name?.toLowerCase().includes(q)
        || row.driver_name?.toLowerCase().includes(q)
        || tripRef.toLowerCase().includes(q)
        || row.type.toLowerCase().includes(q)
        || (row.description?.toLowerCase().includes(q) ?? false)
        || (row.evidence?.toLowerCase().includes(q) ?? false)
        || (row.adjustment_reason_category?.toLowerCase().includes(q) ?? false)
        || (row.adjustment_created_by?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [mergedRows, search, isWallet, creditExceptionsOnly, creditByTripId]);

  const exportRows = () => {
    const records = filteredRows.map((r) => {
      const credit = r.amount_pence > 0 ? r.amount_pence : null;
      const debit = r.amount_pence < 0 ? Math.abs(r.amount_pence) : null;
      if (variant === 'driver_wallet') {
        const tripCredit = r.trip_id ? creditByTripId?.[r.trip_id] : undefined;
        return {
          date: r.created_at,
          reference: r.ledger_reference,
          trip_id: r.trip_code ?? r.trip_id,
          description: r.description ?? r.notes,
          credit_pence: credit,
          debit_pence: debit,
          type: canonicalDriverWalletTxType(r.type),
          status: r.status,
          evidence: r.evidence,
          notes: r.notes,
          driver_credit_health: tripCredit?.driver_credit_health ?? null,
          expected_driver_credit_pence: tripCredit?.expected_driver_credit_pence ?? null,
          actual_driver_credit_pence: tripCredit?.actual_driver_credit_pence ?? null,
          credit_difference_pence: tripCredit?.credit_difference_pence ?? null,
        };
      }
      return {
        date: r.created_at,
        trip_id: r.trip_code ?? r.trip_id,
        customer: r.customer_name,
        driver: r.driver_name,
        reference: r.ledger_reference,
        type: r.type_label,
        amount_pence: r.amount_pence,
        running_balance_pence: r.running_balance_pence ?? null,
        status: r.status,
        evidence: r.evidence,
        notes: r.notes,
      };
    });
    downloadCsv(`driver-wallet-statement-${driverId.slice(0, 8)}.csv`, records);
  };

  const exportExcel = () => {
    const records = filteredRows.map((r) => {
      if (variant === 'driver_wallet') {
        const tripCredit = r.trip_id ? creditByTripId?.[r.trip_id] : undefined;
        return {
          date: r.created_at,
          reference: r.ledger_reference,
          trip_id: r.trip_code ?? r.trip_id,
          description: r.description ?? r.notes,
          credit_pence: r.amount_pence > 0 ? r.amount_pence : null,
          debit_pence: r.amount_pence < 0 ? Math.abs(r.amount_pence) : null,
          type: canonicalDriverWalletTxType(r.type),
          status: r.status,
          evidence: r.evidence,
          notes: r.notes,
          driver_credit_health: tripCredit?.driver_credit_health ?? null,
          expected_driver_credit_pence: tripCredit?.expected_driver_credit_pence ?? null,
          actual_driver_credit_pence: tripCredit?.actual_driver_credit_pence ?? null,
          credit_difference_pence: tripCredit?.credit_difference_pence ?? null,
        };
      }
      return {
        date: r.created_at,
        trip_id: r.trip_code ?? r.trip_id,
        customer: r.customer_name,
        driver: r.driver_name,
        reference: r.ledger_reference,
        type: r.type_label,
        amount_pence: r.amount_pence,
        running_balance_pence: r.running_balance_pence ?? null,
        status: r.status,
        evidence: r.evidence,
        notes: r.notes,
      };
    });
    downloadRecordsAsExcel(
      `driver-wallet-statement-${driverId.slice(0, 8)}`,
      records,
      'Driver Statement',
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search trip, type, evidence…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="outline" size="sm" onClick={exportRows} disabled={filteredRows.length === 0}>
          <Download className="h-4 w-4 mr-2" />
          Statement CSV
        </Button>
        <Button variant="outline" size="sm" onClick={exportExcel} disabled={filteredRows.length === 0}>
          <Download className="h-4 w-4 mr-2" />
          Statement Excel
        </Button>
        <Button variant="outline" size="sm" onClick={() => printFinanceReport()} disabled={filteredRows.length === 0}>
          <Printer className="h-4 w-4 mr-2" />
          Statement PDF
        </Button>
      </div>

      {!hideFilterTabs && (
        <Tabs value={filter} onValueChange={(v) => setFilter(v as DriverWalletLedgerFilter)}>
          <TabsList className="flex flex-wrap h-auto gap-1">
            {DRIVER_FILTER_TABS.map(([key, label]) => (
              <TabsTrigger key={key} value={key} className="text-xs">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {DRIVER_WALLET_LEDGER_FILTER_LABELS[filter] ?? filter}
            {' '}
            <span className="text-muted-foreground font-normal">({filteredRows.length} rows)</span>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Append-only audit log. Corrections create new entries — records are never deleted.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
              Loading ledger…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Trip ID</TableHead>
                    {isWallet ? <TableHead>Description</TableHead> : (
                      <>
                        <TableHead>Customer</TableHead>
                        <TableHead>Driver</TableHead>
                      </>
                    )}
                    {!isWallet ? <TableHead>Type</TableHead> : null}
                    {isWallet ? (
                      <>
                        <TableHead className="text-right">Credit</TableHead>
                        <TableHead className="text-right">Debit</TableHead>
                      </>
                    ) : (
                      <TableHead className="text-right">Amount</TableHead>
                    )}
                    {!isWallet ? (
                      <TableHead className="text-right">Running Balance</TableHead>
                    ) : null}
                    {isWallet ? <TableHead>Type</TableHead> : null}
                    {showCreditHealth ? <TableHead>Credit health</TableHead> : null}
                    <TableHead>Status</TableHead>
                    <TableHead>Evidence</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={(isWallet ? 10 : 11) + (showCreditHealth ? 1 : 0)} className="text-center text-muted-foreground py-8">
                        {isWallet ? 'No wallet movements in this period' : 'No ledger rows found for this filter.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredRows.map((row) => {
                      const isRecoveryDebit = isAdminDebtRecoveryDebit(row.type, row.amount_pence);
                      const creditPence = row.amount_pence > 0 ? row.amount_pence : null;
                      const debitPence = row.amount_pence < 0 ? Math.abs(row.amount_pence) : null;
                      const tripCredit = row.trip_id ? creditByTripId?.[row.trip_id] : undefined;
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="whitespace-nowrap text-xs">
                            {format(new Date(row.created_at), 'dd MMM yyyy HH:mm')}
                          </TableCell>
                          <TableCell className="text-xs font-mono" title={row.ledger_reference ?? undefined}>
                            {row.ledger_reference?.slice(0, 8) ?? '—'}
                          </TableCell>
                          <TableCell className="text-xs font-mono">
                            {row.trip_id
                              ? getTripDisplayId({ trip_code: row.trip_code, id: row.trip_id })
                              : '—'}
                          </TableCell>
                          {isWallet ? (
                            <TableCell className="text-xs text-muted-foreground max-w-[220px] truncate" title={row.description ?? row.notes ?? undefined}>
                              {row.description ?? row.notes ?? '—'}
                            </TableCell>
                          ) : (
                            <>
                              <TableCell className="text-xs">{row.customer_name ?? '—'}</TableCell>
                              <TableCell className="text-xs">{row.driver_name ?? '—'}</TableCell>
                            </>
                          )}
                          {!isWallet ? (
                            <TableCell className="text-xs">
                              <span className={isRecoveryDebit ? 'text-red-400 font-medium' : undefined}>
                                {ledgerAuditTypeLabel(row.type ?? row.type_label)}
                              </span>
                              <Badge variant="outline" className={`ml-1 text-[10px] ${partyBadgeClass(row.party)}`}>
                                {row.party}
                              </Badge>
                            </TableCell>
                          ) : null}
                          {isWallet ? (
                            <>
                              <TableCell className="text-xs text-right font-medium text-emerald-400 tabular-nums">
                                {creditPence != null ? formatPence(creditPence, row.currency) : '—'}
                              </TableCell>
                              <TableCell className="text-xs text-right font-medium text-red-400 tabular-nums">
                                {debitPence != null ? formatPence(debitPence, row.currency) : '—'}
                              </TableCell>
                            </>
                          ) : (
                            <TableCell className={`text-xs text-right font-medium ${row.amount_pence >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {formatPence(row.amount_pence, row.currency)}
                            </TableCell>
                          )}
                          {!isWallet ? (
                            <TableCell className="text-xs text-right tabular-nums">
                              {formatNullablePence(row.running_balance_pence, row.currency)}
                            </TableCell>
                          ) : null}
                          {isWallet ? (
                            <TableCell className="text-xs">
                              <span className={isRecoveryDebit ? 'text-red-400 font-medium' : undefined}>
                                {canonicalDriverWalletTxType(row.type)}
                              </span>
                            </TableCell>
                          ) : null}
                          {showCreditHealth ? (
                            <TableCell className="text-xs">
                              {tripCredit?.driver_credit_health ? (
                                <Badge
                                  variant={isDriverCreditExceptionHealth(tripCredit.driver_credit_health) ? 'destructive' : 'outline'}
                                  className="text-[10px]"
                                  title={[
                                    tripCredit.expected_driver_credit_pence != null
                                      ? `Expected: ${formatNullablePence(tripCredit.expected_driver_credit_pence, row.currency)}`
                                      : null,
                                    tripCredit.actual_driver_credit_pence != null
                                      ? `Actual: ${formatNullablePence(tripCredit.actual_driver_credit_pence, row.currency)}`
                                      : null,
                                    tripCredit.credit_difference_pence != null
                                      ? `Diff: ${formatNullablePence(tripCredit.credit_difference_pence, row.currency)}`
                                      : null,
                                  ].filter(Boolean).join(' · ')}
                                >
                                  {tripCredit.driver_credit_health}
                                </Badge>
                              ) : '—'}
                            </TableCell>
                          ) : null}
                          <TableCell className="text-xs">{row.status ?? row.adjustment_status ?? '—'}</TableCell>
                          <TableCell className="text-xs font-mono max-w-[140px] truncate" title={row.evidence ?? row.related_payout_item_id ?? undefined}>
                            {row.evidence
                              ?? (row.related_payout_item_id ? `Payout ${row.related_payout_item_id.slice(0, 8)}…` : '—')}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[220px] truncate" title={row.notes ?? undefined}>
                            {row.notes ?? '—'}
                            {row.adjustment_created_by ? (
                              <span className="block text-[10px] text-muted-foreground/80">
                                Created {formatDriverWalletAdminIdShort(row.adjustment_created_by)}
                                {row.adjustment_approved_by
                                  ? ` · Approved ${formatDriverWalletAdminIdShort(row.adjustment_approved_by)}`
                                  : ''}
                              </span>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
