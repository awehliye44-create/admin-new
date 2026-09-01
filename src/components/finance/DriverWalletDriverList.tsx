import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, MoreHorizontal } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatNullablePence } from '@/lib/formatNullablePence';
import {
  useDriverWalletSsot,
  type DriverWalletSsotRow,
} from '@/hooks/useDriverWalletSsot';
import { displayDriverWalletSsotBalances } from '@/lib/driverWalletSsotBalances';

function driverLabel(row: Pick<DriverWalletSsotRow, 'driver_code' | 'driver_name' | 'driver_id'>): string {
  if (row.driver_name?.trim()) return row.driver_name.trim();
  if (row.driver_code?.trim()) return row.driver_code.trim();
  return 'Unknown driver';
}

function walletStatusVariant(status: string | null | undefined): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'ACTIVE') return 'default';
  if (status === 'RESTRICTED' || status === 'NOT_CONNECTED' || status === 'FROZEN') return 'secondary';
  return 'destructive';
}

function reservedPence(row: DriverWalletSsotRow): number {
  return Math.max(
    0,
    Math.round(
      Number(
        row.withdrawal_in_progress_pence
          ?? row.included_in_payout_batch_amount_pence
          ?? 0,
      ),
    ),
  );
}

function openDifferencePence(row: DriverWalletSsotRow): number | null {
  if (row.wallet_variance_pence == null) return null;
  return Math.round(Number(row.wallet_variance_pence));
}

function driverStatusLabel(row: DriverWalletSsotRow): string {
  return row.driver_credit_status ?? row.wallet_status ?? '—';
}

/**
 * Level 1 — Driver Wallet Ledger active driver list.
 * Active columns only; history metrics live on the driver detail view.
 */
export function DriverWalletDriverList({
  regionId = null,
  currencyCode = 'GBP',
  selectedDriverId = null,
  onSelectDriver,
  pageSize = 25,
}: {
  regionId?: string | null;
  currencyCode?: string;
  selectedDriverId?: string | null;
  onSelectDriver: (driverId: string) => void;
  pageSize?: number;
}) {
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [regionId]);

  const { data, isLoading, error, isFetching } = useDriverWalletSsot({
    regionId,
    page,
    pageSize,
  });

  const rows = data?.drivers ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Active driver wallets</CardTitle>
        <p className="text-sm text-muted-foreground mt-1">
          Pending, available, reserved, and open differences only. Lifetime paid-out totals are on the driver history view.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading drivers…
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{(error as Error).message}</p> : null}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Driver</TableHead>
                <TableHead className="text-right">Pending</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
                <TableHead className="text-right">Open difference</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[52px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && !isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    No drivers with connected payout accounts in this region.
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((row) => {
                const balances = displayDriverWalletSsotBalances(row);
                return (
                <TableRow
                  key={row.driver_id}
                  className={`cursor-pointer hover:bg-muted/40 ${
                    selectedDriverId === row.driver_id ? 'bg-muted/60' : ''
                  }`}
                  onClick={() => onSelectDriver(row.driver_id)}
                >
                  <TableCell className="font-medium">
                    <div>{driverLabel(row)}</div>
                    {row.driver_code?.trim() ? (
                      <div className="text-xs text-muted-foreground mt-0.5">{row.driver_code.trim()}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNullablePence(balances.pendingPence, currencyCode)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNullablePence(balances.availablePence, currencyCode)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNullablePence(reservedPence(row), currencyCode)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNullablePence(openDifferencePence(row), currencyCode)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={walletStatusVariant(row.wallet_status)}>
                      {driverStatusLabel(row)}
                    </Badge>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Driver actions">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem onClick={() => onSelectDriver(row.driver_id)}>
                          Open wallet account
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
              })}
            </TableBody>
          </Table>
        </div>

        {total > pageSize ? (
          <div className="flex items-center justify-between mt-4 text-sm">
            <p className="text-muted-foreground">
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages || isFetching}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
