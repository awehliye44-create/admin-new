import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatNullablePence } from '@/lib/formatNullablePence';
import {
  useDriverWalletSsot,
  type DriverWalletSsotRow,
} from '@/hooks/useDriverWalletSsot';

function driverLabel(row: Pick<DriverWalletSsotRow, 'driver_code' | 'driver_name' | 'driver_id'>): string {
  if (row.driver_name) return row.driver_name;
  if (row.driver_code) return row.driver_code;
  return row.driver_id.slice(0, 8);
}

function walletStatusVariant(status: string | null | undefined): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'ACTIVE') return 'default';
  if (status === 'RESTRICTED' || status === 'NOT_CONNECTED') return 'secondary';
  return 'destructive';
}

function formatNextPayout(row: DriverWalletSsotRow, currencyCode: string): string {
  const amount = formatNullablePence(row.scheduled_payout_display_pence, currencyCode);
  if (!row.next_scheduled_payout_at) return amount;
  try {
    return `${amount} · ${format(new Date(row.next_scheduled_payout_at), 'dd MMM')}`;
  } catch {
    return amount;
  }
}

/**
 * Driver Wallet Ledger left-side Driver List — opens a driver's financial account.
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
        <CardTitle className="text-base">Drivers</CardTitle>
        <p className="text-sm text-muted-foreground mt-1">
          Select a driver to open their wallet account. Balances are Driver Wallet Ledger SSOT only.
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
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Commission %</TableHead>
                <TableHead className="text-right">Live Wallet Balance</TableHead>
                <TableHead className="text-right">Available Balance</TableHead>
                <TableHead className="text-right">Pending Balance</TableHead>
                <TableHead>Next Payout</TableHead>
                <TableHead>Wallet Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && !isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    No drivers with connected payout accounts in this region.
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((row) => (
                <TableRow
                  key={row.driver_id}
                  className={`cursor-pointer hover:bg-muted/40 ${
                    selectedDriverId === row.driver_id ? 'bg-muted/60' : ''
                  }`}
                  onClick={() => onSelectDriver(row.driver_id)}
                >
                  <TableCell>
                    <div className="font-medium">{driverLabel(row)}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {row.driver_code ?? row.driver_id.slice(0, 8)}
                    </div>
                  </TableCell>
                  <TableCell>{row.driver_tier_name ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.commission_percent != null ? `${row.commission_percent}%` : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNullablePence(row.wallet_balance_pence, currencyCode)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNullablePence(row.cashout_limit_pence, currencyCode)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNullablePence(row.period_kpis?.pending_earnings_pence, currencyCode)}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatNextPayout(row, currencyCode)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={walletStatusVariant(row.wallet_status)}>
                      {row.wallet_status ?? '—'}
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
