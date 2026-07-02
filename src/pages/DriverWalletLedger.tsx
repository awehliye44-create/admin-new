import { useMemo, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { FinanceLedgerPanel } from '@/components/finance/FinanceLedgerPanel';
import {
  DEFAULT_SERVICE_AREA_SELECTION,
  ServiceAreaFinanceFilter,
  type ServiceAreaFinanceSelection,
} from '@/components/finance/ServiceAreaFinanceFilter';
import { FinancePeriodFilter } from '@/components/finance/FinancePeriodFilter';
import {
  resolveFinancePeriodBounds,
  type FinancePeriod,
} from '@/lib/financePeriodFilter';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Wallet } from 'lucide-react';

/** ONECAB liability ledger — separate from Stripe Connect cash and payout operations. */
export default function DriverWalletLedger() {
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(
    DEFAULT_SERVICE_AREA_SELECTION,
  );
  const [period, setPeriod] = useState<FinancePeriod>('week');
  const [customDateFrom, setCustomDateFrom] = useState<Date | undefined>(undefined);
  const [customDateTo, setCustomDateTo] = useState<Date | undefined>(undefined);

  const periodBounds = useMemo(
    () => resolveFinancePeriodBounds(period, customDateFrom, customDateTo),
    [period, customDateFrom, customDateTo],
  );

  return (
    <AdminLayout
      title="Driver Wallet Ledger"
      description="ONECAB liability only — what we owe drivers from ledger SSOT. Not Stripe Connect cash or lifetime earnings."
    >
      <div className="space-y-6">
        <Alert>
          <Wallet className="h-4 w-4" />
          <AlertTitle>Current ONECAB liability (ledger SSOT)</AlertTitle>
          <AlertDescription>
            Trip earnings, cash commission recovery, debt recovery, adjustments, and payout debits.
            Compare against Stripe Connect on Financial Reconciliation — these are separate buckets.
          </AlertDescription>
        </Alert>

        <div className="flex flex-wrap items-center gap-3">
          <ServiceAreaFinanceFilter value={serviceFilter} onChange={setServiceFilter} />
          <FinancePeriodFilter
            period={period}
            onPeriodChange={setPeriod}
            customFrom={customDateFrom}
            customTo={customDateTo}
            onCustomFromChange={setCustomDateFrom}
            onCustomToChange={setCustomDateTo}
          />
        </div>

        <FinanceLedgerPanel
          serviceFilter={serviceFilter}
          periodFrom={periodBounds.from}
          periodTo={periodBounds.to}
        />
      </div>
    </AdminLayout>
  );
}
