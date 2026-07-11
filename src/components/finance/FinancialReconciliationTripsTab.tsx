import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FinancialReconciliationRefreshBar } from '@/components/finance/FinancialReconciliationRefreshBar';
import { DriverWalletLedgerLink } from '@/components/finance/DriverWalletLedgerLink';
import { formatFinanceDateSafe } from '@/lib/financialReconciliationGuards';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';
import { payoutLedgerUrl } from '../../../shared/adminPayoutLedgerSSOT';
import type { FinanceMoneyFormat } from '@/hooks/useFinanceReconciliationMoney';
import type { TripFinancialAuditRow } from '@/hooks/useFinanceReconciliation';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';
import { Search } from 'lucide-react';
import { reconciliationBadgeVariant } from '@/lib/financeTripReconciliationBadge';

function providerStatusLabel(row: TripFinancialAuditRow): string {
  return row.provider?.label ?? row.provider_status ?? '—';
}

type FinancialReconciliationTripsTabProps = {
  rows: TripFinancialAuditRow[];
  money: FinanceMoneyFormat;
  readOnly?: boolean;
  ssotBadge?: FinanceDataSourceBadge;
  lastSyncedAt?: string | null;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  initialTripId?: string | null;
  initialTripCode?: string | null;
  onInitialTripConsumed?: () => void;
  /** When set, only show matching audit rows (display filter — no money math). */
  mode?: 'all' | 'mismatches' | 'resolved' | 'shortfall' | 'missing_captures' | 'missing_releases' | 'recovery';
};

