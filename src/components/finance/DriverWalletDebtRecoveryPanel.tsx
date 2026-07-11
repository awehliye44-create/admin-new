import { Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { FinanceLedgerPanel } from '@/components/finance/FinanceLedgerPanel';
import { FinancePeriodFilter } from '@/components/finance/FinancePeriodFilter';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import type { FinancePeriod } from '@/lib/financePeriodFilter';

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-3 pb-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold tabular-nums mt-0.5">{value}</p>
        {hint ? <p className="text-[10px] text-muted-foreground mt-1">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

/**
 * Debt Recovery — outstanding / recovered / remaining from wallet ledger SSOT.
 * Automatic deductions are system-owned; this tab is display + history only.
 */
export function DriverWalletDebtRecoveryPanel({
  driver,
  currencyCode = 'GBP',
  isLoading,
  driverId,
  serviceFilter,
  period,
  onPeriodChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
  periodFrom,
  periodTo,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  isLoading?: boolean;
  driverId: string | null;
  serviceFilter: ServiceAreaFinanceSelection;
  period: FinancePeriod;
  onPeriodChange: (p: FinancePeriod) => void;
  customFrom?: Date;
  customTo?: Date;
  onCustomFromChange: (d: Date | undefined) => void;
  onCustomToChange: (d: Date | undefined) => void;
  periodFrom: string;
  periodTo: string;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading debt recovery…
      </div>
    );
  }

  if (!driver && !driverId) {
    return (
      <p className="text-sm text-muted-foreground py-8">
        Select a driver to view debt recovery.
      </p>
    );
  }

  const debt = driver?.debt_recovery;
  const fmt = (p: number | null | undefined) => formatNullablePence(p, currencyCode);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Outstanding Debt"
          value={fmt(debt?.outstanding_debt_pence)}
          hint="Lifetime cash-commission debt created"
        />
        <Metric label="Recovered Amount" value={fmt(debt?.recovered_amount_pence)} />
        <Metric
          label="Remaining Debt"
          value={fmt(debt?.remaining_debt_pence ?? driver?.recovery_debt_pence)}
          hint="Open debt still on the wallet"
        />
        <Metric
          label="Recovery %"
          value={debt?.recovery_percent != null ? `${debt.recovery_percent}%` : '—'}
        />
      </div>

      <Card>
        <CardContent className="pt-3 pb-3">
          <p className="text-xs text-muted-foreground">Automatic deductions</p>
          <p className="text-sm mt-1">
            System-owned: future trip credits automatically reduce remaining cash-commission debt until zero.
            This tab displays the result — it does not invent or execute recovery rules.
          </p>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        This page does not invent debt from trips or Payment Sessions.
      </p>

      <div>
        <h3 className="text-sm font-medium mb-2">Recovery History</h3>
        <FinancePeriodFilter
          period={period}
          onPeriodChange={onPeriodChange}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={onCustomFromChange}
          onCustomToChange={onCustomToChange}
        />
        {driverId ? (
          <div className="mt-3">
            <FinanceLedgerPanel
              serviceFilter={serviceFilter}
              periodFrom={periodFrom}
              periodTo={periodTo}
              driverId={driverId}
              initialFilter="debt_recovery"
              hideFilterTabs
              variant="driver_wallet"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
