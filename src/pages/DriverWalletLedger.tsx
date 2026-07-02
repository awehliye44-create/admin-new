import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { FinanceLedgerPanel } from '@/components/finance/FinanceLedgerPanel';
import { DriverWalletOverviewCards } from '@/components/finance/DriverWalletOverviewCards';
import { DriverWalletPayoutsTab } from '@/components/finance/DriverWalletPayoutsTab';
import { DriverWalletStripeTab } from '@/components/finance/DriverWalletStripeTab';
import { DriverWalletHistoryTab } from '@/components/finance/DriverWalletHistoryTab';
import { DriverSelector } from '@/components/finance/DriverSelector';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import { useDriverWalletSsotDetail } from '@/hooks/useDriverWalletSsot';

const TABS = ['overview', 'ledger', 'payouts', 'stripe', 'history'] as const;
type DriverWalletTab = (typeof TABS)[number];

function parseTab(value: string | null): DriverWalletTab {
  if (value && (TABS as readonly string[]).includes(value)) return value as DriverWalletTab;
  return 'overview';
}

/** Single-driver financial truth — wallet, ledger, payouts, and Stripe Connect. */
export default function DriverWalletLedger() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(
    DEFAULT_SERVICE_AREA_SELECTION,
  );
  const [period, setPeriod] = useState<FinancePeriod>('week');
  const [customDateFrom, setCustomDateFrom] = useState<Date | undefined>(undefined);
  const [customDateTo, setCustomDateTo] = useState<Date | undefined>(undefined);

  const driverId = searchParams.get('driverId');
  const tab = parseTab(searchParams.get('tab'));

  const periodBounds = useMemo(
    () => resolveFinancePeriodBounds(period, customDateFrom, customDateTo),
    [period, customDateFrom, customDateTo],
  );

  const { data: driver, isLoading, isFetching, refetch } = useDriverWalletSsotDetail(driverId);

  useEffect(() => {
    if (searchParams.get('tab') === 'connect-balance') {
      const next = new URLSearchParams(searchParams);
      next.set('tab', 'stripe');
      next.delete('connect-balance');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const setTab = (nextTab: DriverWalletTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', nextTab);
    setSearchParams(next, { replace: true });
  };

  const setDriver = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('driverId', id);
    else next.delete('driverId');
    setSearchParams(next, { replace: true });
  };

  const currencyCode = serviceFilter.currencyCode ?? 'GBP';

  return (
    <AdminLayout
      title="Driver Wallet Ledger (SSOT)"
      description="Single-driver financial truth — wallet liability, ledger, payouts, and Stripe Connect."
    >
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {driver?.last_synced_at && (
              <FinanceSSOTBadge badge="LIVE" />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ServiceAreaFinanceFilter value={serviceFilter} onChange={setServiceFilter} />
            <DriverSelector
              value={driverId}
              onChange={(id) => setDriver(id)}
              regionId={serviceFilter.regionId}
            />
          </div>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as DriverWalletTab)}>
          <TabsList className="flex flex-wrap h-auto gap-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="ledger">Ledger</TabsTrigger>
            <TabsTrigger value="payouts">Payouts</TabsTrigger>
            <TabsTrigger value="stripe">Stripe</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <DriverWalletOverviewCards
              driver={driver}
              currencyCode={currencyCode}
              isLoading={isLoading && !!driverId}
            />
          </TabsContent>

          <TabsContent value="ledger" className="mt-4 space-y-4">
            <FinancePeriodFilter
              period={period}
              onPeriodChange={setPeriod}
              customFrom={customDateFrom}
              customTo={customDateTo}
              onCustomFromChange={setCustomDateFrom}
              onCustomToChange={setCustomDateTo}
            />
            {driverId ? (
              <FinanceLedgerPanel
                serviceFilter={serviceFilter}
                periodFrom={periodBounds.from}
                periodTo={periodBounds.to}
                driverId={driverId}
              />
            ) : (
              <p className="text-sm text-muted-foreground py-8">Select a driver to view ledger entries.</p>
            )}
          </TabsContent>

          <TabsContent value="payouts" className="mt-4">
            <DriverWalletPayoutsTab
              driver={driver}
              currencyCode={currencyCode}
              isLoading={(isLoading || isFetching) && !!driverId}
            />
          </TabsContent>

          <TabsContent value="stripe" className="mt-4">
            <DriverWalletStripeTab
              driver={driver}
              currencyCode={currencyCode}
              regionId={serviceFilter.regionId}
              isLoading={(isLoading || isFetching) && !!driverId}
            />
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <DriverWalletHistoryTab
              driver={driver}
              currencyCode={currencyCode}
              isLoading={(isLoading || isFetching) && !!driverId}
            />
          </TabsContent>
        </Tabs>

        {driverId && (
          <p className="text-xs text-muted-foreground">
            SSOT snapshot
            {driver?.last_synced_at ? ` · last synced ${driver.last_synced_at}` : ''}
            {' · '}
            <button type="button" className="underline" onClick={() => refetch()}>Refresh</button>
          </p>
        )}
      </div>
    </AdminLayout>
  );
}
