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
import {
  exportFrAuditCsv,
  exportFrAuditExcel,
  exportFrAuditPdf,
} from '@/lib/financialReconciliationAuditExport';
import type { FinanceMoneyFormat } from '@/hooks/useFinanceReconciliationMoney';
import type { TripFinancialAuditRow } from '@/hooks/useFinanceReconciliation';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';
import { Download, FileSpreadsheet, Printer, Search } from 'lucide-react';
import { reconciliationBadgeVariant } from '@/lib/financeTripReconciliationBadge';

function providerStatusLabel(row: TripFinancialAuditRow): string {
  if (row.provider_state) {
    const verified = row.provider_verification_status
      ? ` — ${row.provider_verification_status}`
      : '';
    return `${row.provider_state}${verified}`;
  }
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
  mode?: 'all' | 'mismatches' | 'resolved' | 'shortfall' | 'missing_captures' | 'missing_releases' | 'recovery' | 'wallet_mismatches' | 'payout_mismatches';
  serviceAreaLabel?: string;
  periodLabel?: string;
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
  serviceAreaLabel = 'all',
  periodLabel,
}: FinancialReconciliationTripsTabProps) {
  const [search, setSearch] = useState('');
  const [drawerTrip, setDrawerTrip] = useState<TripFinancialAuditRow | null>(null);

  const fmt = money.fmt;

  const scopedRows = useMemo(() => {
    if (mode === 'mismatches') {
      return rows.filter((r) =>
        r.capture_mismatch
        || String(r.reconciliation_status?.tone ?? '').toLowerCase() === 'error'
        || String(r.reconciliation_status?.tone ?? '').toLowerCase() === 'red'
        || String(r.reconciliation_status?.label ?? '').toLowerCase().includes('mismatch')
        || String(r.capture_reconciliation_status ?? '').includes('SHORTFALL')
        || String(r.capture_reconciliation_status ?? '').includes('MISSING')
        || String(r.wallet_reconciliation_status ?? '').includes('MISSING')
        || String(r.wallet_reconciliation_status ?? '').includes('OVER')
        || String(r.wallet_reconciliation_status ?? '').includes('UNDER')
        || String(r.payout_reconciliation_status ?? '').includes('MISMATCH'),
      );
    }
    if (mode === 'resolved') {
      return rows.filter((r) =>
        !r.capture_mismatch
        && String(r.reconciliation_status?.label ?? '').toLowerCase().includes('balanced'),
      );
    }
    if (mode === 'shortfall') {
      return rows.filter((r) =>
        r.capture_reconciliation_status === 'CAPTURE_SHORTFALL'
        || (r.capture_variance_pence != null && r.capture_variance_pence < 0)
        || (r.outstanding_pence != null && r.outstanding_pence > 0),
      );
    }
    if (mode === 'missing_captures') {
      return rows.filter((r) => {
        const method = String(r.payment_method ?? '').toLowerCase();
        if (method === 'cash' || method.includes('cash')) return false;
        return r.capture_reconciliation_status === 'CAPTURE_MISSING'
          || r.capture_reconciliation_status === 'CAPTURE_PENDING'
          || r.capture_reconciliation_status === 'PAYMENT_SESSION_CAPTURE_MISMATCH'
          || r.captured_pence == null
          || r.capture_mismatch;
      });
    }
    if (mode === 'missing_releases') {
      return rows.filter((r) =>
        r.release_reconciliation_status === 'RELEASE_PENDING'
        || r.release_reconciliation_status === 'RELEASE_SHORTFALL'
        || r.release_reconciliation_status === 'RELEASE_AMOUNT_UNKNOWN',
      );
    }
    if (mode === 'wallet_mismatches') {
      return rows.filter((r) => {
        const status = String(r.wallet_reconciliation_status ?? '');
        return status.includes('MISSING')
          || status.includes('OVER')
          || status.includes('UNDER')
          || status.includes('DUPLICATE')
          || (r.wallet_variance_pence != null && r.wallet_variance_pence !== 0);
      });
    }
    if (mode === 'payout_mismatches') {
      return rows.filter((r) => {
        const status = String(r.payout_reconciliation_status ?? '');
        return status.includes('MISMATCH')
          || status.includes('FAILED')
          || status.includes('DUPLICATE');
      });
    }
    if (mode === 'recovery') {
      return rows.filter((r) => {
        const label = `${r.reconciliation_status?.label ?? ''} ${r.financial_outcome ?? ''}`.toLowerCase();
        return (r.debt_recovered_pence != null && r.debt_recovered_pence > 0)
          || (r.outstanding_pence != null && r.outstanding_pence > 0)
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
      const session = row.payment_session_id?.toLowerCase() ?? '';
      return code.includes(q) || id.includes(q) || customer.includes(q) || driver.includes(q) || pi.includes(q) || session.includes(q);
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

  const exportMeta = {
    generatedAt: new Date().toISOString(),
    sourceSsot: 'Financial Reconciliation audit (Payment Sessions + trip settlement + Driver Wallet Ledger + Payout Ledger)',
    serviceArea: serviceAreaLabel,
    currency: money.currencyCode ?? 'GBP',
    formulaVersion: 'fr_trip_audit_v1',
    unresolvedMismatches: filtered.filter((r) =>
      r.capture_mismatch
      || String(r.reconciliation_status?.tone ?? '').toLowerCase() === 'red'
      || String(r.reconciliation_status?.tone ?? '').toLowerCase() === 'error',
    ).length,
    periodLabel,
  };

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
            placeholder="Search trip code, customer, driver, session, PI…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            {filtered.length} trip{filtered.length === 1 ? '' : 's'}
          </p>
          {!readOnly && filtered.length > 0 ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => exportFrAuditCsv(filtered, exportMeta)}
              >
                <Download className="mr-1 h-3.5 w-3.5" />
                CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => exportFrAuditExcel(filtered, exportMeta)}
              >
                <FileSpreadsheet className="mr-1 h-3.5 w-3.5" />
                Excel
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => exportFrAuditPdf()}
              >
                <Printer className="mr-1 h-3.5 w-3.5" />
                PDF
              </Button>
            </>
          ) : null}
        </div>
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
                <TableHead>Completed At</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Driver</TableHead>
                <TableHead>Service Area</TableHead>
                <TableHead>Payment Session</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Payment Method</TableHead>
                <TableHead className="text-right">Expected Capture</TableHead>
                <TableHead className="text-right">Authorised</TableHead>
                <TableHead className="text-right">Captured</TableHead>
                <TableHead className="text-right">Released</TableHead>
                <TableHead className="text-right">Refunded</TableHead>
                <TableHead className="text-right">Provider Fee</TableHead>
                <TableHead>Fee Status</TableHead>
                <TableHead className="text-right">ONECAB Gross</TableHead>
                <TableHead className="text-right">ONECAB Net</TableHead>
                <TableHead className="text-right">Driver Net</TableHead>
                <TableHead className="text-right">Wallet Credit</TableHead>
                <TableHead>Payout Status</TableHead>
                <TableHead className="text-right">Capture Variance</TableHead>
                <TableHead className="text-right">Wallet Variance</TableHead>
                <TableHead className="text-right">Payout Variance</TableHead>
                <TableHead>Reconciliation Status</TableHead>
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
                    <TableCell className="text-xs whitespace-nowrap">{row.customer_name ?? '—'}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{row.driver_name ?? '—'}</TableCell>
                    <TableCell className="font-mono text-[10px] whitespace-nowrap">
                      {row.service_area_id ? row.service_area_id.slice(0, 8) : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-[10px] whitespace-nowrap">
                      {row.payment_session_id ? row.payment_session_id.slice(0, 8) : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] whitespace-nowrap">
                        {providerStatusLabel(row)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{row.payment_method ?? '—'}</TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.ps_expected_capture_pence ?? row.final_customer_fare_pence ?? row.final_fare_pence, ccy)}
                    </TableCell>
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
                      {formatNullablePence(row.wallet_credit_pence, ccy)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] whitespace-nowrap">
                        {row.payout_reconciliation_status
                          ?? row.driver_payout?.label
                          ?? row.driver_payout_status
                          ?? '—'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.capture_variance_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.wallet_variance_pence, ccy)}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap">
                      {formatNullablePence(row.payout_variance_pence, ccy)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={reconciliationBadgeVariant(recon?.tone)}
                        className="text-[10px] whitespace-nowrap"
                      >
                        {recon?.label
                          ?? row.capture_reconciliation_status
                          ?? (row.capture_mismatch ? 'Mismatch' : 'Review Required')}
                      </Badge>
                      {row.variance_reason ? (
                        <p className="text-[10px] text-muted-foreground mt-0.5 max-w-[140px]">
                          {row.variance_reason}
                        </p>
                      ) : null}
                      {row.capture_classification ? (
                        <p className="text-[10px] text-muted-foreground">{row.capture_classification}</p>
                      ) : null}
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
                          <Link to={paymentSessionsUrl({
                            paymentSessionId: row.payment_session_id,
                            tripId: row.trip_id,
                          })}>
                            Payment Sessions
                          </Link>
                        </Button>
                        {row.driver_id ? (
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                            <Link to={driverWalletLedgerUrl(row.driver_id)}>Wallet</Link>
                          </Button>
                        ) : null}
                        {row.driver_id ? (
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                            <Link to={payoutLedgerUrl({ driverId: row.driver_id })}>Payout</Link>
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
                <div><span className="text-muted-foreground">Payment session:</span> {drawerTrip.payment_session_id ?? '—'}</div>
                <div><span className="text-muted-foreground">Provider verified:</span> {formatFinanceDateSafe(drawerTrip.provider_verified_at)}</div>
                <div><span className="text-muted-foreground">Captured:</span> {formatNullablePence(drawerTrip.captured_pence, drawerTrip.currency_code)}</div>
                <div><span className="text-muted-foreground">Refunded:</span> {formatNullablePence(drawerTrip.refunded_pence, drawerTrip.currency_code)}</div>
                <div><span className="text-muted-foreground">Driver net:</span> {formatNullablePence(drawerTrip.driver_net_pence, drawerTrip.currency_code)}</div>
                <div><span className="text-muted-foreground">Wallet credit:</span> {formatNullablePence(drawerTrip.wallet_credit_pence, drawerTrip.currency_code)}</div>
                <div><span className="text-muted-foreground">Capture status:</span> {drawerTrip.capture_reconciliation_status ?? '—'}</div>
                <div><span className="text-muted-foreground">Warnings:</span> {(drawerTrip.warnings ?? []).join(', ') || '—'}</div>
              </div>
              <Button asChild>
                <Link to={paymentSessionsUrl({
                  paymentSessionId: drawerTrip.payment_session_id,
                  tripId: drawerTrip.trip_id,
                })}>
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
