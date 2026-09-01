import { useEffect, useState } from 'react';
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
  if (row.driver_name?.trim()) return row.driver_name.trim();
  if (row.driver_code?.trim()) return row.driver_code.trim();
  return 'Unknown driver';
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
  }, [regionId, filter?.serviceAreaId]);

  const { data, isLoading, error, refetch, isFetching } = useDriverWalletSsot({
    regionId,
    serviceAreaId: filter?.serviceAreaId ?? null,
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

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base">Drivers</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Period-scoped expected earnings and wallet credits
              {pageFrom && pageTo ? ` (${pageFrom} – ${pageTo})` : ''}.
              Available is live payout eligibility — open a row for full evidence.
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
                  <TableHead className="text-right">Expected earnings</TableHead>
                  <TableHead className="text-right">Wallet credited</TableHead>
                  <TableHead className="text-right">Paid out</TableHead>
                  <TableHead className="text-right" title="Live payout eligibility (not period-scoped)">
                    Available
                  </TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
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
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {row.driver_code?.trim() || row.driver_id.slice(0, 8)}
                        {row.service_area_name || serviceAreaName ? ` · ${row.service_area_name ?? serviceAreaName}` : ''}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(row.expected_payable_pence)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(row.actual_wallet_trip_credits_pence)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(row.payouts_debited_pence ?? 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt(row.available_for_payout_pence ?? row.cashout_limit_pence)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(row.wallet_variance_pence)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={statusVariant(row.reconciliation_status)}
                        title={(row.reconciliation_reasons ?? []).join(' · ')}
                      >
                        {row.reconciliation_status}
                      </Badge>
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