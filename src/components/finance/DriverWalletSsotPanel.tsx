import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';
import { payoutLedgerUrl } from '../../../shared/adminPayoutLedgerSSOT';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoneyMinor } from '@/lib/formatMoneyMinor';
import { FinancialReconciliationDriverDrawer } from '@/components/finance/FinancialReconciliationDriverDrawer';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import type { FinanceMoneyFormat } from '@/hooks/useFinanceReconciliationMoney';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';
import {
  useDriverWalletSsot,
  type DriverWalletSsotRow,
} from '@/hooks/useDriverWalletSsot';

const DEFAULT_PAGE_SIZE = 25;

function resolvePageSize(override?: number): number {
  const envSize = Number(import.meta.env.VITE_SSOT_PAGE_SIZE);
  if (Number.isFinite(envSize) && envSize > 0) return Math.min(50, envSize);
  return override ?? DEFAULT_PAGE_SIZE;
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'BALANCED') return 'default';
  if (
    status === 'PROVIDER_BALANCE_UNAVAILABLE'
    || status === 'PENDING_SYNC'
    || status === 'ACCOUNT_UNVERIFIED'
  ) {
    return 'secondary';
  }
  return 'destructive';
}

function driverLabel(row: Pick<DriverWalletSsotRow, 'driver_code' | 'driver_name' | 'driver_id'>): string {
  if (row.driver_name) return row.driver_name;
  if (row.driver_code) return row.driver_code;
  return row.driver_id.slice(0, 8);
}


export function DriverWalletSsotPanel({
  currencyCode,
  regionId = null,
  pageSize: pageSizeProp,
  filter,
  pageFrom,
  pageTo,
  money,
  readOnly = false,
  ssotBadge = 'LIVE',
  lastSyncedAt = null,
  serviceAreaName,
}: {
  currencyCode?: string;
  regionId?: string | null;
  pageSize?: number;
  /** @deprecated variant is ignored — panel is reconciliation-only */
  variant?: 'reconciliation';
  filter?: ServiceAreaFinanceSelection;
  pageFrom?: string;
  pageTo?: string;
  money?: FinanceMoneyFormat;
  readOnly?: boolean;
  ssotBadge?: FinanceDataSourceBadge;
  lastSyncedAt?: string | null;
  serviceAreaName?: string | null;
}) {
  const pageSize = resolvePageSize(pageSizeProp);
  const [page, setPage] = useState(1);
  const [selectedDriver, setSelectedDriver] = useState<DriverWalletSsotRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [regionId]);

  const { data, isLoading, error, refetch, isFetching } = useDriverWalletSsot({
    regionId,
    page,
    pageSize,
  });

  const rows = data?.drivers ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const fmt = (p: number | null | undefined) => {
    if (p == null) return '—';
    if (!currencyCode) return '—';
    return formatMoneyMinor(p, currencyCode);
  };

  const openDriverDrawer = (row: DriverWalletSsotRow) => {
    setSelectedDriver(row);
    setDrawerOpen(true);
  };


  const fallbackMoney: FinanceMoneyFormat = money ?? {
    fmt: (p, ccy) => formatMoneyMinor(p ?? 0, ccy ?? currencyCode ?? 'GBP'),
    currencyCode: currencyCode ?? 'GBP',
    currencySymbol: currencyCode ?? 'GBP',
    currencyMinorUnit: 2,
    isMixedCurrency: false,
  };

  const tripsUrl = (driverId: string) => {
    const params = new URLSearchParams({ tab: 'trips', driverId });
    return `/financial-reconciliation?${params.toString()}`;
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base">Drivers</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Per-driver Financial Reconciliation — Driver Wallet vs canonical payable. Legacy Connect is retired.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? <p className="text-sm text-muted-foreground">Loading SSOT…</p> : null}
          {error ? <p className="text-sm text-destructive">{(error as Error).message}</p> : null}

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Driver</TableHead>
                  <TableHead>Driver Code</TableHead>
                  <TableHead>Service Area</TableHead>
                  <TableHead className="text-right">Expected Driver Payable</TableHead>
                  <TableHead className="text-right">Actual Wallet Trip Credits</TableHead>
                  <TableHead className="text-right">Wallet Adjustments</TableHead>
                  <TableHead className="text-right">Debt Recovery</TableHead>
                  <TableHead className="text-right">Payouts Debited</TableHead>
                  <TableHead className="text-right">Current Wallet Balance</TableHead>
                  <TableHead className="text-right">Available for Payout</TableHead>
                  <TableHead className="text-right">Pending Balance</TableHead>
                  <TableHead className="text-right">Wallet Variance</TableHead>
                  <TableHead className="text-right">Payout Variance</TableHead>
                  <TableHead>Reconciliation Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !isLoading ? (
                  <TableRow>
                    <TableCell colSpan={15} className="text-center text-muted-foreground py-8">
                      No drivers with payout accounts in this region.
                    </TableCell>
                  </TableRow>
                ) : null}
                {rows.map((row) => (
                  <TableRow
                    key={row.driver_id}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => openDriverDrawer(row)}
                  >
                    <TableCell>
                      <div className="font-medium whitespace-nowrap">{driverLabel(row)}</div>
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                      {row.driver_code ?? row.driver_id.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {row.service_area_name ?? serviceAreaName ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(row.expected_payable_pence)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(row.actual_wallet_trip_credits_pence)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(row.wallet_adjustments_pence ?? 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(row.debt_recovery_pence ?? 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(row.payouts_debited_pence ?? 0)}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {fmt(row.current_wallet_balance_pence ?? row.wallet_balance_pence)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt(row.available_for_payout_pence ?? row.cashout_limit_pence)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt(row.pending_balance_pence ?? row.period_kpis?.pending_earnings_pence)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(row.wallet_variance_pence)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(row.payout_variance_pence)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={statusVariant(row.reconciliation_status)}
                        title={row.reconciliation_reasons?.length ? row.reconciliation_reasons.join(' · ') : undefined}
                      >
                        {row.reconciliation_status}
                      </Badge>
                      {row.reconciliation_reasons?.length ? (
                        <p className="text-xs text-muted-foreground mt-1 max-w-[220px]">
                          {row.reconciliation_reasons[0]}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex flex-wrap justify-end gap-1 max-w-[280px]">
                        <Button variant="outline" size="sm" asChild>
                          <Link to={tripsUrl(row.driver_id)}>Open Trips</Link>
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <Link to={driverWalletLedgerUrl(row.driver_id, 'overview')}>
                            Open Driver Wallet
                          </Link>
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <Link to={payoutLedgerUrl({ driverId: row.driver_id })}>
                            Open Payout Ledger
                          </Link>
                        </Button>
                        <Button variant="default" size="sm" onClick={() => openDriverDrawer(row)}>
                          View Reconciliation Evidence
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {total > pageSize ? (
            <div className="flex items-center justify-between mt-4 text-sm">
              <p className="text-muted-foreground">
                Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total} drivers
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || isFetching}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <span className="text-muted-foreground tabular-nums">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || isFetching}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : total > 0 ? (
            <p className="text-xs text-muted-foreground mt-3">{total} driver{total === 1 ? '' : 's'}</p>
          ) : null}
        </CardContent>
      </Card>

      {filter ? (
        <FinancialReconciliationDriverDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          driverRow={selectedDriver}
          filter={filter}
          pageFrom={pageFrom}
          pageTo={pageTo}
          money={fallbackMoney}
          readOnly={readOnly}
          ssotBadge={ssotBadge}
          lastSyncedAt={lastSyncedAt}
          serviceAreaName={serviceAreaName}
        />
      ) : null}
    </>
  );
}
