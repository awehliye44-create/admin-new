import { useConnectPayoutStatus, type ConnectBalanceAccount } from '@/hooks/useConnectPayoutStatus';
import { formatPence } from '@/hooks/useDriverWallet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AlertTriangle, RefreshCw, Wallet } from 'lucide-react';
import { ConnectManualPayoutDialog } from '@/components/finance/ConnectManualPayoutDialog';
import { DriverPayoutSsotDetailPanel } from '@/components/finance/DriverPayoutSsotDetailPanel';
import { useState } from 'react';

function statusBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  const s = status.toLowerCase();
  if (s === 'active') return 'default';
  if (s.includes('restrict') || s.includes('requirements')) return 'destructive';
  return 'secondary';
}

export function ConnectBalancePanel({
  regionId,
  currencyCode,
}: {
  regionId?: string | null;
  currencyCode: string;
}) {
  const { data, isLoading, error, refetch, isFetching } = useConnectPayoutStatus(regionId);
  const [reviewDriver, setReviewDriver] = useState<ConnectBalanceAccount | null>(null);
  const [payoutDriver, setPayoutDriver] = useState<ConnectBalanceAccount | null>(null);

  if (isLoading && !data) {
    return <div className="py-8 text-center text-muted-foreground">Loading driver payout SSOT…</div>;
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Driver payout SSOT unavailable</AlertTitle>
        <AlertDescription>{(error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const accounts = data?.connect_accounts ?? [];
  const platform = data?.platform_stripe;

  return (
    <div className="space-y-4">
      <Alert>
        <Wallet className="h-4 w-4" />
        <AlertTitle>Driver Payout SSOT — ledger, Connect, and platform truth</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            Admins always see three layers: <strong>ONECAB wallet ledger</strong> (what we owe),{' '}
            <strong>Stripe Connect balance</strong> (payout executable on Connect), and{' '}
            <strong>platform reconciliation</strong> (ONECAB Stripe pool — not the cash-out cap).
          </p>
          <p>
            <strong>Cash out now</strong> = min(ledger owed, finance-cleared, Connect available).{' '}
            <strong>Awaiting settlement</strong> = max(0, ledger − Connect available).
          </p>
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {accounts.length} driver{accounts.length === 1 ? '' : 's'} with Connect
          {platform ? (
            <>
              {' · '}
              Platform available {formatPence(platform.available_pence, currencyCode)}
              {' · '}
              Platform pending {formatPence(platform.pending_pence, currencyCode)}
            </>
          ) : null}
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh SSOT data
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Driver payout SSOT overview</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Driver</TableHead>
                <TableHead>Connect</TableHead>
                <TableHead className="text-right">Ledger owed</TableHead>
                <TableHead className="text-right">Finance cleared</TableHead>
                <TableHead className="text-right">Connect avail.</TableHead>
                <TableHead className="text-right">Cash out now</TableHead>
                <TableHead className="text-right">Awaiting</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    No drivers with Stripe Connect accounts in this filter.
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((row) => {
                  const ccy = row.currency ?? currencyCode;
                  return (
                    <TableRow key={row.driver_id}>
                      <TableCell>
                        <div className="font-medium">{row.driver_name}</div>
                        <div className="text-xs text-muted-foreground">{row.driver_code ?? row.driver_id.slice(0, 8)}</div>
                      </TableCell>
                      <TableCell>
                        <code className="text-xs">{row.stripe_account_id}</code>
                        <div className="text-xs text-muted-foreground mt-1">
                          {row.connect_account_type ?? '—'} · payouts {row.payouts_enabled ? 'on' : 'off'}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPence(row.wallet_owed_pence ?? Math.max(0, row.wallet_balance_pence), ccy)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPence(row.finance_cleared_pence ?? row.onecab_available_now_pence, ccy)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPence(row.connect_available_pence, ccy)}
                      </TableCell>
                      <TableCell className="text-right font-mono font-semibold">
                        {formatPence(row.cashout_now_pence, ccy)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPence(row.awaiting_settlement_pence, ccy)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusBadgeVariant(row.connect_account_status)}>
                          {row.connect_account_status}
                        </Badge>
                        {row.payout_blocked && (
                          <Badge variant="destructive" className="ml-1 mt-1">
                            blocked
                          </Badge>
                        )}
                        {(row.cashout_block_reasons?.length ?? 0) > 0 && !row.cashout_enabled && (
                          <div className="text-xs text-destructive mt-1 flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            {row.cashout_block_reasons![0]}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button variant="outline" size="sm" onClick={() => setReviewDriver(row)}>
                          SSOT detail
                        </Button>
                        {row.manual_connect_payout_allowed && (
                          <Button size="sm" onClick={() => setPayoutDriver(row)}>
                            Manual payout
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {reviewDriver && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">
              Driver Payout SSOT — {reviewDriver.driver_name}
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setReviewDriver(null)}>
              Close
            </Button>
          </CardHeader>
          <CardContent>
            <DriverPayoutSsotDetailPanel
              row={reviewDriver}
              currencyCode={currencyCode}
              platformStripe={platform}
            />
          </CardContent>
        </Card>
      )}

      <ConnectManualPayoutDialog
        driver={payoutDriver}
        currencyCode={currencyCode}
        open={!!payoutDriver}
        onOpenChange={(open) => {
          if (!open) setPayoutDriver(null);
        }}
        onSuccess={() => {
          setPayoutDriver(null);
          void refetch();
        }}
      />
    </div>
  );
}
