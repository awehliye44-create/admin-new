import { useEffect, useMemo, useState } from 'react';
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
import { FinanceRecoveryPanel } from '@/components/payment/FinanceRecoveryPanel';
import { FinancialReconciliationRefreshBar } from '@/components/finance/FinancialReconciliationRefreshBar';
import { TripFinanceNoteDialog } from '@/components/payment/TripFinanceNoteDialog';
import { SyncTripPaymentFromStripeButton } from '@/components/payment/SyncTripPaymentFromStripeButton';
import { DriverWalletLedgerLink } from '@/components/finance/DriverWalletLedgerLink';
import { formatFinanceDateSafe } from '@/lib/financialReconciliationGuards';
import type { FinanceMoneyFormat } from '@/hooks/useFinanceReconciliationMoney';
import { useFinanceActionPermission } from '@/hooks/useFinanceActionPermission';
import type { TripFinancialAuditRow } from '@/hooks/useFinanceReconciliation';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';
import type { FinanceRecoveryAction } from '@/components/payment/PaymentControlsCard';
import { Search } from 'lucide-react';
import { reconciliationBadgeVariant } from '@/lib/financeTripReconciliationBadge';

function isDigitalPayment(method: string | null | undefined): boolean {
  const m = String(method ?? '').toLowerCase();
  return m !== '' && m !== 'cash';
}

function providerStatusLabel(row: TripFinancialAuditRow): string {
  return row.provider?.label ?? row.provider_status ?? '—';
}

function canCaptureRow(row: TripFinancialAuditRow): boolean {
  if (!isDigitalPayment(row.payment_method)) return false;
  if ((row.captured_pence ?? 0) > 0) return false;
  if ((row.refunded_pence ?? 0) > 0) return false;
  const status = providerStatusLabel(row).toLowerCase();
  return (
    status.includes('requires_capture')
    || status.includes('authorized')
    || status.includes('pending_capture')
  );
}

function canRefundRow(row: TripFinancialAuditRow): boolean {
  if (!isDigitalPayment(row.payment_method)) return false;
  const captured = row.captured_pence ?? 0;
  const refunded = row.refunded_pence ?? 0;
  return captured > 0 && refunded < captured;
}

