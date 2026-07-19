import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Wallet, Info, Loader2, Save } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  COMMISSION_WALLET_PHASE8_PILOT,
  CUSTOMER_PAYMENT_POLICY,
  DEFAULT_CASH_UPFRONT_POLICY_NOTICE,
  PHASE4_SUPPORTED_TOPUP_PROVIDERS,
  SERVICE_AREA_FINANCIAL_MODEL,
  isCommissionWalletWorkflowEnabled,
  planCommissionWalletServiceAreaEnablement,
  type CommissionWalletRolloutState,
} from '../../../shared/commissionWalletSSOT';

export type ServiceAreaCommissionWalletFormState = {
  financial_model: string;
  commission_wallet_enabled: boolean;
  commission_reserve_enabled: boolean;
  commission_wallet_currency: string;
  commission_topup_provider: string;
  commission_wallet_topup_enabled: boolean;
  commission_wallet_minimum_balance_minor: number;
  customer_payment_policy: string;
  cash_upfront_policy_notice: string;
  welcome_credit_enabled: boolean;
  welcome_credit_amount_minor: number;
  welcome_credit_max_drivers: number;
};

function defaultForm(regionCurrency?: string): ServiceAreaCommissionWalletFormState {
  return {
    financial_model: SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED,
    commission_wallet_enabled: false,
    commission_reserve_enabled: false,
    commission_wallet_currency: (regionCurrency || '').toUpperCase(),
    commission_topup_provider: '',
    commission_wallet_topup_enabled: false,
    commission_wallet_minimum_balance_minor: 0,
    customer_payment_policy: CUSTOMER_PAYMENT_POLICY.PLATFORM_PREPAID,
    cash_upfront_policy_notice: DEFAULT_CASH_UPFRONT_POLICY_NOTICE,
    welcome_credit_enabled: false,
    welcome_credit_amount_minor: 0,
    welcome_credit_max_drivers: 0,
  };
}

interface Props {
  serviceAreaId: string;
  serviceAreaName?: string;
  regionCurrency?: string;
}

