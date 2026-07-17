import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import {
  DEFAULT_SERVICE_AREA_SELECTION,
  type ServiceAreaFinanceSelection,
} from '@/components/finance/ServiceAreaFinanceFilter';
import { CommissionWalletCreditDriverPicker } from '@/components/finance/CommissionWalletCreditDriverPicker';
import { useRegions } from '@/hooks/useRegions';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { invokeCommissionWalletTestAccess } from '@/lib/commissionWalletTestAccessAction';
import { CommissionWalletCampaigns } from '@/components/finance/CommissionWalletCampaigns';
import {
  ADMIN_COMMISSION_CREDIT_KIND,
  ADMIN_COMMISSION_CREDIT_REASON_MIN_LENGTH,
  adminCommissionCreditTypeLabel,
  validateAdminCommissionCreditReason,
  isCommissionWalletWorkflowEnabled,
  COMMISSION_WALLET_FORBIDDEN_ACTIONS,
  COMMISSION_WALLET_DRIVER_PAGE_DISCLAIMER,
  COMMISSION_WALLET_CAMPAIGN_TYPE,
  REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION,
} from '../../shared/commissionWalletSSOT';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { CommissionWalletCreditDriver } from '@/hooks/useCommissionWalletCreditDrivers';
import { commissionWalletCreditDriverLabel } from '@/hooks/useCommissionWalletCreditDrivers';

type OverviewResponse = {
  success?: boolean;
  error?: string;
  phase?: number;
  dispatch_enabled?: boolean;
  deduction_enabled?: boolean;
  revenue_source?: string;
  finance_report?: Record<string, number | string>;
  cards?: Record<string, number>;
  service_areas?: Array<Record<string, unknown>>;
  driver_balances?: Array<Record<string, unknown>>;
  recent_ledger?: Array<Record<string, unknown>>;
  recent_topups?: Array<Record<string, unknown>>;
  recent_admin_audit?: Array<Record<string, unknown>>;
  campaigns?: Array<Record<string, unknown>>;
  campaign_claim_total?: number;
};

function formatMinor(n: unknown, currency = 'USD'): string {
  const v = Number(n) || 0;
  if (currency === '—') return `${v / 100}`;
  return `${currency} ${(v / 100).toFixed(2)}`;
}