export function FinancialReconciliationTripsTab({
  rows,
  money,
  readOnly = false,
  ssotBadge = 'LIVE',
  lastSyncedAt = null,
  isRefreshing = false,
  onRefresh,
  initialTripId = null,
  initialTripCode = null,
  onInitialTripConsumed,
  mode = 'all',
}: FinancialReconciliationTripsTabProps) {
  const [search, setSearch] = useState('');
  const [drawerTrip, setDrawerTrip] = useState<TripFinancialAuditRow | null>(null);

  const fmt = money.fmt;

  const scopedRows = useMemo(() => {
    if (mode === 'mismatches') {
      return rows.filter((r) =>
        r.capture_mismatch
        || String(r.reconciliation_status?.tone ?? '').toLowerCase() === 'error'
        || String(r.reconciliation_status?.label ?? '').toLowerCase().includes('mismatch')
        || String(r.reconciliation_status?.label ?? '').toLowerCase().includes('pending'),
      );
    }
    if (mode === 'resolved') {
      return rows.filter((r) =>
        !r.capture_mismatch
        && String(r.reconciliation_status?.label ?? '').toLowerCase().includes('balanced'),
      );
    }
    if (mode === 'shortfall') {
      return rows.filter((r) => Number(r.outstanding_pence ?? 0) > 0);
    }
    if (mode === 'missing_captures') {
      return rows.filter((r) => {
        const label = `${r.reconciliation_status?.label ?? ''} ${r.provider?.label ?? ''} ${r.capture_status ?? ''}`.toLowerCase();
        return r.capture_mismatch
          || (r.captured_pence == null && Number(r.customer_paid_pence ?? r.authorised_pence ?? 0) > 0)
          || label.includes('missing capture')
          || label.includes('pending capture')
          || label.includes('uncaptured');
      });
    }
    if (mode === 'missing_releases') {
      return rows.filter((r) => {
        const label = `${r.reconciliation_status?.label ?? ''} ${r.provider?.label ?? ''}`.toLowerCase();
        return (Number(r.authorised_pence ?? 0) > 0 && r.released_pence == null && r.captured_pence == null)
          || label.includes('missing release')
          || label.includes('unreleased');
      });
    }
    if (mode === 'recovery') {
      return rows.filter((r) => {
        const label = `${r.reconciliation_status?.label ?? ''} ${r.financial_outcome ?? ''}`.toLowerCase();
        return Number(r.debt_recovered_pence ?? 0) > 0
          || Number(r.outstanding_pence ?? 0) > 0
          || label.includes('recovery');
      });
    }
    return rows;
  }, [rows, mode]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scopedRows;
    return scopedRows.filter((row) => {
      const code = row.trip_code?.toLowerCase() ?? '';
      const id = row.trip_id.toLowerCase();
      const customer = row.customer_name?.toLowerCase() ?? '';
      const driver = row.driver_name?.toLowerCase() ?? '';
      const pi = row.stripe_payment_intent_id?.toLowerCase() ?? '';
      return code.includes(q) || id.includes(q) || customer.includes(q) || driver.includes(q) || pi.includes(q);
    });
  }, [scopedRows, search]);

  useEffect(() => {
    if (!initialTripId && !initialTripCode) return;
    const match = rows.find(
      (r) =>
        (initialTripId && r.trip_id === initialTripId)
        || (initialTripCode && r.trip_code?.toLowerCase() === initialTripCode.toLowerCase()),
    );
    if (match) {
      setDrawerTrip(match);
      onInitialTripConsumed?.();
    }
  }, [initialTripId, initialTripCode, rows, onInitialTripConsumed]);

  return (
    <div className="space-y-4">
      <FinancialReconciliationRefreshBar
        badge={isRefreshing ? 'REFRESHING' : ssotBadge}
        lastSyncedAt={lastSyncedAt}
        isRefreshing={isRefreshing}
        readOnly={readOnly}
        onRefresh={onRefresh}
        label="Trip finance audit — comparison only; capture/refund live on Payment Sessions"
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search trip code, customer, driver, PI…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {filtered.length} trip{filtered.length === 1 ? '' : 's'}
        </p>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center space-y-1">
          <span className="block">No trips in selected period{search ? ' matching search' : ''}.</span>
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Trip ID</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead className="text-right">Customer Fare</TableHead>
                <TableHead className="text-right">Ride Fare</TableHead>
                <TableHead className="text-right">Airport</TableHead>
                <TableHead className="text-right">Tips</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Payment status</TableHead>
                <TableHead className="text-right">Authorised</TableHead>
                <TableHead className="text-right">Captured</TableHead>
                <TableHead className="text-right">Released</TableHead>
                <TableHead className="text-right">Refunded</TableHead>
                <TableHead className="text-right">Provider fee</TableHead>
                <TableHead>Fee status</TableHead>
                <TableHead className="text-right">Gross commission</TableHead>
                <TableHead className="text-right">Net commission</TableHead>
                <TableHead className="text-right">Driver Net</TableHead>
                <TableHead className="text-right">Wallet Credit</TableHead>
                <TableHead>Settlement</TableHead>
                <TableHead>Payout</TableHead>
                <TableHead className="text-right">Variance</TableHead>
                <TableHead>Reconciliation</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => {
                const recon = row.reconciliation_status;
                const ccy = row.currency_code ?? 'GBP';
                return (
                  <TableRow key={row.trip_id}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {row.trip_code ?? row.trip_id.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatFinanceDateSafe(row.date)}</TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {fmt(row.settlement_total_pence ?? row.customer_paid_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.ride_fare_pence ?? row.gross_fare_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.airport_charge_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.tip_pence, ccy)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] whitespace-nowrap">
                        {providerStatusLabel(row)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{row.payment_status ?? row.payment_method ?? '—'}</TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.authorised_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.captured_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.released_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.refunded_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.processing_fee_pence, ccy, 'Pending provider fee')}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.fee_status === 'PENDING_PROVIDER_FEE'
                        ? 'Pending provider fee'
                        : row.fee_status === 'CONFIRMED'
                          ? 'Confirmed'
                          : '—'}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.onecab_gross_commission_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.onecab_net_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.driver_net_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(
                        row.wallet_credit_pence ?? row.available_payout_created_pence,
                        ccy,
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] whitespace-nowrap">
                        {row.driver_payout?.label ?? row.driver_payout_status ?? '—'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {row.driver_id ? (
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                          <Link to={payoutLedgerUrl({ driverId: row.driver_id })}>Payout</Link>
                        </Button>
                      ) : '—'}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.variance_pence, ccy)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={reconciliationBadgeVariant(recon?.tone)}
                        className="text-[10px] whitespace-nowrap"
                      >
                        {recon?.label ?? (row.capture_mismatch ? 'Mismatch' : 'Balanced')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => setDrawerTrip(row)}
                        >
                          View
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                          <Link to={paymentSessionsUrl({ tripId: row.trip_id })}>
                            Payment Sessions
                          </Link>
                        </Button>
                        {row.driver_id ? (
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                            <Link to={driverWalletLedgerUrl(row.driver_id)}>Wallet</Link>
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={!!drawerTrip} onOpenChange={(open) => !open && setDrawerTrip(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {drawerTrip && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Trip audit — {drawerTrip.trip_code ?? drawerTrip.trip_id.slice(0, 8)}
                </DialogTitle>
                <DialogDescription>
                  Read-only comparison. Capture, release, and refund run on Payment Sessions.
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-2 text-xs rounded-md border p-3 bg-muted/20">
                <div><span className="text-muted-foreground">Customer:</span> {drawerTrip.customer_name ?? '—'}</div>
                <div>
                  <span className="text-muted-foreground">Driver:</span>{' '}
                  {drawerTrip.driver_id ? (
                    <DriverWalletLedgerLink driverId={drawerTrip.driver_id}>
                      {drawerTrip.driver_name ?? '—'}
                    </DriverWalletLedgerLink>
                  ) : (drawerTrip.driver_name ?? '—')}
                </div>
                <div><span className="text-muted-foreground">Captured:</span> {fmt(drawerTrip.captured_pence, drawerTrip.currency_code)}</div>
                <div><span className="text-muted-foreground">Refunded:</span> {fmt(drawerTrip.refunded_pence, drawerTrip.currency_code)}</div>
                <div><span className="text-muted-foreground">Driver net:</span> {fmt(drawerTrip.driver_net_pence, drawerTrip.currency_code)}</div>
                <div><span className="text-muted-foreground">Net commission:</span> {fmt(drawerTrip.onecab_net_pence, drawerTrip.currency_code)}</div>
                <div><span className="text-muted-foreground">Payout:</span> {drawerTrip.driver_payout?.label ?? '—'}</div>
                <div><span className="text-muted-foreground">Provider:</span> {drawerTrip.provider?.label ?? '—'}</div>
              </div>
              <Button asChild>
                <Link to={paymentSessionsUrl({ tripId: drawerTrip.trip_id })}>
                  Open Payment Sessions for this trip
                </Link>
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
