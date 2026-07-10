import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { FinanceLedgerPanel } from '@/components/finance/FinanceLedgerPanel';
import { DriverWalletOverviewCards } from '@/components/finance/DriverWalletOverviewCards';
import { DriverWalletPayoutsTab } from '@/components/finance/DriverWalletPayoutsTab';
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
import { ServiceAreaGatewayStatusFetcher } from '@/components/finance/ServiceAreaGatewayStatusFetcher';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { startAdminPerformanceStep } from '@/lib/recordAdminPerformanceStep';
import { paymentSessionsUrl } from '../../shared/adminPaymentSessionsSSOT';
import { payoutLedgerUrl } from '../../shared/adminPayoutLedgerSSOT';
import type { DriverWalletLedgerFilter } from '@/lib/driverWalletLedgerFilters';

function ledgerFilterForTab(tab: DriverWalletLedgerTab): DriverWalletLedgerFilter {
  if (tab === 'debt') return 'debt_recovery';
  if (tab === 'adjustments') return 'adjustments';
  return 'driver_earnings';
}

/** Balance-affecting wallet movements. Bank transfers owned by Payout Ledger. */
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
    if (!driverId) return;
    const channel = supabase
      .channel(`driver-wallet-ledger-${driverId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'driver_wallet_ledger',
          filter: `driver_id=eq.${driverId}`,
        },
        () => {
          void refetch();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [driverId, refetch]);

  useQuery({
    queryKey: ['service-area-payout-gateway', serviceFilter.serviceAreaId],
    queryFn: async () => {
      if (!serviceFilter.serviceAreaId) return null;
      const { data, error } = await supabase
        .from('service_areas')
        .select('payment_provider, driver_payout_gateway, customer_payment_gateway')
        .eq('id', serviceFilter.serviceAreaId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: Boolean(serviceFilter.serviceAreaId),
    staleTime: 60_000,
  });

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

  const walletPerfRef = useRef<ReturnType<typeof startAdminPerformanceStep> | null>(null);
  useEffect(() => {
    walletPerfRef.current = startAdminPerformanceStep({
      action_name: 'admin_driver_wallet_ledger_load',
    });
  }, []);

  useEffect(() => {
    if (loadingDetail) return;
    walletPerfRef.current?.complete({
      success: !driverId || !!driver,
      error_code: driverId && !driver ? 'driver_wallet_detail_missing' : null,
      metadata: { driver_id: driverId },
    });
    walletPerfRef.current = null;
  }, [loadingDetail, driverId, driver]);

  const renderLedger = (filter: DriverWalletLedgerFilter, hideTabs = true) => (
    <div className="space-y-4">
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
          initialFilter={filter}
          hideFilterTabs={hideTabs}
        />
      ) : (
        <p className="text-sm text-muted-foreground py-8">No ledger entries match the selected filters.</p>
      )}
    </div>
  );

  return (
    <AdminLayout
      title="Driver Wallet Ledger (SSOT)"
      description="Balance-affecting wallet movements. Bank transfers are owned by Payout Ledger; trip accounting audit is Financial Reconciliation."
    >
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {driver?.last_synced_at && <FinanceSSOTBadge badge="LIVE" />}
            <Link to={paymentSessionsUrl()} className="text-xs underline text-muted-foreground">
              Open Payment Sessions
            </Link>
            <Link to="/financial-reconciliation" className="text-xs underline text-muted-foreground">
              Open Financial Reconciliation
            </Link>
            <Link to={payoutLedgerUrl({ driverId: driverId ?? undefined })} className="text-xs underline text-muted-foreground">
              Open Payout Ledger
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ServiceAreaFinanceFilter value={serviceFilter} onChange={setServiceFilter} />
            <DriverSelector
              value={driverId}
              onChange={(id) => setDriver(id)}
              regionId={serviceFilter.regionId}
              serviceAreaId={serviceFilter.serviceAreaId}
              stripeConnectOnly
              fallbackLabel={
                driver?.driver_name
                  ?? (driver?.driver_code ? driver.driver_code : null)
              }
            />
          </div>
        </div>

        <ServiceAreaGatewayStatusFetcher serviceAreaId={serviceFilter.serviceAreaId} />

        <Tabs value={tab} onValueChange={(v) => setTab(v as DriverWalletLedgerTab)}>
          <TabsList className="flex flex-wrap h-auto gap-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="drivers">Drivers</TabsTrigger>
            <TabsTrigger value="ledger">Ledger Entries</TabsTrigger>
            <TabsTrigger value="debt">Debt</TabsTrigger>
            <TabsTrigger value="adjustments">Adjustments</TabsTrigger>
            <TabsTrigger value="payout_allocations">Payout Allocations</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <DriverWalletOverviewCards
              driver={driver}
              driverId={driverId}
              currencyCode={currencyCode}
              isLoading={isLoading && !!driverId}
            />
          </TabsContent>

          <TabsContent value="drivers" className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Select a driver above to load wallet balance, debt, and ledger history for that driver.
            </p>
            <DriverSelector
              value={driverId}
              onChange={(id) => setDriver(id)}
              regionId={serviceFilter.regionId}
              serviceAreaId={serviceFilter.serviceAreaId}
              stripeConnectOnly
            />
          </TabsContent>

          <TabsContent value="ledger" className="mt-4">
            {renderLedger('driver_earnings', false)}
          </TabsContent>

          <TabsContent value="debt" className="mt-4">
            {renderLedger('debt_recovery')}
          </TabsContent>

          <TabsContent value="adjustments" className="mt-4">
            {renderLedger('adjustments')}
          </TabsContent>

          <TabsContent value="payout_allocations" className="mt-4">
            <DriverWalletPayoutsTab
              driver={driver}
              currencyCode={currencyCode}
              isLoading={loadingDetail}
            />
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            {renderLedger(ledgerFilterForTab('history'), false)}
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