type DrawerAction = 'capture' | 'refund' | 'extra_payment' | null;

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
}: FinancialReconciliationTripsTabProps) {
  const { canUseFinanceActions } = useFinanceActionPermission();
  const [search, setSearch] = useState('');
  const [drawerTrip, setDrawerTrip] = useState<TripFinancialAuditRow | null>(null);
  const [drawerAction, setDrawerAction] = useState<DrawerAction>(null);
  const [noteTrip, setNoteTrip] = useState<TripFinancialAuditRow | null>(null);

  const actionsDisabled = readOnly || ssotBadge !== 'LIVE' || !canUseFinanceActions;

  const fmt = money.fmt;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => {
      const code = row.trip_code?.toLowerCase() ?? '';
      const id = row.trip_id.toLowerCase();
      const customer = row.customer_name?.toLowerCase() ?? '';
      const driver = row.driver_name?.toLowerCase() ?? '';
      const pi = row.stripe_payment_intent_id?.toLowerCase() ?? '';
      return code.includes(q) || id.includes(q) || customer.includes(q) || driver.includes(q) || pi.includes(q);
    });
  }, [rows, search]);

  const openDrawer = (row: TripFinancialAuditRow, action: DrawerAction = null) => {
    setDrawerTrip(row);
    setDrawerAction(action);
  };

  const closeDrawer = () => {
    setDrawerTrip(null);
    setDrawerAction(null);
  };

  const mapDrawerAction = (action: DrawerAction): FinanceRecoveryAction | null => {
    if (action === 'extra_payment') return 'extra_payment';
    return null;
  };

  useEffect(() => {
    if (!initialTripId && !initialTripCode) return;
    const match = rows.find(
      (r) =>
        (initialTripId && r.trip_id === initialTripId)
        || (initialTripCode && r.trip_code?.toLowerCase() === initialTripCode.toLowerCase()),
    );
    if (match) {
      openDrawer(match);
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
        label="Trip finance audit — all trips in scope; badges are warnings only, not filters"
      />

      {!canUseFinanceActions && (
        <p className="text-xs text-amber-700">
          Finance payment actions require Financial Reconciliation permission.
        </p>
      )}

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
          <span className="block text-xs">
            Widen the date range above — single-day filters only include trips completed on that calendar day.
          </span>
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Trip ID</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Driver</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Completed</TableHead>
              <TableHead>Payment status</TableHead>
              <TableHead>Stripe status</TableHead>
              <TableHead>Capture status</TableHead>
              <TableHead className="text-right">Customer payable</TableHead>
              <TableHead className="text-right">Customer captured</TableHead>
              <TableHead className="text-right">Driver net</TableHead>
              <TableHead className="text-right">Commission</TableHead>
              <TableHead>Settlement</TableHead>
              <TableHead>Reconciliation</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row) => {
              const digital = isDigitalPayment(row.payment_method);
              const showCapture = digital && canCaptureRow(row);
              const showRefund = digital && canRefundRow(row);
              const recon = row.reconciliation_status;
              return (
                <TableRow key={row.trip_id}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">{row.trip_code ?? row.trip_id.slice(0, 8)}</TableCell>
                  <TableCell className="text-xs">{row.customer_name ?? '—'}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {row.driver_id ? (
                      <DriverWalletLedgerLink driverId={row.driver_id}>{row.driver_name ?? '—'}</DriverWalletLedgerLink>
                    ) : (
                      row.driver_name ?? '—'
                    )}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{formatFinanceDateSafe(row.created_at)}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{formatFinanceDateSafe(row.date)}</TableCell>
                  <TableCell className="text-xs">{row.payment_status ?? row.payment_method ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] whitespace-nowrap">
                      {providerStatusLabel(row)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{row.capture_status ?? '—'}</TableCell>
                  <TableCell className="text-right text-xs whitespace-nowrap">
                    {fmt(row.settlement_total_pence ?? row.customer_paid_pence, row.currency_code)}
                  </TableCell>
                  <TableCell className="text-right text-xs whitespace-nowrap">{fmt(row.captured_pence, row.currency_code)}</TableCell>
                  <TableCell className="text-right text-xs whitespace-nowrap">{fmt(row.driver_net_pence, row.currency_code)}</TableCell>
                  <TableCell className="text-right text-xs whitespace-nowrap">
                    {fmt(row.onecab_gross_commission_pence, row.currency_code)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] whitespace-nowrap">
                      {row.driver_payout?.label ?? row.driver_payout_status ?? '—'}
                    </Badge>
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
                        onClick={() => openDrawer(row)}
                      >
                        View
                      </Button>
                      {digital && (
                        <SyncTripPaymentFromStripeButton
                          tripId={row.trip_id}
                          tripCode={row.trip_code}
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={actionsDisabled}
                          onSynced={onRefresh}
                        />
                      )}
                      {showCapture && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={actionsDisabled}
                          onClick={() => openDrawer(row, 'capture')}
                        >
                          Capture
                        </Button>
                      )}
                      {showRefund && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={actionsDisabled}
                          onClick={() => openDrawer(row, 'refund')}
                        >
                          Refund
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={actionsDisabled}
                        onClick={() => setNoteTrip(row)}
                      >
                        Note
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        </div>
      )}

      <Dialog open={!!drawerTrip} onOpenChange={(open) => !open && closeDrawer()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {drawerTrip && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Trip payment — {drawerTrip.trip_code ?? drawerTrip.trip_id.slice(0, 8)}
                </DialogTitle>
                <DialogDescription>
                  Live Stripe payment state. Manual actions re-read Stripe before mutating backend SSOT.
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-2 text-xs rounded-md border p-3 bg-muted/20">
                <div><span className="text-muted-foreground">Customer:</span> {drawerTrip.customer_name ?? '—'}</div>
                <div><span className="text-muted-foreground">Driver:</span> {drawerTrip.driver_name ?? '—'}</div>
                <div><span className="text-muted-foreground">Captured:</span> {fmt(drawerTrip.captured_pence, drawerTrip.currency_code)}</div>
                <div><span className="text-muted-foreground">Refunded:</span> {fmt(drawerTrip.refunded_pence, drawerTrip.currency_code)}</div>
                <div><span className="text-muted-foreground">Driver net:</span> {fmt(drawerTrip.driver_net_pence, drawerTrip.currency_code)}</div>
                <div><span className="text-muted-foreground">Commission:</span> {fmt(drawerTrip.onecab_gross_commission_pence, drawerTrip.currency_code)}</div>
                <div><span className="text-muted-foreground">Payout:</span> {drawerTrip.driver_payout?.label ?? '—'}</div>
                <div><span className="text-muted-foreground">Provider:</span> {drawerTrip.provider?.label ?? '—'}</div>
              </div>
              <FinanceRecoveryPanel
                tripId={drawerTrip.trip_id}
                tripCode={drawerTrip.trip_code}
                source="financial-reconciliation"
                variant="finance"
                readOnly={actionsDisabled}
                initialAction={mapDrawerAction(drawerAction)}
                initialPaymentAction={drawerAction === 'capture' || drawerAction === 'refund' ? drawerAction : null}
                onActionComplete={onRefresh}
              />
            </>
          )}
        </DialogContent>
      </Dialog>

      {noteTrip && (
        <TripFinanceNoteDialog
          tripId={noteTrip.trip_id}
          tripCode={noteTrip.trip_code}
          open={!!noteTrip}
          onOpenChange={(open) => !open && setNoteTrip(null)}
          onSaved={onRefresh}
        />
      )}
    </div>
  );
}