export function ServiceAreaCommissionWalletConfig({
  serviceAreaId,
  serviceAreaName,
  regionCurrency,
}: Props) {
  const [value, setValue] = useState<ServiceAreaCommissionWalletFormState>(() =>
    defaultForm(regionCurrency),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [rollout, setRollout] = useState<CommissionWalletRolloutState | null>(null);

  const enabled = isCommissionWalletWorkflowEnabled({
    financial_model: value.financial_model,
    commission_wallet_enabled: value.commission_wallet_enabled,
  });

  const enablePlan = planCommissionWalletServiceAreaEnablement({
    serviceAreaId,
    enabling: true,
    rollout,
  });
  const pilotLockBlocksEnable = enablePlan.ok === false;

  const load = useCallback(async () => {
    setIsLoading(true);
    setHasChanges(false);
    try {
      const [{ data, error }, { data: rolloutRow, error: rolloutError }] = await Promise.all([
        supabase
          .from('service_areas')
          .select(
            'financial_model, commission_wallet_enabled, commission_reserve_enabled, commission_wallet_currency, commission_topup_provider, commission_wallet_topup_enabled, commission_wallet_minimum_balance_minor, customer_payment_policy, cash_upfront_policy_notice, welcome_credit_enabled, welcome_credit_amount_minor, welcome_credit_max_drivers',
          )
          .eq('id', serviceAreaId)
          .maybeSingle(),
        supabase
          .from('commission_wallet_rollout')
          .select('pilot_service_area_id, multi_sa_unlocked')
          .eq('id', true)
          .maybeSingle(),
      ]);
      if (error) throw error;
      if (rolloutError) {
        console.warn('[ServiceAreaCommissionWalletConfig] rollout', rolloutError);
        setRollout(null);
      } else {
        setRollout(
          rolloutRow
            ? {
                pilot_service_area_id: String(rolloutRow.pilot_service_area_id ?? ''),
                multi_sa_unlocked: Boolean(rolloutRow.multi_sa_unlocked),
              }
            : null,
        );
      }
      setValue({
        financial_model: String(data?.financial_model || SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED),
        commission_wallet_enabled: Boolean(data?.commission_wallet_enabled),
        commission_reserve_enabled: false,
        commission_wallet_currency: String(
          data?.commission_wallet_currency || regionCurrency || '',
        ).toUpperCase(),
        commission_topup_provider: String(data?.commission_topup_provider || ''),
        commission_wallet_topup_enabled: Boolean(data?.commission_wallet_topup_enabled),
        commission_wallet_minimum_balance_minor: Number(data?.commission_wallet_minimum_balance_minor || 0),
        customer_payment_policy: String(
          data?.customer_payment_policy || CUSTOMER_PAYMENT_POLICY.PLATFORM_PREPAID,
        ),
        cash_upfront_policy_notice: String(
          data?.cash_upfront_policy_notice || DEFAULT_CASH_UPFRONT_POLICY_NOTICE,
        ),
        welcome_credit_enabled: Boolean(data?.welcome_credit_enabled),
        welcome_credit_amount_minor: Number(data?.welcome_credit_amount_minor || 0),
        welcome_credit_max_drivers: Number(data?.welcome_credit_max_drivers || 0),
      });
    } catch (err) {
      console.error('[ServiceAreaCommissionWalletConfig] load', err);
      toast.error('Failed to load Commission Wallet settings');
      setValue(defaultForm(regionCurrency));
    } finally {
      setIsLoading(false);
    }
  }, [serviceAreaId, regionCurrency]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (partial: Partial<ServiceAreaCommissionWalletFormState>) => {
    setValue((prev) => {
      let next = { ...prev, ...partial };
      if (next.financial_model === SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED) {
        next = {
          ...next,
          commission_wallet_enabled: false,
          commission_reserve_enabled: false,
          customer_payment_policy: CUSTOMER_PAYMENT_POLICY.PLATFORM_PREPAID,
        };
      }
      if (
        next.financial_model === SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
        && next.commission_wallet_enabled
        && !next.commission_wallet_currency
      ) {
        next.commission_wallet_currency = (regionCurrency || 'USD').toUpperCase();
      }
      if (
        next.financial_model === SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
        && next.commission_wallet_enabled
        && !next.cash_upfront_policy_notice
      ) {
        next.cash_upfront_policy_notice = DEFAULT_CASH_UPFRONT_POLICY_NOTICE;
      }
      if (!next.commission_wallet_enabled) {
        next.commission_reserve_enabled = false;
        next.commission_wallet_topup_enabled = false;
      }
      if (next.commission_wallet_topup_enabled && !next.commission_wallet_enabled) {
        next.commission_wallet_topup_enabled = false;
      }
      return next;
    });
    setHasChanges(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const enabling = value.commission_wallet_enabled === true;
      const gate = planCommissionWalletServiceAreaEnablement({
        serviceAreaId,
        enabling,
        rollout,
      });
      if (!gate.ok) {
        toast.error((gate as { ok: false; error: string }).error);
        return;
      }
      const providerRaw = String(value.commission_topup_provider || '').trim().toLowerCase();
      const provider =
        !providerRaw
          ? null
          : (PHASE4_SUPPORTED_TOPUP_PROVIDERS as readonly string[]).includes(providerRaw)
            ? providerRaw
            : null;
      if (providerRaw && !provider) {
        toast.error('Only WaafiPay sandbox is supported for Commission Wallet top-ups right now.');
        return;
      }
      if (value.commission_wallet_topup_enabled && !provider) {
        toast.error('Enable a valid top-up provider before turning on driver Top Up.');
        return;
      }
      const payload = {
        financial_model: value.financial_model,
        commission_wallet_enabled: value.commission_wallet_enabled,
        commission_reserve_enabled: false,
        commission_wallet_currency: value.commission_wallet_enabled
          ? (value.commission_wallet_currency || regionCurrency || 'USD').toUpperCase()
          : value.commission_wallet_currency || null,
        commission_topup_provider: value.commission_wallet_enabled ? provider : null,
        commission_wallet_topup_enabled:
          value.commission_wallet_enabled && value.commission_wallet_topup_enabled && Boolean(provider),
        commission_wallet_minimum_balance_minor: Math.max(
          0,
          Math.round(value.commission_wallet_minimum_balance_minor || 0),
        ),
        customer_payment_policy: value.customer_payment_policy,
        cash_upfront_policy_notice: value.cash_upfront_policy_notice || null,
        welcome_credit_enabled: value.welcome_credit_enabled,
        welcome_credit_amount_minor: Math.max(0, Math.round(value.welcome_credit_amount_minor || 0)),
        welcome_credit_max_drivers: Math.max(0, Math.round(value.welcome_credit_max_drivers || 0)),
      };
      const { error } = await supabase
        .from('service_areas')
        .update(payload as never)
        .eq('id', serviceAreaId);
      if (error) throw error;
      toast.success('Commission Wallet settings saved');
      setHasChanges(false);
      await load();
    } catch (err: unknown) {
      console.error('[ServiceAreaCommissionWalletConfig] save', err);
      toast.error(err instanceof Error ? err.message : 'Failed to save Commission Wallet settings');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-5 w-5 text-primary" />
          Commission Wallet (Africa)
        </CardTitle>
        <CardDescription>
          Explicit Service Area assignment only — never inferred from country or currency.
          {serviceAreaName ? ` Config for ${serviceAreaName}.` : ''}
          {' '}Driver Top Up requires an explicit toggle plus a configured provider. Pre-trip reservation is disabled.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            Workflow active only when financial model is DRIVER_COLLECTED_COMMISSION_WALLET
            and Commission Wallet is enabled. UK/EU PLATFORM_COLLECTED areas must keep this off.
            {rollout && rollout.multi_sa_unlocked !== true ? (
              <>
                {' '}Phase 8 pilot lock: only{' '}
                <strong>{COMMISSION_WALLET_PHASE8_PILOT.service_area_name}</strong>
                {' '}({COMMISSION_WALLET_PHASE8_PILOT.region_name}) may enable until reconciliation.
              </>
            ) : null}
          </AlertDescription>
        </Alert>

        {pilotLockBlocksEnable && !value.commission_wallet_enabled ? (
          <Alert variant="destructive">
            <AlertDescription>
              {enablePlan.ok === false ? enablePlan.error : 'Pilot lock blocks enablement.'}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-2">
          <Label>Financial model</Label>
          <Select
            value={value.financial_model}
            onValueChange={(v) => patch({ financial_model: v })}
            disabled={isSaving || (pilotLockBlocksEnable && !value.commission_wallet_enabled)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED}>
                PLATFORM_COLLECTED (UK/EU)
              </SelectItem>
              <SelectItem value={SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET}>
                DRIVER_COLLECTED_COMMISSION_WALLET (Africa)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-4 p-3 border rounded-lg">
          <div>
            <Label htmlFor="cw-enabled" className="font-medium">Enable Commission Wallet</Label>
            <p className="text-xs text-muted-foreground max-w-xl">
              Requires DRIVER_COLLECTED model. Dispatch uses a read-only balance check — money is deducted only after trip completion.
            </p>
          </div>
          <Switch
            id="cw-enabled"
            checked={value.commission_wallet_enabled}
            onCheckedChange={(checked) => {
              if (checked) {
                const gate = planCommissionWalletServiceAreaEnablement({
                  serviceAreaId,
                  enabling: true,
                  rollout,
                });
                if (!gate.ok) {
                  toast.error((gate as { ok: false; error: string }).error);
                  return;
                }
              }
              if (checked && value.financial_model !== SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET) {
                patch({
                  financial_model: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
                  commission_wallet_enabled: true,
                  customer_payment_policy: CUSTOMER_PAYMENT_POLICY.DRIVER_COLLECTS_UPFRONT,
                });
                return;
              }
              patch({ commission_wallet_enabled: checked });
            }}
            disabled={
              isSaving
              || (pilotLockBlocksEnable && !value.commission_wallet_enabled)
            }
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Currency</Label>
            <Input
              value={value.commission_wallet_currency}
              placeholder={regionCurrency || 'USD'}
              onChange={(e) => patch({ commission_wallet_currency: e.target.value.toUpperCase() })}
              disabled={isSaving || !enabled}
            />
          </div>
          <div className="space-y-2">
            <Label>Top-up provider</Label>
            <Select
              value={value.commission_topup_provider || 'none'}
              onValueChange={(v) => patch({ commission_topup_provider: v === 'none' ? '' : v })}
              disabled={isSaving || !enabled}
            >
              <SelectTrigger>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (disabled)</SelectItem>
                <SelectItem value="waafi_pay">WaafiPay (sandbox)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Minimum balance (minor units)</Label>
            <Input
              type="number"
              min={0}
              value={value.commission_wallet_minimum_balance_minor}
              onChange={(e) => patch({
                commission_wallet_minimum_balance_minor: Math.max(0, Number(e.target.value) || 0),
              })}
              disabled={isSaving || !enabled}
            />
          </div>
          <div className="space-y-2">
            <Label>Customer payment policy</Label>
            <Select
              value={value.customer_payment_policy}
              onValueChange={(v) => patch({ customer_payment_policy: v })}
              disabled={isSaving || !enabled}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CUSTOMER_PAYMENT_POLICY.PLATFORM_PREPAID}>
                  PLATFORM_PREPAID
                </SelectItem>
                <SelectItem value={CUSTOMER_PAYMENT_POLICY.DRIVER_COLLECTS_UPFRONT}>
                  DRIVER_COLLECTS_UPFRONT
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Cash upfront policy notice</Label>
          <Textarea
            value={value.cash_upfront_policy_notice}
            onChange={(e) => patch({ cash_upfront_policy_notice: e.target.value })}
            disabled={isSaving || !enabled}
            rows={3}
          />
        </div>

        <div className="flex items-center justify-between gap-4 p-3 border rounded-lg">
          <div>
            <Label className="font-medium">Driver Top Up</Label>
            <p className="text-xs text-muted-foreground">
              Shows the Top Up button when a valid provider is also configured.
              Provider alone does not enable top-up.
            </p>
            {value.commission_wallet_topup_enabled && !value.commission_topup_provider ? (
              <p className="text-xs text-destructive mt-1">
                Configuration error: select a top-up provider or turn this off.
              </p>
            ) : null}
          </div>
          <Switch
            checked={value.commission_wallet_topup_enabled}
            onCheckedChange={(c) => patch({ commission_wallet_topup_enabled: c })}
            disabled={isSaving || !enabled}
          />
        </div>

        <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          Pre-trip commission reservation is permanently disabled. Accept performs a read-only
          balance eligibility check only; balance changes on confirmed credit or completed-trip deduction.
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex items-center justify-between gap-2 p-3 border rounded-lg sm:col-span-1">
            <Label>Welcome credit</Label>
            <Switch
              checked={value.welcome_credit_enabled}
              onCheckedChange={(c) => patch({ welcome_credit_enabled: c })}
              disabled={isSaving || !enabled}
            />
          </div>
          <div className="space-y-2">
            <Label>Welcome amount (minor)</Label>
            <Input
              type="number"
              min={0}
              value={value.welcome_credit_amount_minor}
              onChange={(e) => patch({
                welcome_credit_amount_minor: Math.max(0, Number(e.target.value) || 0),
              })}
              disabled={isSaving || !enabled}
            />
          </div>
          <div className="space-y-2">
            <Label>Max drivers</Label>
            <Input
              type="number"
              min={0}
              value={value.welcome_credit_max_drivers}
              onChange={(e) => patch({
                welcome_credit_max_drivers: Math.max(0, Number(e.target.value) || 0),
              })}
              disabled={isSaving || !enabled}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pt-2">
          <p className="text-xs text-muted-foreground">
            Status: {enabled ? 'Workflow ENABLED (admin/credits only)' : 'Workflow DISABLED'}
          </p>
          <Button onClick={() => void handleSave()} disabled={isSaving || !hasChanges}>
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save Commission Wallet
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
