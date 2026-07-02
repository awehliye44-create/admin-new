import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { FinanceLedgerPanel } from '@/components/finance/FinanceLedgerPanel';
import { DriverWalletOverviewCards } from '@/components/finance/DriverWalletOverviewCards';
import { DriverWalletAccountingTab } from '@/components/finance/DriverWalletAccountingTab';
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
import { parseDriverWalletLedgerTab, type DriverWalletLedgerTab } from '@/lib/driverWalletLedgerRoutes';

/** Single-driver Stripe payout truth + internal accounting audit. */
export default function DriverWalletLedger() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(
    DEFAULT_SERVICE_AREA_SELECTION,
  );
  const [period, setPeriod] = useState<FinancePeriod>('week');
  const [customDateFrom, setCustomDateFrom] = useState<Date | undefined>(undefined);
  const [customDateTo, setCustomDateTo] = useState<Date | undefined>(undefined);

  const driverId = searchParams.get('driverId');
  const rawTab = searchParams.get('tab');
  const tab = parseDriverWalletLedgerTab(rawTab);

  const periodBounds = useMemo(
    () => resolveFinancePeriodBounds(period, customDateFrom, customDateTo),
    [period, customDateFrom, customDateTo],
  );

  const { data: driver, isLoading, isFetching, refetch } = useDriverWalletSsotDetail(driverId);

  useEffect(() => {
    const canonical = parseDriverWalletLedgerTab(rawTab);
    if (rawTab && rawTab !== canonical) {
      const next = new URLSearchParams(searchParams);
      next.set('tab', canonical);
      setSearchParams(next, { replace: true });
    }
  }, [rawTab, searchParams, setSearchParams]);

  const setTab = (nextTab: DriverWalletLedgerTab) => {
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
  const loadingDetail = (isLoading || isFetching) && !!driverId;

  return (
    <AdminLayout
      title="Driver Wallet Ledger (SSOT)"
      description="Stripe Connect payout truth on Overview — internal ledger and audit history on Accounting and Ledger tabs."
    >
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {driver?.last_synced_at && <FinanceSSOTBadge badge="LIVE" />}
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

        <Tabs value={tab} onValueChange={(v) => setTab(v as DriverWalletLedgerTab)}>
          <TabsList className="flex flex-wrap h-auto gap-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="accounting">Accounting</TabsTrigger>
            <TabsTrigger value="ledger">Ledger</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <DriverWalletOverviewCards
              driver={driver}
              currencyCode={currencyCode}
              regionId={serviceFilter.regionId}
              isLoading={isLoading && !!driverId}
            />
          </TabsContent>

          <TabsContent value="accounting" className="mt-4">
            <DriverWalletAccountingTab
              driver={driver}
              currencyCode={currencyCode}
              regionId={serviceFilter.regionId}
              isLoading={loadingDetail}
            />
          </TabsContent>

          <TabsContent value="ledger" className="mt-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              Audit log only — trip settlements, Stripe transfers/payouts, adjustments, refunds, and admin corrections.
              Not used for driver-facing balances.
            </p>
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
