import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatPence } from '@/hooks/useDriverWallet';
import { useFinanceLedgerTransactions } from '@/hooks/useFinanceLedgerTransactions';
import { isAdminDebtRecoveryDebit } from '@/lib/adminFinanceLedgerDisplay';
import {
  DRIVER_WALLET_LEDGER_FILTER_LABELS,
  type DriverWalletLedgerFilter,
} from '@/lib/driverWalletLedgerFilters';
import { getTripDisplayId } from '@/lib/tripUtils';
import { ledgerAuditTypeLabel } from '@/lib/driverWalletLedgerRoutes';
import { RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import {
  CRITICAL_BUTTON_TIMEOUT_MESSAGE,
  useCriticalButtonTimeout,
} from '@/lib/criticalButtonTimeout';
import { startAdminPerformanceStep } from '@/lib/recordAdminPerformanceStep';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';

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
}: {
  serviceFilter: ServiceAreaFinanceSelection;
  periodFrom?: string;
  periodTo?: string;
  driverId: string;
  initialFilter?: DriverWalletLedgerFilter;
  hideFilterTabs?: boolean;
}) {
  const [filter, setFilter] = useState<DriverWalletLedgerFilter>(initialFilter);

  useEffect(() => {
    setFilter(initialFilter);
  }, [initialFilter]);
  const [search, setSearch] = useState('');

  const { data: rows = [], isLoading, refetch, isFetching } = useFinanceLedgerTransactions({
    filter,
    regionId: serviceFilter.regionId,
    driverId,
    limit: 300,
    from: periodFrom,
    to: periodTo,
  });

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => {
      const tripRef = row.trip_code ?? row.trip_id ?? '';
      return (
        row.type_label.toLowerCase().includes(q)
        || row.customer_name?.toLowerCase().includes(q)
        || tripRef.toLowerCase().includes(q)
        || row.type.toLowerCase().includes(q)
        || (row.description?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rows, search]);

  const refreshLedgerTimeout = useCriticalButtonTimeout({
    action: 'admin_refresh_finance',
    isPending: isFetching,
    onTimeout: () => {
      void refetch();
      toast.error(CRITICAL_BUTTON_TIMEOUT_MESSAGE);
    },
  });
  const showRefreshSpinner = refreshLedgerTimeout.showSpinner;

  const handleRefresh = () => {
    const perf = startAdminPerformanceStep({
      action_name: 'admin_refresh_finance',
      metadata: { surface: 'finance_ledger', driver_id: driverId },
    });
    void refetch().then(
      () => perf.complete({ success: true }),
      (err) => perf.complete({
        success: false,
        error_code: err instanceof Error ? err.message : 'refresh_failed',
      }),
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search trip, type, details…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={showRefreshSpinner}>
          <RefreshCw className={`h-4 w-4 mr-2 ${showRefreshSpinner ? 'animate-spin' : ''}`} />
          Refresh
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
            Audit log — trip settlements, Provider transfers/payouts, adjustments, refunds, and admin corrections.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-48 text-muted-foreground">
              <RefreshCw className="h-6 w-6 animate-spin mr-2" />
              Loading ledger…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date/time</TableHead>
                    <TableHead>Trip</TableHead>
                    <TableHead>Party</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Ledger ref</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                        No ledger rows found for this filter.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredRows.map((row) => {
                      const isRecoveryDebit = isAdminDebtRecoveryDebit(row.type, row.amount_pence);
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="whitespace-nowrap text-xs">
                            {format(new Date(row.created_at), 'dd MMM yyyy HH:mm')}
                          </TableCell>
                          <TableCell className="text-xs font-mono">
                            {row.trip_id
                              ? getTripDisplayId({ trip_code: row.trip_code, id: row.trip_id })
                              : '—'}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`text-[10px] ${partyBadgeClass(row.party)}`}>
                              {row.party}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">{row.customer_name ?? '—'}</TableCell>
                          <TableCell className="text-xs">
                            <span className={isRecoveryDebit ? 'text-red-400 font-medium' : undefined}>
                              {ledgerAuditTypeLabel(row.type ?? row.type_label)}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs capitalize">{row.direction}</TableCell>
                          <TableCell className={`text-xs text-right font-medium ${row.amount_pence >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {formatPence(row.amount_pence, row.currency)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[220px] truncate" title={row.description ?? undefined}>
                            {row.description ?? '—'}
                          </TableCell>
                          <TableCell className="text-xs capitalize">{row.payment_method ?? '—'}</TableCell>
                          <TableCell className="text-xs">{row.source}</TableCell>
                          <TableCell className="text-xs">{row.status ?? '—'}</TableCell>
                          <TableCell className="text-xs font-mono truncate max-w-[100px]" title={row.ledger_reference ?? undefined}>
                            {row.ledger_reference?.slice(0, 8) ?? '—'}
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
