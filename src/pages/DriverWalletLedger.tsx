import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { FinanceLedgerPanel } from '@/components/finance/FinanceLedgerPanel';
import { DriverWalletOverviewCards } from '@/components/finance/DriverWalletOverviewCards';
import { DriverWalletPayoutsTab } from '@/components/finance/DriverWalletPayoutsTab';
import { DriverWalletStatementsPanel } from '@/components/finance/DriverWalletStatementsPanel';
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
import { supabase } from '@/integrations/supabase/client';
import { startAdminPerformanceStep } from '@/lib/recordAdminPerformanceStep';
import { paymentSessionsUrl } from '../../shared/adminPaymentSessionsSSOT';
import { payoutLedgerUrl } from '../../shared/adminPayoutLedgerSSOT';
import type { DriverWalletLedgerFilter } from '@/lib/driverWalletLedgerFilters';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

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

  const { data: driver, isLoading, isFetching, refetch, isError, error } = useDriverWalletSsotDetail(driverId);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!driverId) return;
    const invalidate = () => {
      void refetch();
      void queryClient.invalidateQueries({ queryKey: ['finance-ledger-transactions'] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot'] });
    };
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
        invalidate,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'payout_items',
          filter: `driver_id=eq.${driverId}`,
        },
        invalidate,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'driver_early_cashouts',
          filter: `driver_id=eq.${driverId}`,
        },
        invalidate,
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [driverId, refetch, queryClient]);

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
    next.set('tab', parseDriverWalletLedgerTab(nextTab));
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
            <TabsTrigger value="transactions">Transactions</TabsTrigger>
            <TabsTrigger value="payouts">Payouts</TabsTrigger>
            <TabsTrigger value="debt_recovery">Debt Recovery</TabsTrigger>
            <TabsTrigger value="statements">Statements</TabsTrigger>
            <TabsTrigger value="downloads">Downloads</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <DriverWalletOverviewCards
              driver={driver}
              driverId={driverId}
              currencyCode={currencyCode}
              isLoading={isLoading && !!driverId}
            />
          </TabsContent>

          <TabsContent value="transactions" className="mt-4">
            {renderLedger('driver_earnings', false)}
          </TabsContent>

          <TabsContent value="payouts" className="mt-4">
            <DriverWalletPayoutsTab
              driver={driver}
              currencyCode={currencyCode}
              isLoading={loadingDetail}
            />
          </TabsContent>

          <TabsContent value="debt_recovery" className="mt-4">
            {renderLedger('debt_recovery')}
          </TabsContent>

          <TabsContent value="statements" className="mt-4">
            <DriverWalletStatementsPanel
              driver={driver}
              currencyCode={currencyCode}
              isLoading={loadingDetail}
              mode="statements"
            />
          </TabsContent>

          <TabsContent value="downloads" className="mt-4">
            <DriverWalletStatementsPanel
              driver={driver}
              currencyCode={currencyCode}
              isLoading={loadingDetail}
              mode="downloads"
            />
          </TabsContent>
        </Tabs>

        {isError && (
          <Alert variant="destructive">
            <AlertTitle>Wallet SSOT sync failed</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <span>{error instanceof Error ? error.message : 'Unable to load wallet'}</span>
              <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry sync</Button>
            </AlertDescription>
          </Alert>
        )}

        {driverId && !isError && (
          <p className="text-xs text-muted-foreground">
            Live SSOT — auto-refreshes on ledger, payout, and cashout changes
            {driver?.last_synced_at ? ` · last synced ${driver.last_synced_at}` : ''}
            {' · '}
            <Link className="underline" to="/annual-taxi-report">Annual driver report</Link>
          </p>
        )}
      </div>
    </AdminLayout>
  );
}
