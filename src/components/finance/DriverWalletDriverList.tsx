import { useEffect, useState } from 'react';
import { format } from 'date-fns';
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

function driverLabel(row: Pick<DriverWalletSsotRow, 'driver_code' | 'driver_name' | 'driver_id'>): string {
  if (row.driver_name) return row.driver_name;
  if (row.driver_code) return row.driver_code;
  return row.driver_id.slice(0, 8);
}

function walletStatusVariant(status: string | null | undefined): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'ACTIVE') return 'default';
  if (status === 'RESTRICTED' || status === 'NOT_CONNECTED' || status === 'FROZEN') return 'secondary';
  return 'destructive';
}

function outstandingDebt(row: DriverWalletSsotRow): number | null {
  const v = row.debt_recovery?.remaining_debt_pence
    ?? row.debt_recovery?.outstanding_debt_pence
    ?? row.recovery_debt_pence
    ?? row.period_kpis?.outstanding_debt_pence;
  return v == null ? null : Number(v);
}

function connectedAccountStatus(row: DriverWalletSsotRow): string {
  if (row.verification_status) return row.verification_status;
  if (row.connected_account_id) return 'connected';
  return 'not_connected';
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

function formatNextPayout(row: DriverWalletSsotRow, currencyCode: string): string {
  const amount = formatNullablePence(row.scheduled_payout_display_pence, currencyCode);
  if (!row.next_scheduled_payout_at) return amount === '—' ? '—' : amount;
  try {
    return `${amount} · ${format(new Date(row.next_scheduled_payout_at), 'dd MMM')}`;
  } catch {
    return amount;
  }
}

function formatLastPayout(row: DriverWalletSsotRow, currencyCode: string): string {
  if (!row.last_payout_at && row.last_payout_amount_pence == null) return '—';
  const amount = formatNullablePence(row.last_payout_amount_pence, currencyCode);
  if (!row.last_payout_at) return amount;
  return `${amount} · ${formatDateTime(row.last_payout_at)}`;
}

/**
 * Level 1 — Driver Wallet Ledger overview list (Stripe Connected Accounts style).
 * Opens Level 2 individual driver wallet account on row / action click.
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
        <CardTitle className="text-base">Driver financial accounts</CardTitle>
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
                <TableHead>Driver Name</TableHead>
                <TableHead>Driver Code / ID</TableHead>
                <TableHead>Service Area</TableHead>
                <TableHead>Driver Tier</TableHead>
                <TableHead className="text-right">Commission %</TableHead>
                <TableHead className="text-right">Live Wallet Balance</TableHead>
                <TableHead className="text-right">Available Balance</TableHead>
                <TableHead className="text-right">Pending Balance</TableHead>
                <TableHead className="text-right">Outstanding Debt</TableHead>
                <TableHead>Next Scheduled Payout</TableHead>
                <TableHead>Last Payout</TableHead>
                <TableHead>Payout Destination Status</TableHead>
                <TableHead>Wallet Status</TableHead>
                <TableHead className="w-[52px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && !isLoading ? (
                <TableRow>
                  <TableCell colSpan={14} className="text-center text-muted-foreground py-8">
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
                  <TableCell className="font-medium">{driverLabel(row)}</TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">
                    <div>{row.driver_code ?? '—'}</div>
                    <div className="truncate max-w-[120px]" title={row.driver_id}>
                      {row.driver_id.slice(0, 8)}…
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">{row.service_area_name ?? '—'}</TableCell>
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
                  <TableCell className="text-right tabular-nums">
                    {formatNullablePence(outstandingDebt(row), currencyCode)}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatNextPayout(row, currencyCode)}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatLastPayout(row, currencyCode)}
                  </TableCell>
                  <TableCell className="text-xs">{connectedAccountStatus(row)}</TableCell>
                  <TableCell>
                    <Badge variant={walletStatusVariant(row.wallet_status)}>
                      {row.wallet_status ?? '—'}
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
