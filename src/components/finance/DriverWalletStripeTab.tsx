import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPence } from '@/hooks/useDriverWallet';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { useConnectPayoutStatus } from '@/hooks/useConnectPayoutStatus';
import { ConnectManualPayoutDialog } from '@/components/finance/ConnectManualPayoutDialog';

import { Loader2 } from 'lucide-react';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 border-b border-border/50 last:border-0 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right font-mono text-xs">{value}</span>
    </div>
  );
}

function isLedgerTransferRow(lr: Record<string, unknown>): boolean {
  const type = String(lr.type ?? '').toLowerCase();
  if (lr.stripe_transfer_id) return true;
  return type.includes('transfer') || type === 'stripe_transfer' || type === 'connect_transfer';
}


function ledgerTripId(lr: Record<string, unknown>): string | null {
  const id = lr.related_trip_id ?? lr.trip_id;
  return id ? String(id) : null;
}

function payoutItemStatus(pi: Record<string, unknown>): string {
  return String(pi.status ?? '—').toLowerCase();
}

export function DriverWalletStripeTab({
  driver,
  currencyCode = 'GBP',
  regionId = null,
  isLoading,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  regionId?: string | null;
  isLoading?: boolean;
}) {
  const [manualPayoutOpen, setManualPayoutOpen] = useState(false);
  const { data: connectStatus } = useConnectPayoutStatus(regionId);

  const connectAccount = useMemo(
    () => connectStatus?.connect_accounts.find((a) => a.driver_id === driver?.driver_id) ?? null,
    [connectStatus, driver?.driver_id],
  );

  const payoutItems = driver?.payout_items ?? [];
  const payoutItemTransfers = payoutItems.filter((pi) => pi.stripe_transfer_id);
  const ledgerTransfers = (driver?.transfer_ledger_rows?.length
    ? driver.transfer_ledger_rows
    : (driver?.ledger_rows ?? []).filter((lr) => isLedgerTransferRow(lr as Record<string, unknown>)));
  const recoveryRows = (driver?.ledger_rows ?? []).filter((lr) => isRecoveryLedgerRow(lr as Record<string, unknown>));
  const bankPayouts = driver?.stripe_connect_payouts ?? [];
  const failedTransfers = payoutItems.filter((pi) => {
    const status = payoutItemStatus(pi as Record<string, unknown>);
    return Boolean(pi.stripe_transfer_id) && (status === 'failed' || status === 'ledger_sync_failed');
  });
  const failedPayouts = payoutItems.filter((pi) => {
    const status = payoutItemStatus(pi as Record<string, unknown>);
    return status === 'failed' || status === 'ledger_sync_failed';
  });

  const latestBank = bankPayouts[0] as Record<string, unknown> | undefined;
  const bankLast4 = latestBank?.bank_last4 ? String(latestBank.bank_last4) : null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading Stripe Connect…
      </div>
    );
  }

  if (!driver) {
    return <p className="text-sm text-muted-foreground py-8">Select a driver to view Stripe Connect.</p>;
  }

  const fmt = (p: number | null | undefined) => (p == null ? '—' : formatPence(p, currencyCode));
  const accountHealthy = driver.reconciliation_status === 'BALANCED';
  const stripeHealthLabel = (() => {
    if (!connectAccount) return 'Unknown';
    if (!connectAccount.charges_enabled || !connectAccount.payouts_enabled) return 'Restricted';
    if (accountHealthy) return 'Healthy';
    return driver.reconciliation_status ?? 'Needs attention';
  })();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Stripe account health</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailRow label="Overall" value={stripeHealthLabel} />
          <DetailRow
            label="Charges enabled"
            value={connectAccount ? (connectAccount.charges_enabled ? 'Yes' : 'No') : '—'}
          />
          <DetailRow
            label="Payouts enabled"
            value={connectAccount ? (connectAccount.payouts_enabled ? 'Yes' : 'No') : '—'}
          />
          <DetailRow label="ONECAB reconciliation" value={driver.reconciliation_status ?? '—'} />
          {connectAccount?.connect_account_status ? (
            <DetailRow label="Stripe account status" value={connectAccount.connect_account_status} />
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Connected account</CardTitle>
          </CardHeader>
          <CardContent>
            <DetailRow label="Account ID" value={driver.connected_account_id ?? '—'} />
            <DetailRow
              label="Account status"
              value={connectAccount?.connect_account_status ?? (accountHealthy ? 'active' : driver.reconciliation_status)}
            />
            <DetailRow
              label="Charges enabled"
              value={connectAccount ? (connectAccount.charges_enabled ? 'Yes' : 'No') : '—'}
            />
            <DetailRow
              label="Payouts enabled"
              value={connectAccount ? (connectAccount.payouts_enabled ? 'Yes' : 'No') : '—'}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Balances</CardTitle>
          </CardHeader>
          <CardContent>
            <DetailRow label="Available balance" value={fmt(driver.stripe_connect_available_pence)} />
            <DetailRow label="Pending balance" value={fmt(driver.stripe_connect_pending_pence)} />
            <DetailRow label="In transit" value={fmt(driver.stripe_in_transit_pence)} />
            <DetailRow label="Cash-out limit (SSOT)" value={fmt(driver.cashout_limit_pence)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Stripe sync & bank</CardTitle>
          </CardHeader>
          <CardContent>
            <DetailRow label="Last Stripe sync" value={formatDate(driver.last_synced_at)} />
            <DetailRow
              label="Stripe sync status"
              value={driver.last_synced_at ? 'Synced' : 'Not synced'}
            />
            <DetailRow
              label="Bank account"
              value={bankLast4 ? `···${bankLast4}` : '—'}
            />
            <DetailRow
              label="Reconciliation"
              value={driver.reconciliation_status}
            />
            {connectAccount?.manual_connect_payout_allowed ? (
              <div className="pt-3">
                <Button size="sm" variant="outline" onClick={() => setManualPayoutOpen(true)}>
                  Instant Connect payout
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {(driver.reconciliation_reasons?.length ?? 0) > 0 && (
        <Card className="border-amber-500/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Reconciliation notes</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="text-sm space-y-1 text-muted-foreground">
              {driver.reconciliation_reasons!.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Transfer history (ledger SSOT)</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Transfer ID</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Trip</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledgerTransfers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">No ledger transfer rows</TableCell>
                </TableRow>
              ) : (
                ledgerTransfers.map((lr, idx) => (
                  <TableRow key={String(lr.id ?? idx)}>
                    <TableCell className="text-xs">{formatDate(String(lr.created_at ?? ''))}</TableCell>
                    <TableCell className="text-xs">{String(lr.type ?? '—')}</TableCell>
                    <TableCell className="font-mono text-xs">{String(lr.stripe_transfer_id ?? '—')}</TableCell>
                    <TableCell className="text-right">{fmt(Number(lr.amount_pence ?? 0))}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {ledgerTripId(lr as Record<string, unknown>)?.slice(0, 8) ?? '—'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Payout-item transfer amounts</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Transfer ID</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payoutItemTransfers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground py-6">No payout-item transfers</TableCell>
                </TableRow>
              ) : (
                payoutItemTransfers.map((pi) => (
                  <TableRow key={String(pi.id)}>
                    <TableCell className="font-mono text-xs">{String(pi.stripe_transfer_id)}</TableCell>
                    <TableCell className="text-right">
                      {fmt(Number(pi.net_driver_payout_pence ?? pi.amount_pence ?? 0))}
                    </TableCell>
                    <TableCell><Badge variant="outline">{String(pi.status ?? '—')}</Badge></TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Weekly bank payout history</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Payout ID</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Initiated</TableHead>
                <TableHead>Arrival</TableHead>
                <TableHead>Bank</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bankPayouts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-6">No bank payouts</TableCell>
                </TableRow>
              ) : (
                bankPayouts.map((sp) => (
                  <TableRow key={String(sp.payout_id)}>
                    <TableCell className="font-mono text-xs">{String(sp.payout_id)}</TableCell>
                    <TableCell className="text-right">{fmt(Number(sp.amount_pence ?? 0))}</TableCell>
                    <TableCell><Badge variant="outline">{String(sp.status ?? '—')}</Badge></TableCell>
                    <TableCell className="text-xs">{formatDate(String(sp.initiated_at ?? ''))}</TableCell>
                    <TableCell className="text-xs">{formatDate(String(sp.arrival_date ?? sp.estimated_arrival_at ?? ''))}</TableCell>
                    <TableCell className="text-xs">{sp.bank_last4 ? `···${String(sp.bank_last4)}` : '—'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {failedTransfers.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-destructive">Failed transfers</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Transfer ID</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {failedTransfers.map((pi) => (
                  <TableRow key={String(pi.id)}>
                    <TableCell className="font-mono text-xs">{String(pi.stripe_transfer_id)}</TableCell>
                    <TableCell className="text-right text-destructive">
                      {fmt(Number(pi.net_driver_payout_pence ?? pi.amount_pence ?? 0))}
                    </TableCell>
                    <TableCell><Badge variant="destructive">{String(pi.status ?? 'failed')}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {failedPayouts.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-destructive">Failed payouts</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payout item</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Transfer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {failedPayouts.map((pi) => (
                  <TableRow key={String(pi.id)}>
                    <TableCell className="font-mono text-xs">{String(pi.id).slice(0, 8)}</TableCell>
                    <TableCell className="text-right text-destructive">
                      {fmt(Number(pi.net_driver_payout_pence ?? pi.amount_pence ?? 0))}
                    </TableCell>
                    <TableCell><Badge variant="destructive">{String(pi.status ?? 'failed')}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{String(pi.stripe_transfer_id ?? '—')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}


      <ConnectManualPayoutDialog
        driver={connectAccount}
        currencyCode={currencyCode}
        open={manualPayoutOpen}
        onOpenChange={setManualPayoutOpen}
        onSuccess={() => setManualPayoutOpen(false)}
      />
    </div>
  );
}
