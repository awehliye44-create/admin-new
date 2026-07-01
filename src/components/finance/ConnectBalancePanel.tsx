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
  readOnly = false,
}: {
  regionId?: string | null;
  currencyCode: string;
  /** Overview mode — no payout actions (Financial Reconciliation). */
  readOnly?: boolean;
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
        <AlertTitle>
          {readOnly
            ? 'Stripe Connect balances — physical cash only'
            : 'Driver Payout SSOT — ledger, Connect, and platform truth'}
        </AlertTitle>
        <AlertDescription className="space-y-1">
          {readOnly ? (
            <p>
              Stripe Standard and Instant available balances on each Express account. This is physical Stripe cash —
              not ONECAB ledger liability. Compare against ledger on Money Movement or Driver SSOT detail.
            </p>
          ) : (
            <>
              <p>
                ONECAB executes <strong>Stripe Instant Payout only</strong> — no Standard payout method.
                Show both Stripe balances so operations understand why Instant Available may differ from Standard Available.
              </p>
              <p>
                <strong>Cash out now</strong> = min(ONECAB wallet owed, finance-cleared, Stripe Instant Available).{' '}
                <strong>Awaiting settlement</strong> = max(0, ledger − Stripe Standard Available).
              </p>
            </>
          )}
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
          {data?.timestamp ? (
            <>
              {' · '}
              Last Stripe sync{' '}
              {new Date(data.timestamp).toLocaleString('en-GB', { timeZone: 'Europe/London' })}
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
          <CardTitle className="text-lg">
            {readOnly ? 'Per-driver payout overview' : 'Driver payout SSOT overview'}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Driver</TableHead>
                <TableHead className="text-right">ONECAB wallet</TableHead>
                <TableHead className="text-right">Finance cleared</TableHead>
                <TableHead className="text-right">Stripe Standard</TableHead>
                <TableHead className="text-right">Stripe Instant</TableHead>
                <TableHead className="text-right">Pending</TableHead>
                <TableHead className="text-right">Weekly instant</TableHead>
                <TableHead className="text-right">Manual instant</TableHead>
                <TableHead>Last instant payout</TableHead>
                <TableHead>Next weekly</TableHead>
                {!readOnly && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={readOnly ? 10 : 11} className="text-center text-muted-foreground py-8">
                    No drivers with Stripe Connect accounts in this filter.
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((row) => {
                  const ccy = row.currency ?? currencyCode;
                  const standardAvail = row.connect_standard_available_pence ?? row.connect_available_pence;
                  const instantAvail = row.connect_instant_available_pence ?? 0;
                  return (
                    <TableRow key={row.driver_id}>
                      <TableCell>
                        <button
                          type="button"
                          className="text-left"
                          onClick={() => setReviewDriver(row)}
                        >
                          <div className="font-medium hover:underline">{row.driver_name}</div>
                          <div className="text-xs text-muted-foreground">{row.driver_code ?? row.driver_id.slice(0, 8)}</div>
                          <code className="text-[10px] text-muted-foreground">{row.stripe_account_id}</code>
                        </button>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPence(row.wallet_owed_pence ?? Math.max(0, row.wallet_balance_pence), ccy)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPence(row.finance_cleared_pence ?? row.onecab_available_now_pence, ccy)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPence(standardAvail, ccy)}
                      </TableCell>
                      <TableCell className="text-right font-mono font-semibold text-green-700 dark:text-green-400">
                        {formatPence(instantAvail, ccy)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPence(row.connect_pending_pence, ccy)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPence(row.weekly_instant_eligible_pence ?? row.cashout_now_pence, ccy)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPence(row.manual_instant_eligible_pence ?? row.max_manual_connect_payout_pence, ccy)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.last_instant_payout_date
                          ? new Date(row.last_instant_payout_date).toLocaleDateString('en-GB')
                          : '—'}
                        {row.last_instant_payout_amount_pence != null && (
                          <div className="font-mono text-muted-foreground">
                            {formatPence(row.last_instant_payout_amount_pence, ccy)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.next_payout_date
                          ? new Date(row.next_payout_date).toLocaleDateString('en-GB')
                          : '—'}
                      </TableCell>
                      {!readOnly && (
                      <TableCell className="text-right space-x-1">
                        <Button variant="outline" size="sm" onClick={() => setReviewDriver(row)}>
                          SSOT detail
                        </Button>
                        {row.manual_connect_payout_allowed && (
                          <Button size="sm" onClick={() => setPayoutDriver(row)}>
                            Instant cash out
                          </Button>
                        )}
                      </TableCell>
                      )}
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

      {!readOnly && (
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
      )}
    </div>
  );
}
