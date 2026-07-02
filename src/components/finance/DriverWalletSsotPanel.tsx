import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import { driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPence } from '@/hooks/useDriverWallet';
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
  if (status === 'LOCAL_ONLY' || status === 'STRIPE_ONLY') return 'secondary';
  return 'destructive';
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

function driverLabel(row: Pick<DriverWalletSsotRow, 'driver_code' | 'driver_name' | 'driver_id'>): string {
  if (row.driver_name) return row.driver_name;
  if (row.driver_code) return row.driver_code;
  return row.driver_id.slice(0, 8);
}

export function DriverWalletSsotPanel({
  currencyCode = 'GBP',
  regionId = null,
  pageSize: pageSizeProp,
}: {
  currencyCode?: string;
  regionId?: string | null;
  pageSize?: number;
  /** @deprecated variant is ignored — panel is reconciliation-only */
  variant?: 'reconciliation';
}) {
  const pageSize = resolvePageSize(pageSizeProp);
  const [page, setPage] = useState(1);

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

  const fmt = (p: number | null | undefined) => (
    p == null ? '—' : formatPence(p, currencyCode)
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle className="text-base">Drivers</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Digital payout positions from Stripe Connect — ledger balance is on Driver Wallet Ledger only.
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
                <TableHead className="text-right">Available in Stripe</TableHead>
                <TableHead className="text-right">Scheduled Payout</TableHead>
                <TableHead>Last Stripe Payout</TableHead>
                <TableHead>Reconciliation Status</TableHead>
                <TableHead className="text-right">Open Ledger</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && !isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No drivers with Connect accounts in this region.
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((row) => (
                <TableRow key={row.driver_id}>
                  <TableCell>
                    <div className="font-medium">{driverLabel(row)}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.driver_code ?? row.driver_id.slice(0, 8)}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{fmt(row.stripe_connect_available_pence)}</TableCell>
                  <TableCell className="text-right">
                    {fmt(row.scheduled_payout_display_pence ?? row.included_in_payout_batch_amount_pence)}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {row.last_payout_at ? (
                      <>
                        <div>{fmt(row.last_payout_amount_pence)}</div>
                        <div className="text-muted-foreground">{formatDateTime(row.last_payout_at)}</div>
                      </>
                    ) : '—'}
                  </TableCell>
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
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" asChild>
                      <Link to={driverWalletLedgerUrl(row.driver_id, 'overview')}>
                        Open ledger
                      </Link>
                    </Button>
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
          <p className="text-xs text-muted-foreground mt-3">{total} driver{total === 1 ? '' : 's'} with Connect</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