export default function CommissionWallet() {
  const queryClient = useQueryClient();
  const { data: regions = [] } = useRegions();
  const { data: allServiceAreas = [] } = useServiceAreas({ activeOnly: true });
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(
    DEFAULT_SERVICE_AREA_SELECTION,
  );
  const [driverId, setDriverId] = useState('');
  const [selectedDriver, setSelectedDriver] = useState<CommissionWalletCreditDriver | null>(null);
  const [creditKind, setCreditKind] = useState<string>(ADMIN_COMMISSION_CREDIT_KIND.OTHER);
  const [amountMajor, setAmountMajor] = useState('10');
  const [reason, setReason] = useState('');
  const [internalReference, setInternalReference] = useState('');
  const [correctionDirection, setCorrectionDirection] = useState<'credit' | 'debit'>('credit');
  const [campaignId, setCampaignId] = useState('');
  const [confirmCreditOpen, setConfirmCreditOpen] = useState(false);

  const [testAccess, setTestAccess] = useState<boolean | null>(null);
  const [testAccessLoading, setTestAccessLoading] = useState(false);
  const [testAccessError, setTestAccessError] = useState<string | null>(null);
  const [testAccessReloadNonce, setTestAccessReloadNonce] = useState(0);

  const serviceAreaId = serviceFilter.serviceAreaId || null;
  const regionId = serviceFilter.regionId || null;

  const regionServiceAreas = useMemo(() => {
    if (!regionId) return [];
    return allServiceAreas.filter((sa) => String(sa.region_id) === String(regionId));
  }, [allServiceAreas, regionId]);

  const overviewQuery = useQuery({
    queryKey: ['admin-commission-wallet-overview', regionId, serviceAreaId, driverId || null],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('admin-commission-wallet-overview', {
        body: {
          region_id: regionId,
          service_area_id: serviceAreaId,
          driver_id: driverId.trim() || null,
          limit: 80,
        },
      });
      if (error) throw error;
      const payload = data as OverviewResponse;
      if (!payload?.success) throw new Error(payload?.error ?? 'Overview failed');
      return payload;
    },
    enabled: Boolean(regionId || serviceAreaId),
  });

  const selectedSa = useMemo(() => {
    if (!serviceAreaId) return null;
    const fromOverview = (overviewQuery.data?.service_areas ?? []).find(
      (a) => String(a.id) === serviceAreaId,
    );
    if (fromOverview) return fromOverview;
    const fromList = allServiceAreas.find((a) => String(a.id) === serviceAreaId);
    if (!fromList) return null;
    const workflow_enabled = isCommissionWalletWorkflowEnabled({
      financial_model: fromList.financial_model,
      commission_wallet_enabled: fromList.commission_wallet_enabled,
    });
    return {
      ...fromList,
      workflow_enabled,
      commission_wallet_currency: fromList.commission_wallet_currency,
      welcome_credit_enabled: fromList.welcome_credit_enabled,
      welcome_credit_amount_minor: fromList.welcome_credit_amount_minor,
      welcome_credit_max_drivers: fromList.welcome_credit_max_drivers,
    };
  }, [overviewQuery.data?.service_areas, serviceAreaId, allServiceAreas]);

  const selectedRegionName = useMemo(() => {
    if (!regionId) return null;
    return regions.find((r) => r.id === regionId)?.name ?? null;
  }, [regions, regionId]);

  const currency = serviceAreaId
    ? String(
      selectedSa?.commission_wallet_currency
        || selectedSa?.currency_code
        || (selectedSa as { region?: { currency_code?: string } } | null)?.region?.currency_code
        || serviceFilter.currencyCode
        || regions.find((r) => r.id === regionId)?.currency_code
        || 'USD',
    ).toUpperCase()
    : '—';

  const balancesByDriverId = useMemo(() => {
    const map: Record<string, { usable_minor: number; currency: string }> = {};
    for (const row of overviewQuery.data?.driver_balances ?? []) {
      const id = String(row.driver_id ?? '');
      if (!id) continue;
      map[id] = {
        usable_minor: Number(row.usable_commission_balance_minor) || 0,
        currency: String(row.currency || currency),
      };
    }
    return map;
  }, [overviewQuery.data?.driver_balances, currency]);

  const welcomeConfiguredMinor = Number(selectedSa?.welcome_credit_amount_minor || 0);
  const welcomeEnabled = Boolean(selectedSa?.welcome_credit_enabled);
  const welcomeMaxDrivers = Number(selectedSa?.welcome_credit_max_drivers || 0);

  useEffect(() => {
    if (
      creditKind === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT
      && welcomeConfiguredMinor > 0
    ) {
      setAmountMajor(String(welcomeConfiguredMinor / 100));
    }
  }, [creditKind, welcomeConfiguredMinor, serviceAreaId]);

  useEffect(() => {
    const id = driverId.trim();
    if (!id) {
      setTestAccess(null);
      setTestAccessError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setTestAccessLoading(true);
      setTestAccessError(null);
      const result = await invokeCommissionWalletTestAccess({ driverId: id });
      if (cancelled) return;
      setTestAccessLoading(false);
      if (!result.ok) {
        setTestAccess(null);
        setTestAccessError(result.message);
        return;
      }
      setTestAccess(result.commission_wallet_test_access);
      setTestAccessError(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [driverId, testAccessReloadNonce]);

  const setCreditRegion = (nextRegionId: string) => {
    const region = regions.find((r) => r.id === nextRegionId);
    setServiceFilter({
      serviceAreaId: null,
      regionId: nextRegionId,
      currencyCode: region?.currency_code ?? null,
    });
    setDriverId('');
    setSelectedDriver(null);
    setCampaignId('');
  };

  const setCreditServiceArea = (nextSaId: string) => {
    const sa = allServiceAreas.find((a) => a.id === nextSaId);
    if (!sa) return;
    const cc = sa.region?.currency_code || sa.currency_code || null;
    setServiceFilter({
      serviceAreaId: sa.id,
      regionId: sa.region_id,
      currencyCode: cc,
    });
    setDriverId('');
    setSelectedDriver(null);
    setCampaignId('');
  };

  const setDriverTestAccess = async (enabled: boolean) => {
    const id = driverId.trim();
    if (!id) {
      toast.error('Enter a driver ID first');
      return;
    }
    setTestAccessLoading(true);
    const result = await invokeCommissionWalletTestAccess({ driverId: id, enabled });
    // Ignore stale responses if the operator changed the driver ID mid-flight.
    if (driverId.trim() !== id) {
      setTestAccessLoading(false);
      return;
    }
    setTestAccessLoading(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    setTestAccess(result.commission_wallet_test_access);
    setTestAccessError(null);
    toast.success(result.commission_wallet_test_access
      ? 'Driver granted Commission Wallet test access'
      : 'Driver test access revoked');
  };

  const promoCampaigns = useMemo(() => {
    const rows = overviewQuery.data?.campaigns ?? [];
    return rows.filter((c) =>
      c.active === true
      && String(c.campaign_type) === COMMISSION_WALLET_CAMPAIGN_TYPE.MANUAL_PROMOTIONAL_CREDIT
    );
  }, [overviewQuery.data?.campaigns]);

  const welcomeCampaigns = useMemo(() => {
    const rows = overviewQuery.data?.campaigns ?? [];
    return rows.filter((c) =>
      c.active === true
      && String(c.campaign_type) === COMMISSION_WALLET_CAMPAIGN_TYPE.WELCOME_CREDIT
    );
  }, [overviewQuery.data?.campaigns]);

  const creditAmountMinor = Math.round(Number(amountMajor) * 100);
  const creditAmountValid = Number.isFinite(creditAmountMinor) && creditAmountMinor > 0;
  const creditReasonValid = validateAdminCommissionCreditReason(reason).ok;
  const creditFormReady = Boolean(
    regionId
    && serviceAreaId
    && selectedSa?.workflow_enabled
    && driverId.trim()
    && creditReasonValid
    && creditAmountValid
    && currency !== '—'
    && !(creditKind === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT && !welcomeEnabled)
    && !(creditKind === ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT && !campaignId.trim()),
  );

  const creditMutation = useMutation({
    mutationFn: async () => {
      if (!serviceAreaId || !selectedSa?.id) throw new Error('Select a service area from the filter');
      if (!driverId.trim()) throw new Error('Driver ID required');
      const reasonGate = validateAdminCommissionCreditReason(reason);
      if (!reasonGate.ok) throw new Error(reasonGate.error);
      const amountMinor = Math.round(Number(amountMajor) * 100);
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
        throw new Error('Amount must be > 0');
      }
      if (creditKind === ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT && !campaignId.trim()) {
        throw new Error('Promotional credit requires an active MANUAL_PROMOTIONAL_CREDIT campaign');
      }
      const { data, error } = await supabase.functions.invoke('admin-commission-wallet-credit', {
        body: {
          driver_id: driverId.trim(),
          service_area_id: String(selectedSa.id),
          amount_minor: amountMinor,
          currency,
          credit_type: creditKind,
          credit_kind: creditKind,
          reason: reasonGate.reason,
          campaign_id: campaignId.trim() || null,
          internal_reference: internalReference.trim() || null,
          correction_direction: creditKind === ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION
            ? correctionDirection
            : undefined,
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'Credit failed');
      return data;
    },
    onSuccess: (data) => {
      setConfirmCreditOpen(false);
      toast.success(
        data.idempotent
          ? 'Credit already applied (idempotent)'
          : 'Commission Wallet credit confirmed',
      );
      setReason('');
      setInternalReference('');
      void queryClient.invalidateQueries({ queryKey: ['admin-commission-wallet-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-commission-wallet-campaigns'] });
      void queryClient.invalidateQueries({ queryKey: ['cw-credit-drivers'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const openCreditConfirmation = () => {
    if (!serviceAreaId || !selectedSa?.id) {
      toast.error('Select a service area from the filter');
      return;
    }
    if (!driverId.trim()) {
      toast.error('Select a driver assigned to this Service Area');
      return;
    }
    const reasonGate = validateAdminCommissionCreditReason(reason);
    if (!reasonGate.ok) {
      toast.error(reasonGate.error);
      return;
    }
    if (!creditAmountValid) {
      toast.error('Amount must be > 0');
      return;
    }
    if (creditKind === ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT && !campaignId.trim()) {
      toast.error('Promotional credit requires an active campaign');
      return;
    }
    if (currency === '—' || !currency.trim()) {
      toast.error('Currency required — select a Commission Wallet service area');
      return;
    }
    setConfirmCreditOpen(true);
  };

  const confirmCredit = () => {
    if (!creditFormReady || currency === '—' || !currency.trim()) {
      toast.error('Complete all required credit fields before confirming');
      setConfirmCreditOpen(false);
      return;
    }
    creditMutation.mutate();
  };

  const cards = overviewQuery.data?.cards ?? {};
  const finance = overviewQuery.data?.finance_report ?? {};

  return (
    <AdminLayout
      title="Commission Wallet"
      description="Africa Driver Commission Wallet — separate from Driver Wallet Ledger. Phase 7: completion deduction + Finance COMMISSION_WALLET_DEDUCTION."
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="outline">Commission Wallet SSOT</Badge>
          <Badge variant="outline">Phase 5 — campaigns</Badge>
          <Badge variant="outline">Phase 6 — dispatch reserve</Badge>
          <Badge variant="outline">Phase 7 — completion deduction</Badge>
          <Badge variant="secondary">{REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION}</Badge>
        </div>

        <Alert>
          <AlertTitle>Isolation</AlertTitle>
          <AlertDescription>
            {COMMISSION_WALLET_DRIVER_PAGE_DISCLAIMER}
            {' '}Forbidden: {COMMISSION_WALLET_FORBIDDEN_ACTIONS.join(', ')}.
            This page never writes to driver_wallet_ledger or payout flows.
            Credits require an explicit service area filter and driver assignment to that area.
          </AlertDescription>
        </Alert>

        {cards.aggregates_truncated && (
          <Alert variant="destructive">
            <AlertTitle>Large ledger scope</AlertTitle>
            <AlertDescription>
              Overview card totals hit the scan cap ({cards.card_rows_scanned ?? '—'} rows).
              Narrow the service area or driver filter for exact totals.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-4 items-end">
          <Button variant="outline" onClick={() => void overviewQuery.refetch()}>
            Refresh overview
          </Button>
          <p className="text-xs text-muted-foreground max-w-xl">
            Select Region → Service Area → Driver in Add Credit below.
            Overview scopes to the selected Service Area.
          </p>
        </div>

        {driverId.trim() && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Phase 3 — Driver app test access</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground max-w-xl">
                Grant internal test drivers read-only Commission Wallet in the driver app.
                Requires SA Commission Wallet enabled. Default off for all drivers.
              </p>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {testAccessLoading
                    ? 'Loading…'
                    : testAccessError
                      ? testAccessError
                      : testAccess === null
                        ? '—'
                        : testAccess
                          ? 'Access ON'
                          : 'Access OFF'}
                </span>
                {testAccessError && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={testAccessLoading}
                    onClick={() => setTestAccessReloadNonce((n) => n + 1)}
                  >
                    Retry
                  </Button>
                )}
                <Switch
                  checked={testAccess === true}
                  disabled={testAccessLoading || testAccess === null || Boolean(testAccessError)}
                  onCheckedChange={(checked) => void setDriverTestAccess(checked)}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {overviewQuery.isError && (
          <Alert variant="destructive">
            <AlertTitle>Overview failed</AlertTitle>
            <AlertDescription>
              {(overviewQuery.error as Error)?.message || 'Could not load Commission Wallet overview.'}
            </AlertDescription>
          </Alert>
        )}

        {overviewQuery.isLoading && (
          <p className="text-sm text-muted-foreground">Loading Commission Wallet overview…</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Purchased balances', cards.purchased_balances_minor],
            ['Promotional balances', cards.promotional_balances_minor],
            ['Reserved commission', cards.reserved_commission_minor],
            ['Commission collected', cards.commission_collected_minor],
            ['Campaign credits', cards.campaign_credits_minor],
            ['Provider top-ups', cards.provider_topups_minor],
            ['Reversals', cards.reversals_minor],
            ['Drivers below minimum', cards.drivers_below_minimum],
            ['Enabled service areas', cards.enabled_service_areas],
            ['Campaign claims', overviewQuery.data?.campaign_claim_total ?? 0],
          ].map(([label, value]) => (
            <Card key={String(label)}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
              </CardHeader>
              <CardContent className="text-xl font-semibold">
                {label === 'Drivers below minimum'
                  || label === 'Enabled service areas'
                  || label === 'Campaign claims'
                  ? String(value ?? 0)
                  : formatMinor(value, currency)}
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Finance — {REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
            <div>
              <div className="text-muted-foreground">Completed driver-collected trips</div>
              <div className="text-lg font-semibold">
                {Number(finance.completed_driver_collected_trips ?? cards.completed_driver_collected_trips ?? 0)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Customer fares reported</div>
              <div className="text-lg font-semibold">
                {formatMinor(
                  finance.total_customer_fares_reported_minor ?? cards.total_customer_fares_reported_minor,
                  currency,
                )}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">ONECAB customer collection</div>
              <div className="text-lg font-semibold">{formatMinor(0, currency)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">ONECAB commission earned</div>
              <div className="text-lg font-semibold">
                {formatMinor(
                  finance.total_onecab_commission_earned_minor ?? cards.commission_collected_minor,
                  currency,
                )}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">ONECAB revenue (commission deducted)</div>
              <div className="text-lg font-semibold">
                {formatMinor(
                  finance.onecab_revenue_minor
                    ?? finance.commission_actually_deducted_minor
                    ?? cards.onecab_revenue_minor
                    ?? cards.commission_collected_minor,
                  currency,
                )}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Commission shortfall</div>
              <div className="text-lg font-semibold">
                {formatMinor(finance.commission_shortfall_minor, currency)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Outstanding reserves</div>
              <div className="text-lg font-semibold">
                {formatMinor(
                  finance.outstanding_reserves_minor ?? cards.outstanding_reserves_minor,
                  currency,
                )}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Driver payout liability</div>
              <div className="text-lg font-semibold">{formatMinor(0, currency)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Provider top-ups</div>
              <div className="text-lg font-semibold">
                {formatMinor(finance.provider_topups_minor ?? cards.provider_topups_minor, currency)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Admin credits</div>
              <div className="text-lg font-semibold">
                {formatMinor(finance.admin_credits_minor, currency)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Campaign / promotional cost</div>
              <div className="text-lg font-semibold">
                {formatMinor(finance.campaign_cost_minor ?? cards.campaign_credits_minor, currency)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Top-up reversals</div>
              <div className="text-lg font-semibold">
                {formatMinor(finance.topup_reversals_minor, currency)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Provider transaction fees</div>
              <div className="text-lg font-semibold">
                {formatMinor(finance.provider_transaction_fees_minor ?? 0, currency)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Commission Wallet liabilities</div>
              <div className="text-lg font-semibold">
                {formatMinor(
                  finance.commission_wallet_liabilities_minor
                    ?? ((Number(cards.purchased_balances_minor) || 0)
                      + (Number(cards.promotional_balances_minor) || 0)),
                  currency,
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add Credit</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <Label>Region (required)</Label>
              <Select
                value={regionId || '__none'}
                onValueChange={(v) => {
                  if (v === '__none') {
                    setServiceFilter(DEFAULT_SERVICE_AREA_SELECTION);
                    setDriverId('');
                    setSelectedDriver(null);
                    return;
                  }
                  setCreditRegion(v);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select region" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Select region…</SelectItem>
                  {regions.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name} ({r.currency_code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Service Area (required)</Label>
              <Select
                value={serviceAreaId || '__none'}
                disabled={!regionId}
                onValueChange={(v) => {
                  if (v === '__none') {
                    setServiceFilter((prev) => ({
                      ...prev,
                      serviceAreaId: null,
                      currencyCode: regions.find((r) => r.id === prev.regionId)?.currency_code ?? null,
                    }));
                    setDriverId('');
                    setSelectedDriver(null);
                    return;
                  }
                  setCreditServiceArea(v);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={regionId ? 'Select service area' : 'Select region first'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Select service area…</SelectItem>
                  {regionServiceAreas.map((sa) => {
                    const cwOn = isCommissionWalletWorkflowEnabled({
                      financial_model: sa.financial_model,
                      commission_wallet_enabled: sa.commission_wallet_enabled,
                    });
                    return (
                      <SelectItem key={sa.id} value={sa.id}>
                        {sa.name}{cwOn ? '' : ' (CW off)'}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {serviceAreaId && !selectedSa?.workflow_enabled && (
                <p className="text-xs text-destructive">
                  Commission Wallet is disabled for this Service Area.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Currency</Label>
              <p className="text-sm text-muted-foreground h-10 flex items-center">
                {currency} (from Service Area / Region — not editable)
              </p>
            </div>

            {serviceAreaId && selectedSa?.workflow_enabled ? (
              <CommissionWalletCreditDriverPicker
                serviceAreaId={serviceAreaId}
                serviceAreaName={selectedSa ? String(selectedSa.name) : null}
                currency={currency === '—' ? 'USD' : currency}
                balancesByDriverId={balancesByDriverId}
                value={driverId || null}
                onChange={(id, driver) => {
                  setDriverId(id || '');
                  setSelectedDriver(driver ?? null);
                }}
              />
            ) : (
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label>Driver</Label>
                <Input
                  disabled
                  placeholder={
                    !regionId
                      ? 'Select a Region first'
                      : !serviceAreaId
                        ? 'Select a Service Area first'
                        : 'Commission Wallet disabled for this Service Area'
                  }
                />
              </div>
            )}

            {!serviceAreaId && regionId && (
              <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
                Select a Service Area to load assigned drivers.
              </p>
            )}
            {serviceAreaId && selectedSa?.workflow_enabled === false && (
              <div className="sm:col-span-2 lg:col-span-3 space-y-2">
                <p className="text-sm text-muted-foreground">
                  No eligible drivers can be credited until Commission Wallet is enabled for this Service Area.
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link to="/service-area-pricing">Open Service Area Pricing</Link>
                </Button>
              </div>
            )}

            <div className="space-y-1">
              <Label>Credit type</Label>
              <Select value={creditKind} onValueChange={(v) => {
                setCreditKind(v);
                setCampaignId('');
                if (
                  v === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT
                  && welcomeConfiguredMinor > 0
                ) {
                  setAmountMajor(String(welcomeConfiguredMinor / 100));
                }
              }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT}>Welcome Credit</SelectItem>
                  <SelectItem value={ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT}>Promotional Credit</SelectItem>
                  <SelectItem value={ADMIN_COMMISSION_CREDIT_KIND.GOODWILL_CREDIT}>Goodwill Credit</SelectItem>
                  <SelectItem value={ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION}>Support Correction</SelectItem>
                  <SelectItem value={ADMIN_COMMISSION_CREDIT_KIND.OTHER}>Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {creditKind === ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION && (
              <div className="space-y-1">
                <Label>Correction direction</Label>
                <Select
                  value={correctionDirection}
                  onValueChange={(v) => setCorrectionDirection(v as 'credit' | 'debit')}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="credit">Credit (compensating)</SelectItem>
                    <SelectItem value="debit">Debit (compensating)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Never edit or delete an original credit — post a separate compensating entry.
                </p>
              </div>
            )}
            {creditKind === ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT && (
              <div className="space-y-1 sm:col-span-2">
                <Label>Promotional campaign (required)</Label>
                <Select value={campaignId || '__none'} onValueChange={(v) => setCampaignId(v === '__none' ? '' : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select MANUAL_PROMOTIONAL_CREDIT campaign" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Select campaign…</SelectItem>
                    {promoCampaigns.map((c) => (
                      <SelectItem key={String(c.id)} value={String(c.id)}>
                        {String(c.campaign_name)} ({Number(c.claim_count) || 0} claims)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {promoCampaigns.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Create an active MANUAL_PROMOTIONAL_CREDIT campaign below first.
                  </p>
                )}
              </div>
            )}
            {creditKind === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT && welcomeCampaigns.length > 0 && (
              <div className="space-y-1 sm:col-span-2">
                <Label>Welcome campaign (optional)</Label>
                <Select value={campaignId || '__auto'} onValueChange={(v) => setCampaignId(v === '__auto' ? '' : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Auto-link if available" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto">Auto-link active WELCOME_CREDIT (if any)</SelectItem>
                    {welcomeCampaigns.map((c) => (
                      <SelectItem key={String(c.id)} value={String(c.id)}>
                        {String(c.campaign_name)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {creditKind === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT && (
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <p className="text-xs text-muted-foreground">
                  Welcome credit requires SA welcome policy enabled
                  {welcomeConfiguredMinor > 0
                    ? ` and amount ${formatMinor(welcomeConfiguredMinor, currency)}`
                    : ''}
                  {welcomeMaxDrivers > 0 ? ` (max ${welcomeMaxDrivers} drivers)` : ''}.
                  {!welcomeEnabled && ' Welcome credit is currently disabled on this service area.'}
                </p>
              </div>
            )}
            <div className="space-y-1">
              <Label>Credit amount ({currency})</Label>
              <Input
                type="number"
                min={0.01}
                step={0.01}
                value={amountMajor}
                onChange={(e) => setAmountMajor(e.target.value)}
                disabled={
                  creditKind === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT && welcomeConfiguredMinor > 0
                }
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Why are you adding this credit? (required)</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="First 100 approved drivers launch promotion"
              />
              <p className="text-xs text-muted-foreground">
                Mandatory. Min {ADMIN_COMMISSION_CREDIT_REASON_MIN_LENGTH} characters.
                Stored permanently on the ledger and admin audit.
              </p>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Internal reference / campaign ID (optional)</Label>
              <Input
                value={internalReference}
                onChange={(e) => setInternalReference(e.target.value)}
                placeholder="Ticket #, campaign code, or internal note"
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <Button
                onClick={openCreditConfirmation}
                disabled={creditMutation.isPending || !creditFormReady}
              >
                Add Credit
              </Button>
              {!regionId && (
                <p className="text-xs text-muted-foreground mt-2">
                  Select a Region, then a Service Area, then a Driver.
                </p>
              )}
              {regionId && !serviceAreaId && (
                <p className="text-xs text-muted-foreground mt-2">
                  Select a Service Area assigned to this Region.
                </p>
              )}
              {serviceAreaId && !selectedSa?.workflow_enabled && (
                <p className="text-xs text-muted-foreground mt-2">
                  Enable Commission Wallet on the Service Area (Pricing page) before crediting.
                </p>
              )}
              {serviceAreaId && selectedSa?.workflow_enabled && !driverId.trim() && (
                <p className="text-xs text-muted-foreground mt-2">
                  Select a driver assigned to this Service Area.
                  {' '}
                  <Link className="underline" to="/drivers">Manage Driver Service Area Assignments</Link>
                </p>
              )}
              {creditKind === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT && !welcomeEnabled && (
                <p className="text-xs text-muted-foreground mt-2">
                  Enable Welcome credit on the Service Area Pricing page first.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <AlertDialog open={confirmCreditOpen} onOpenChange={setConfirmCreditOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Add Commission Wallet Credit</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 text-sm text-foreground">
                  <div className="space-y-1">
                    <p>
                      <span className="text-muted-foreground">Region: </span>
                      {selectedRegionName || '—'}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Service Area: </span>
                      {selectedSa ? String(selectedSa.name) : '—'}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Driver: </span>
                      {selectedDriver
                        ? commissionWalletCreditDriverLabel(selectedDriver)
                        : (driverId.trim() || '—')}
                    </p>
                    {selectedDriver && (
                      <>
                        <p className="text-xs text-muted-foreground font-mono">
                          Driver ID: {selectedDriver.driver_code || selectedDriver.id}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Phone: {selectedDriver.phone || '—'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Current balance:{' '}
                          {formatMinor(
                            selectedDriver.usable_balance_minor,
                            selectedDriver.currency || currency,
                          )}
                        </p>
                      </>
                    )}
                    <p>
                      <span className="text-muted-foreground">Amount: </span>
                      {currency} {(Number(amountMajor) || 0).toFixed(2)}
                      {creditKind === ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION
                        ? ` (${correctionDirection})`
                        : ''}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Credit type: </span>
                      {adminCommissionCreditTypeLabel(creditKind)}
                    </p>
                    {campaignId.trim() && (
                      <p>
                        <span className="text-muted-foreground">Campaign ID: </span>
                        {campaignId.trim()}
                      </p>
                    )}
                    {internalReference.trim() && (
                      <p>
                        <span className="text-muted-foreground">Internal reference: </span>
                        {internalReference.trim()}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <p className="font-medium">Why are you adding this credit?</p>
                    <p className="rounded-md border bg-muted/40 px-3 py-2 whitespace-pre-wrap">
                      {reason.trim()}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Creates an immutable ledger entry. Balance is never set directly.
                    Credits are non-withdrawable and can only pay ONECAB commission.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={creditMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={creditMutation.isPending || !creditFormReady}
                onClick={(e) => {
                  e.preventDefault();
                  confirmCredit();
                }}
              >
                {creditMutation.isPending ? 'Confirming…' : 'Confirm Credit'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <CommissionWalletCampaigns
          serviceAreaId={serviceAreaId}
          currency={currency === '—' ? 'USD' : currency}
          workflowEnabled={Boolean(selectedSa?.workflow_enabled)}
        />

        <Card>
          <CardHeader>
            <CardTitle>Driver balances</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Driver</TableHead>
                  <TableHead>Usable</TableHead>
                  <TableHead>Purchased</TableHead>
                  <TableHead>Promotional</TableHead>
                  <TableHead>Reserved</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overviewQuery.data?.driver_balances ?? []).map((row) => (
                  <TableRow key={`${row.driver_id}-${row.service_area_id}`}>
                    <TableCell className="font-mono text-xs">{String(row.driver_id).slice(0, 8)}…</TableCell>
                    <TableCell>{formatMinor(row.usable_commission_balance_minor, String(row.currency))}</TableCell>
                    <TableCell>{formatMinor(row.purchased_balance_minor, String(row.currency))}</TableCell>
                    <TableCell>{formatMinor(row.promotional_balance_minor, String(row.currency))}</TableCell>
                    <TableCell>{formatMinor(row.reserved_balance_minor, String(row.currency))}</TableCell>
                    <TableCell>
                      {row.below_minimum
                        ? <Badge variant="destructive">Below minimum</Badge>
                        : <Badge variant="secondary">OK</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
                {(overviewQuery.data?.driver_balances ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground text-sm">
                      No commission wallet ledger activity yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent top-ups</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Txn</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overviewQuery.data?.recent_topups ?? []).map((row) => (
                  <TableRow key={String(row.id)}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {row.created_at ? new Date(String(row.created_at)).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className="text-xs">{String(row.status)}</TableCell>
                    <TableCell>{formatMinor(row.amount_minor, String(row.currency))}</TableCell>
                    <TableCell className="text-xs">{String(row.provider)}</TableCell>
                    <TableCell className="font-mono text-xs">{String(row.driver_id).slice(0, 8)}…</TableCell>
                    <TableCell className="font-mono text-xs max-w-[160px] truncate">
                      {String(row.provider_transaction_id ?? '—')}
                    </TableCell>
                  </TableRow>
                ))}
                {(overviewQuery.data?.recent_topups ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground text-sm">
                      No provider top-ups yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent ledger</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Credit type</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overviewQuery.data?.recent_ledger ?? []).map((row) => {
                  const meta = row.metadata && typeof row.metadata === 'object'
                    ? row.metadata as Record<string, unknown>
                    : null;
                  const creditType = String(row.credit_type ?? meta?.credit_type ?? '');
                  return (
                  <TableRow key={String(row.id)}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {row.created_at ? new Date(String(row.created_at)).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className="text-xs">{String(row.entry_type)}</TableCell>
                    <TableCell className="text-xs">
                      {creditType ? adminCommissionCreditTypeLabel(creditType) : '—'}
                    </TableCell>
                    <TableCell>
                      {row.direction === 'debit' ? '−' : '+'}
                      {formatMinor(row.amount_minor, String(row.currency))}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{String(row.driver_id).slice(0, 8)}…</TableCell>
                    <TableCell className="text-xs max-w-[240px] truncate" title={String(row.reason ?? '')}>
                      {String(row.reason ?? '')}
                    </TableCell>
                  </TableRow>
                  );
                })}
                {(overviewQuery.data?.recent_ledger ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground text-sm">
                      No recent ledger entries.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent admin audit</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Credit type</TableHead>
                  <TableHead>Admin</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overviewQuery.data?.recent_admin_audit ?? []).map((row) => (
                  <TableRow key={String(row.id)}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {row.created_at ? new Date(String(row.created_at)).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className="text-xs">{String(row.action ?? '')}</TableCell>
                    <TableCell className="text-xs">
                      {row.credit_type
                        ? adminCommissionCreditTypeLabel(String(row.credit_type))
                        : '—'}
                    </TableCell>
                    <TableCell className="text-xs" title={String(row.admin_user_id ?? '')}>
                      {String(row.admin_display_name ?? '').trim()
                        || (row.admin_user_id ? `${String(row.admin_user_id).slice(0, 8)}…` : '—')}
                    </TableCell>
                    <TableCell>{formatMinor(row.amount_minor, String(row.currency || currency))}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.driver_id ? `${String(row.driver_id).slice(0, 8)}…` : '—'}
                    </TableCell>
                    <TableCell className="text-xs max-w-[240px] truncate" title={String(row.reason ?? '')}>
                      {String(row.reason ?? '')}
                    </TableCell>
                  </TableRow>
                ))}
                {(overviewQuery.data?.recent_admin_audit ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-muted-foreground text-sm">
                      No admin audit rows yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Service areas</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Wallet</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>Provider</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overviewQuery.data?.service_areas ?? []).map((sa) => (
                  <TableRow key={String(sa.id)}>
                    <TableCell>{String(sa.name)}</TableCell>
                    <TableCell className="text-xs">{String(sa.financial_model)}</TableCell>
                    <TableCell>
                      {sa.workflow_enabled
                        ? <Badge>Enabled</Badge>
                        : <Badge variant="outline">Off</Badge>}
                    </TableCell>
                    <TableCell>{String(sa.commission_wallet_currency || sa.currency_code || '—')}</TableCell>
                    <TableCell>{String(sa.commission_topup_provider || '—')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
