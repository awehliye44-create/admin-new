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
import { useState } from 'react';
import { format } from 'date-fns';

function statusBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  const s = status.toLowerCase();
  if (s === 'active') return 'default';
  if (s.includes('restrict') || s.includes('requirements')) return 'destructive';
  return 'secondary';
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

function DifferenceExplainer({ row, currencyCode }: { row: ConnectBalanceAccount; currencyCode: string }) {
  const diff = row.wallet_connect_difference_pence;
  if (diff === 0) {
    return <span className="text-muted-foreground text-xs">Wallet and Connect available match.</span>;
  }
  if (diff > 0) {
    return (
      <span className="text-xs text-amber-700 dark:text-amber-300">
        Connect holds {formatPence(diff, currencyCode)} more than ONECAB wallet — funds may have been
        transferred to Connect before ledger debits, or include prior payouts not yet reflected in wallet.
      </span>
    );
  }
  return (
    <span className="text-xs text-amber-700 dark:text-amber-300">
      ONECAB wallet exceeds Connect available by {formatPence(Math.abs(diff), currencyCode)} — earnings
      recorded in ledger; cash may still be clearing on platform or awaiting transfer to Connect.
    </span>
  );
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
    return <div className="py-8 text-center text-muted-foreground">Loading Stripe Connect balances…</div>;
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Connect balance unavailable</AlertTitle>
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
        <AlertTitle>Visibility only — payout SSOT unchanged</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            <strong>ONECAB Wallet Balance</strong> = ledger entitlement.{' '}
            <strong>ONECAB Available Now</strong> = finance reconciliation withdrawal cap (still used by
            driver app and standard payouts).
          </p>
          <p>
            <strong>Connect Available</strong> / <strong>Connect Pending</strong> show where cash sits on
            Stripe Connect — not labeled as &quot;Available to withdraw&quot; unless finance SSOT allows it.
          </p>
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {accounts.length} Connect account{accounts.length === 1 ? '' : 's'}
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
          Refresh Connect data
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Stripe Connect balances</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Driver</TableHead>
                <TableHead>Connect account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Connect Available</TableHead>
                <TableHead className="text-right">Connect Pending</TableHead>
                <TableHead className="text-right">ONECAB Wallet</TableHead>
                <TableHead className="text-right">ONECAB Available Now</TableHead>
                <TableHead className="text-right">Awaiting Settlement</TableHead>
                <TableHead>Difference</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                    No drivers with Stripe Connect accounts in this filter.
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((row) => (
                  <TableRow key={row.driver_id}>
                    <TableCell>
                      <div className="font-medium">{row.driver_name}</div>
                      <div className="text-xs text-muted-foreground">{row.driver_code ?? row.driver_id.slice(0, 8)}</div>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs">{row.stripe_account_id}</code>
                      <div className="text-xs text-muted-foreground mt-1">
                        {row.payout_schedule_interval ?? '—'} · charges {row.charges_enabled ? 'on' : 'off'} · payouts{' '}
                        {row.payouts_enabled ? 'on' : 'off'}
                      </div>
                      {(row.requirements_due?.length ?? 0) > 0 && (
                        <div className="text-xs text-destructive mt-1">
                          Requirements: {row.requirements_due.join(', ')}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(row.connect_account_status)}>
                        {row.connect_account_status}
                      </Badge>
                      {row.payout_blocked && (
                        <Badge variant="destructive" className="ml-1 mt-1">
                          payout blocked
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatPence(row.connect_available_pence, row.currency ?? currencyCode)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatPence(row.connect_pending_pence, row.currency ?? currencyCode)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatPence(row.wallet_balance_pence, row.currency ?? currencyCode)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatPence(row.onecab_available_now_pence, row.currency ?? currencyCode)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatPence(row.awaiting_settlement_pence, row.currency ?? currencyCode)}
                    </TableCell>
                    <TableCell className="max-w-[200px]">
                      <DifferenceExplainer row={row} currencyCode={row.currency ?? currencyCode} />
                    </TableCell>
                    <TableCell className="text-right space-x-1">
                      <Button variant="outline" size="sm" onClick={() => setReviewDriver(row)}>
                        Review
                      </Button>
                      {row.manual_connect_payout_allowed && (
                        <Button size="sm" onClick={() => setPayoutDriver(row)}>
                          Manual payout
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {reviewDriver && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">
              Review Connect balance — {reviewDriver.driver_name}
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setReviewDriver(null)}>
              Close
            </Button>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 text-sm">
            <Detail label="Driver ID" value={reviewDriver.driver_id} />
            <Detail label="Stripe Connect account" value={reviewDriver.stripe_account_id} mono />
            <Detail label="Account type" value={reviewDriver.connect_account_type ?? '—'} />
            <Detail label="Connect status" value={reviewDriver.connect_account_status} />
            <Detail label="Currency" value={(reviewDriver.currency ?? currencyCode).toUpperCase()} />
            <Detail
              label="Connect Available"
              value={formatPence(reviewDriver.connect_available_pence, reviewDriver.currency ?? currencyCode)}
            />
            <Detail
              label="Connect Pending"
              value={formatPence(reviewDriver.connect_pending_pence, reviewDriver.currency ?? currencyCode)}
            />
            <Detail
              label="ONECAB Wallet Balance"
              value={formatPence(reviewDriver.wallet_balance_pence, reviewDriver.currency ?? currencyCode)}
            />
            <Detail
              label="ONECAB Available Now"
              value={formatPence(reviewDriver.onecab_available_now_pence, reviewDriver.currency ?? currencyCode)}
            />
            <Detail
              label="Awaiting Settlement"
              value={formatPence(reviewDriver.awaiting_settlement_pence, reviewDriver.currency ?? currencyCode)}
            />
            <Detail
              label="Wallet − Connect difference"
              value={formatPence(reviewDriver.wallet_connect_difference_pence, reviewDriver.currency ?? currencyCode)}
            />
            <Detail
              label="Max manual Connect payout"
              value={formatPence(reviewDriver.max_manual_connect_payout_pence, reviewDriver.currency ?? currencyCode)}
            />
            <Detail label="Last transfer ID" value={reviewDriver.last_stripe_transfer_id ?? '—'} mono />
            <Detail
              label="Last transfer"
              value={
                reviewDriver.last_transfer_amount_pence != null
                  ? `${formatPence(reviewDriver.last_transfer_amount_pence, reviewDriver.currency ?? currencyCode)} · ${formatDate(reviewDriver.last_transfer_date)}`
                  : '—'
              }
            />
            <Detail label="Last payout ID" value={reviewDriver.last_payout_id ?? '—'} mono />
            <Detail
              label="Last payout"
              value={
                reviewDriver.last_payout_amount_pence != null
                  ? `${formatPence(reviewDriver.last_payout_amount_pence, reviewDriver.currency ?? currencyCode)} (${reviewDriver.last_payout_status ?? '—'}) · ${formatDate(reviewDriver.last_payout_date)}`
                  : '—'
              }
            />
            <Detail label="Reconciliation" value={reviewDriver.reconciliation_status ?? '—'} />
            {reviewDriver.manual_connect_payout_block_reasons.length > 0 && (
              <div className="md:col-span-2">
                <p className="text-muted-foreground mb-1">Manual payout blocks</p>
                <ul className="list-disc pl-5 space-y-1">
                  {reviewDriver.manual_connect_payout_block_reasons.map((r) => (
                    <li key={r} className="text-destructive">{r}</li>
                  ))}
                </ul>
              </div>
            )}
            {(reviewDriver.in_flight_payouts?.length ?? 0) > 0 && (
              <div className="md:col-span-2">
                <p className="text-muted-foreground mb-1 flex items-center gap-1">
                  <AlertTriangle className="h-4 w-4" />
                  In-flight Connect payouts
                </p>
                <ul className="text-xs space-y-1">
                  {reviewDriver.in_flight_payouts.map((p) => (
                    <li key={p.payout_id}>
                      {p.payout_id} · {formatPence(p.amount_pence, reviewDriver.currency ?? currencyCode)} ·{' '}
                      {p.status}
                      {p.orphan_risk ? ' · orphan risk' : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="md:col-span-2">
              <DifferenceExplainer row={reviewDriver} currencyCode={reviewDriver.currency ?? currencyCode} />
            </div>
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

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className={mono ? 'font-mono text-xs break-all' : ''}>{value}</p>
    </div>
  );
}
