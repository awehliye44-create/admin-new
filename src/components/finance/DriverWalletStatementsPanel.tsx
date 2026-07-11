import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { downloadCsv, printFinanceReport } from '@/lib/financeExport';
import { Loader2 } from 'lucide-react';

/**
 * Statements / Downloads — display backend period KPIs and export ledger rows.
 * No client money formulas; CSV is a dump of SSOT ledger rows only.
 */
export function DriverWalletStatementsPanel({
  driver,
  currencyCode = 'GBP',
  isLoading,
  mode,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  isLoading?: boolean;
  mode: 'statements' | 'downloads';
}) {
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
        Select a driver to view period statements and downloads.
      </p>
    );
  }

  const kpis = driver.period_kpis;
  const fmt = (p: number | null | undefined) => formatNullablePence(p, currencyCode);
  const periods = [
    ['Today', kpis?.today_earnings_pence],
    ['This week', kpis?.week_earnings_pence],
    ['Last week', kpis?.last_week_earnings_pence],
    ['This month', kpis?.month_earnings_pence],
    ['Last month', kpis?.last_month_earnings_pence],
    ['This year', kpis?.year_earnings_pence],
    ['Last year', kpis?.last_year_earnings_pence],
    ['Lifetime', kpis?.lifetime_earnings_pence],
  ] as const;

  const exportLedgerCsv = () => {
    const rows = (driver.ledger_rows ?? []) as Array<Record<string, unknown>>;
    if (rows.length === 0) return;
    downloadCsv(
      `driver-wallet-ledger-${driver.driver_id}.csv`,
      rows.map((r) => ({
        id: r.id == null ? '' : String(r.id),
        type: r.type == null ? '' : String(r.type),
        amount_pence: r.amount_pence == null ? '' : String(r.amount_pence),
        related_trip_id: r.related_trip_id == null ? '' : String(r.related_trip_id),
        created_at: r.created_at == null ? '' : String(r.created_at),
        description: r.description == null ? '' : String(r.description),
      })),
    );
  };

  return (
    <div className="space-y-4">
      {mode === 'statements' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Period earnings (ledger SSOT)</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            {periods.map(([label, value]) => (
              <div key={label}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-lg font-semibold tabular-nums">{fmt(value)}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{mode === 'downloads' ? 'Downloads' : 'Export'}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={exportLedgerCsv}>
            Export ledger CSV
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => printFinanceReport()}
          >
            Print / PDF statement
          </Button>
          <Button type="button" variant="outline" size="sm" asChild>
            <Link to={`/annual-taxi-report?driverId=${encodeURIComponent(driver.driver_id)}`}>
              Annual report (PDF / CSV)
            </Link>
          </Button>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        PDF/CSV annual reporting for ONECAB and drivers uses the Annual Taxi Report page.
        Wallet balance is never recalculated from trips — only from immutable ledger entries.
      </p>
    </div>
  );
}
