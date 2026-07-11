import { Link } from 'react-router-dom';
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { downloadCsv, downloadRecordsAsExcel, printFinanceRecords } from '@/lib/financeExport';
import { FinancePeriodFilter } from '@/components/finance/FinancePeriodFilter';
import type { FinancePeriod } from '@/lib/financePeriodFilter';
import { useFinanceLedgerTransactions } from '@/hooks/useFinanceLedgerTransactions';
import { canonicalDriverWalletTxType } from '@/lib/driverWalletTransactionTypes';
import { Loader2 } from 'lucide-react';

/**
 * Statements — Daily/Weekly/Monthly/Quarterly/Annual/Custom + PDF/CSV/Excel.
 * Exports period-scoped ledger SSOT rows only — no client money formulas.
 */
export function DriverWalletStatementsPanel({
  driver,
  currencyCode = 'GBP',
  isLoading,
  period,
  onPeriodChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
  periodFrom,
  periodTo,
  regionId = null,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  isLoading?: boolean;
  period: FinancePeriod;
  onPeriodChange: (p: FinancePeriod) => void;
  customFrom?: Date;
  customTo?: Date;
  onCustomFromChange: (d: Date | undefined) => void;
  onCustomToChange: (d: Date | undefined) => void;
  periodFrom: string;
  periodTo: string;
  regionId?: string | null;
}) {
  const { data: ledgerRows = [], isLoading: ledgerLoading } = useFinanceLedgerTransactions({
    filter: 'all',
    regionId,
    driverId: driver?.driver_id ?? null,
    limit: 2000,
    from: periodFrom,
    to: periodTo,
  });

  const exportRecords = useMemo(
    () =>
      ledgerRows.map((r) => ({
        date: r.created_at,
        reference: r.ledger_reference ?? '',
        trip_id: r.trip_code ?? r.trip_id ?? '',
        description: r.description ?? r.notes ?? '',
        credit_pence: r.amount_pence > 0 ? r.amount_pence : '',
        debit_pence: r.amount_pence < 0 ? Math.abs(r.amount_pence) : '',
        running_balance_pence: r.running_balance_pence ?? '',
        type: canonicalDriverWalletTxType(r.type),
      })),
    [ledgerRows],
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading statements…
      </div>
    );
  }

  if (!driver) {
    return (
      <p className="text-sm text-muted-foreground py-8">
        Select a driver to generate statements.
      </p>
    );
  }

  const kpis = driver.period_kpis;
  const fmt = (p: number | null | undefined) => formatNullablePence(p, currencyCode);
  const periods = [
    ['Daily (today)', kpis?.today_earnings_pence],
    ['Weekly', kpis?.week_earnings_pence],
    ['Monthly', kpis?.month_earnings_pence],
    ['Quarterly', kpis?.quarter_earnings_pence],
    ['Annual', kpis?.year_earnings_pence],
  ] as const;

  const exportLedgerCsv = () => {
    if (exportRecords.length === 0) return;
    downloadCsv(`driver-wallet-statement-${driver.driver_id}.csv`, exportRecords);
  };

  const exportLedgerExcel = () => {
    if (exportRecords.length === 0) return;
    downloadRecordsAsExcel(
      `driver-wallet-statement-${driver.driver_id}`,
      exportRecords,
      'Driver Statement',
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generate statement</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <FinancePeriodFilter
            period={period}
            onPeriodChange={onPeriodChange}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFromChange={onCustomFromChange}
            onCustomToChange={onCustomToChange}
            variant="statement"
          />
          <p className="text-xs text-muted-foreground">
            Daily / Weekly / Monthly / Quarterly / Annual / Custom — exports use ledger SSOT rows in the selected period
            ({ledgerLoading ? 'loading…' : `${exportRecords.length} rows`}).
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Period earnings (ledger SSOT)</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 grid-cols-2 lg:grid-cols-5">
          {periods.map(([label, value]) => (
            <div key={label}>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-lg font-semibold tabular-nums">{fmt(value)}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Download</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={exportLedgerCsv} disabled={exportRecords.length === 0}>
            CSV
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={exportLedgerExcel} disabled={exportRecords.length === 0}>
            Excel
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => printFinanceRecords(
              `Driver wallet statement — ${driver.driver_name ?? driver.driver_code ?? driver.driver_id}`,
              exportRecords,
            )}
            disabled={exportRecords.length === 0}
          >
            PDF
          </Button>
          <Button type="button" variant="outline" size="sm" asChild>
            <Link to={`/annual-taxi-report?driverId=${encodeURIComponent(driver.driver_id)}`}>
              Annual report
            </Link>
          </Button>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Wallet balance is never recalculated from trips — only from immutable ledger entries.
        Bank transfers remain on Payout Ledger.
      </p>
    </div>
  );
}
