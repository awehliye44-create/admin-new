import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { FinanceLedgerPanel } from '@/components/finance/FinanceLedgerPanel';
import { DriverWalletOverviewCards } from '@/components/finance/DriverWalletOverviewCards';
import { DriverWalletStatementsPanel } from '@/components/finance/DriverWalletStatementsPanel';
import { DriverWalletDriverList } from '@/components/finance/DriverWalletDriverList';
import { DriverWalletFleetOverviewCards } from '@/components/finance/DriverWalletFleetOverviewCards';
import { DriverWalletAccountHeader } from '@/components/finance/DriverWalletAccountHeader';
import { DriverWalletPeriodWidgetCards } from '@/components/finance/DriverWalletPeriodWidgetCards';
import { DriverWalletSettlementTab } from '@/components/finance/DriverWalletSettlementTab';
import { DriverWalletCommissionTab } from '@/components/finance/DriverWalletCommissionTab';
import { DriverWalletDebtRecoveryPanel } from '@/components/finance/DriverWalletDebtRecoveryPanel';
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

/** Driver money SSOT. Customer payment → Payment Sessions; bank transfers → Payout Ledger. */
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

  const customRangeApplied = period !== 'custom' || Boolean(customDateFrom && customDateTo);
  const periodBounds = useMemo(() => {
    if (period === 'custom' && (!customDateFrom || !customDateTo)) {
      return {
        period,
        from: '',
        to: '',
        label: 'Custom — select From / To and Apply',
      } as const;
    }
    return resolveFinancePeriodBounds(period, customDateFrom, customDateTo);
  }, [period, customDateFrom, customDateTo]);

  const { data: driver, isLoading, isFetching, refetch, isError, error } = useDriverWalletSsotDetail(driverId);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!driverId) return;
    const invalidate = () => {
      void refetch();
      void queryClient.invalidateQueries({ queryKey: ['finance-ledger-transactions'] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot'] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot-detail', driverId] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-summary'] });
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
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'driver_earning_settlement',
          filter: `driver_id=eq.${driverId}`,
        },
        invalidate,
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [driverId, refetch, queryClient]);

  /** Driver list live balances — invalidate on any wallet ledger / settlement change. */
  useEffect(() => {
    if (driverId) return;
    const invalidateList = () => {
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot'] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot-all'] });
    };
    const channel = supabase
      .channel('driver-wallet-ledger-list')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'driver_wallet_ledger' },
        invalidateList,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'driver_earning_settlement' },
        invalidateList,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'payout_items' },
        invalidateList,
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [driverId, queryClient]);

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
    if (nextTab === 'drivers') {
      next.delete('driverId');
      next.set('tab', 'drivers');
    } else {
      const canonical = parseDriverWalletLedgerTab(nextTab);
      next.set('tab', canonical);
      // Statements only supports Daily/Weekly/Monthly/Quarterly/Annual/Custom.
      if (canonical === 'statements') {
        const statementPeriods = new Set(['today', 'week', 'month', 'quarter', 'year', 'custom']);
        if (!statementPeriods.has(period)) {
          setPeriod('week');
        }
      }
    }
    setSearchParams(next, { replace: true });
  };

  const setDriver = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) {
      next.set('driverId', id);
      if (!next.get('tab') || next.get('tab') === 'drivers') {
        next.set('tab', 'overview');
      }
    } else {
      next.delete('driverId');
      next.set('tab', 'drivers');
    }
    setSearchParams(next, { replace: true });
  };

  const currencyCode = serviceFilter.currencyCode ?? 'GBP';
  const loadingDetail = (isLoading || isFetching) && !!driverId;
  /** Level 1 = fleet list; Level 2 = individual driver account. Never mix. */
  const showDriverList = !driverId;

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
      {driverId ? (
        customRangeApplied ? (
          <FinanceLedgerPanel
            serviceFilter={serviceFilter}
            periodFrom={periodBounds.from}
            periodTo={periodBounds.to}
            driverId={driverId}
            initialFilter={filter}
            hideFilterTabs={hideTabs}
            variant="driver_wallet"
          />
        ) : (
          <p className="text-sm text-muted-foreground py-8">
            Select a custom From / To range and press Apply to load transactions.
          </p>
        )
      ) : (
        <p className="text-sm text-muted-foreground py-8">Select a driver to view wallet transactions.</p>
      )}
    </div>
  );

  return (
    <AdminLayout
      title="Driver Wallet Ledger (SSOT)"
      description="Single source of truth for driver money. Customer payment is Payment Sessions; provider audit is Financial Reconciliation; bank transfers are Payout Ledger."
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
            {driverId ? (
              <Button variant="outline" size="sm" onClick={() => setDriver(null)}>
                Back to driver list
              </Button>
            ) : null}
          </div>
        </div>

        <ServiceAreaGatewayStatusFetcher serviceAreaId={serviceFilter.serviceAreaId} />

        {showDriverList ? (
          <div className="space-y-6">
            <DriverWalletFleetOverviewCards
              regionId={serviceFilter.regionId}
              currencyCode={currencyCode}
            />
            <DriverWalletDriverList
              regionId={serviceFilter.regionId}
              currencyCode={currencyCode}
              selectedDriverId={null}
              onSelectDriver={(id) => setDriver(id)}
            />
          </div>
        ) : (
          <>
            {driver ? <DriverWalletAccountHeader driver={driver} currencyCode={currencyCode} /> : null}

            <div className="space-y-3">
              <FinancePeriodFilter
                period={period}
                onPeriodChange={setPeriod}
                customFrom={customDateFrom}
                customTo={customDateTo}
                onCustomFromChange={setCustomDateFrom}
                onCustomToChange={setCustomDateTo}
              />
              <DriverWalletPeriodWidgetCards
                driverId={driverId}
                serviceAreaId={serviceFilter.serviceAreaId ?? driver?.service_area_id ?? null}
                currencyCode={currencyCode}
                period={period}
                periodFrom={periodBounds.from}
                periodTo={periodBounds.to}
                periodLabel={periodBounds.label}
                enabled={customRangeApplied}
              />
            </div>

            <Tabs value={tab === 'drivers' || tab === 'payouts' ? 'overview' : tab} onValueChange={(v) => setTab(v as DriverWalletLedgerTab)}>
              <TabsList className="flex flex-wrap h-auto gap-1">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="settlement">Settlement</TabsTrigger>
                <TabsTrigger value="commission">Commission</TabsTrigger>
                <TabsTrigger value="transactions">Transactions</TabsTrigger>
                <TabsTrigger value="debt_recovery">Debt Recovery</TabsTrigger>
                <TabsTrigger value="statements">Statements</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="mt-4">
                <DriverWalletOverviewCards
                  driver={driver}
                  driverId={driverId}
                  currencyCode={currencyCode}
                  isLoading={isLoading && !!driverId}
                />
              </TabsContent>

              <TabsContent value="settlement" className="mt-4">
                <DriverWalletSettlementTab
                  driver={driver}
                  currencyCode={currencyCode}
                  isLoading={loadingDetail}
                />
              </TabsContent>

              <TabsContent value="commission" className="mt-4">
                <DriverWalletCommissionTab
                  driver={driver}
                  currencyCode={currencyCode}
                  isLoading={loadingDetail}
                />
              </TabsContent>

              <TabsContent value="transactions" className="mt-4">
                {renderLedger('all', false)}
              </TabsContent>

              <TabsContent value="debt_recovery" className="mt-4">
                <DriverWalletDebtRecoveryPanel
                  driver={driver}
                  currencyCode={currencyCode}
                  isLoading={loadingDetail}
                  driverId={driverId}
                  serviceFilter={serviceFilter}
                  period={period}
                  onPeriodChange={setPeriod}
                  customFrom={customDateFrom}
                  customTo={customDateTo}
                  onCustomFromChange={setCustomDateFrom}
                  onCustomToChange={setCustomDateTo}
                  periodFrom={periodBounds.from}
                  periodTo={periodBounds.to}
                />
              </TabsContent>

              <TabsContent value="statements" className="mt-4">
                <DriverWalletStatementsPanel
                  driver={driver}
                  currencyCode={currencyCode}
                  isLoading={loadingDetail}
                  period={period}
                  onPeriodChange={setPeriod}
                  customFrom={customDateFrom}
                  customTo={customDateTo}
                  onCustomFromChange={setCustomDateFrom}
                  onCustomToChange={setCustomDateTo}
                  periodFrom={periodBounds.from}
                  periodTo={periodBounds.to}
                  regionId={serviceFilter.regionId}
                />
              </TabsContent>
            </Tabs>
          </>
        )}

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
            Live SSOT — auto-refreshes on ledger, settlement, payout, and cashout changes
            {driver?.last_synced_at ? ` · last synced ${driver.last_synced_at}` : ''}
            {' · '}
            <Link className="underline" to="/annual-taxi-report">Annual driver report</Link>
          </p>
        )}
      </div>
    </AdminLayout>
  );
}
