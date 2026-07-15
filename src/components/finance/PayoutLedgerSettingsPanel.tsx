/**
 * Payout Ledger settings — schedule, eligibility, instant cash-out, per-driver override.
 * Persists to admin_settings + service_areas + drivers.payouts_enabled. No earnings math.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { DriverSelector } from '@/components/finance/DriverSelector';

const SETTING_KEYS = [
  'payouts_enabled',
  'weekly_payout_day',
  'payout_frequency',
  'payout_processing_time',
  'payout_min_pence',
  'payout_max_pence',
  'payout_rule_negative_wallet',
  'payout_rule_pending_disputes',
  'payout_rule_pending_chargebacks',
  'payout_rule_manual_review',
  'payout_rule_suspended_driver',
  'payout_rule_expired_documents',
  'early_cashout_fee_pence',
  'early_cashout_min_pence',
  'early_cashout_max_pence',
  'early_cashout_max_per_day',
  'stripe_instant_payouts_enabled',
  'company_transfer_approval_single_max_pence',
  'company_transfer_approval_dual_max_pence',
  'company_transfer_default_account',
  'company_transfer_retry_max',
  'company_transfer_batch_size',
  'company_transfer_supported_providers',
  'company_transfer_pdf_template',
  'company_transfer_notifications_enabled',
  'manual_payouts_enabled',
] as const;

type RuleMode = 'allow' | 'hold' | 'block';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const FREQUENCIES = ['daily', 'weekly', 'fortnightly', 'monthly', 'manual_only'] as const;
const TIMES = ['08:00', '10:00', '12:00', '15:00', '18:00', '23:00'] as const;

async function loadSettings(): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from('admin_settings')
    .select('setting_key, setting_value')
    .in('setting_key', [...SETTING_KEYS]);
  if (error) throw error;
  const map: Record<string, string> = {};
  for (const row of data ?? []) {
    const raw = row.setting_value;
    map[row.setting_key] = typeof raw === 'string'
      ? raw
      : raw == null
        ? ''
        : String(raw).replace(/^"|"$/g, '');
  }
  return map;
}

async function upsertSetting(key: string, value: string) {
  const jsonValue = Number.isFinite(Number(value)) && value.trim() !== '' && !value.includes(':')
    ? Number(value)
    : value;
  const { error } = await supabase.from('admin_settings').upsert(
    {
      setting_key: key,
      setting_value: jsonValue as unknown as string,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'setting_key' },
  );
  if (error) throw error;
}

export function PayoutLedgerSettingsPanel({
  serviceFilter,
}: {
  serviceFilter: ServiceAreaFinanceSelection;
}) {
  const queryClient = useQueryClient();
  const [overrideDriverId, setOverrideDriverId] = useState<string | null>(null);

  const { data: settings, isLoading } = useQuery({
    queryKey: ['payout-ledger-settings'],
    queryFn: loadSettings,
    staleTime: 30_000,
  });

  const { data: areaRow } = useQuery({
    queryKey: ['payout-ledger-sa-cashout', serviceFilter.serviceAreaId],
    enabled: Boolean(serviceFilter.serviceAreaId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_areas')
        .select('id, name, early_cashout_enabled, timezone')
        .eq('id', serviceFilter.serviceAreaId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const saOverrideKey = serviceFilter.serviceAreaId
    ? `payout_sa_override:${serviceFilter.serviceAreaId}`
    : null;

  const { data: saOverride } = useQuery({
    queryKey: ['payout-sa-override', serviceFilter.serviceAreaId],
    enabled: Boolean(saOverrideKey),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('setting_key, setting_value')
        .eq('setting_key', saOverrideKey!)
        .maybeSingle();
      if (error) throw error;
      if (!data?.setting_value) return {} as Record<string, string>;
      try {
        const raw = data.setting_value;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return (parsed ?? {}) as Record<string, string>;
      } catch {
        return {} as Record<string, string>;
      }
    },
  });

  const [saDraft, setSaDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (saOverride) setSaDraft(saOverride);
  }, [saOverride]);

  const { data: overrideDriver, isLoading: overrideLoading } = useQuery({
    queryKey: ['payout-driver-override', overrideDriverId],
    enabled: Boolean(overrideDriverId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('drivers')
        .select('id, first_name, last_name, driver_code, payouts_enabled, stripe_account_id, charges_enabled')
        .eq('id', overrideDriverId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  const { data: reserveRow } = useQuery({
    queryKey: ['company-operational-refund-reserve'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('setting_key, setting_value')
        .eq('setting_key', 'company_operational_refund_reserve')
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    staleTime: 30_000,
  });
  const [reserveDraft, setReserveDraft] = useState('');
  const [reserveConfigured, setReserveConfigured] = useState(false);
  useEffect(() => {
    if (!reserveRow?.setting_value) {
      setReserveDraft('');
      setReserveConfigured(false);
      return;
    }
    try {
      const raw = reserveRow.setting_value;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const configured = Boolean(parsed?.configured);
      setReserveConfigured(configured);
      setReserveDraft(configured && parsed?.amount_pence != null ? String(parsed.amount_pence) : '');
    } catch {
      setReserveConfigured(false);
      setReserveDraft('');
    }
  }, [reserveRow]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      for (const key of SETTING_KEYS) {
        if (draft[key] !== undefined && draft[key] !== settings?.[key]) {
          await upsertSetting(key, draft[key]);
        }
      }
    },
    onSuccess: () => {
      toast.success('Payout settings saved');
      void queryClient.invalidateQueries({ queryKey: ['payout-ledger-settings'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const reserveSave = useMutation({
    mutationFn: async () => {
      const amount = reserveDraft.trim() === '' ? null : Number(reserveDraft);
      if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
        throw new Error('Reserve amount must be a non-negative integer pence value');
      }
      if (amount == null) {
        const { error } = await supabase
          .from('admin_settings')
          .delete()
          .eq('setting_key', 'company_operational_refund_reserve');
        if (error) throw error;
        return;
      }
      const payload = {
        configured: true,
        amount_pence: Math.round(amount),
        percent_bps: null,
        currency: 'GBP',
        service_area_id: serviceFilter.serviceAreaId,
        effective_from: new Date().toISOString().slice(0, 10),
        audit_note: 'Configured via Payout Ledger settings (no money movement)',
      };
      const { error } = await supabase.from('admin_settings').upsert(
        {
          setting_key: 'company_operational_refund_reserve',
          setting_value: payload as unknown as string,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'setting_key' },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Operational reserve setting saved (no money moved)');
      void queryClient.invalidateQueries({ queryKey: ['company-operational-refund-reserve'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const cashoutMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!serviceFilter.serviceAreaId) throw new Error('Select a service area');
      const { error } = await supabase
        .from('service_areas')
        .update({ early_cashout_enabled: enabled })
        .eq('id', serviceFilter.serviceAreaId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Instant cash-out updated for service area');
      void queryClient.invalidateQueries({ queryKey: ['payout-ledger-sa-cashout'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const saOverrideMutation = useMutation({
    mutationFn: async () => {
      if (!saOverrideKey) throw new Error('Select a service area');
      const payload = {
        weekly_payout_day: saDraft.weekly_payout_day || undefined,
        payout_processing_time: saDraft.payout_processing_time || undefined,
        payout_min_pence: saDraft.payout_min_pence || undefined,
        payout_max_pence: saDraft.payout_max_pence || undefined,
      };
      const { error } = await supabase.from('admin_settings').upsert(
        {
          setting_key: saOverrideKey,
          setting_value: JSON.stringify(payload) as unknown as string,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'setting_key' },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Service-area payout override saved');
      void queryClient.invalidateQueries({ queryKey: ['payout-sa-override', serviceFilter.serviceAreaId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const driverOverrideMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!overrideDriverId) throw new Error('Select a driver');
      const { error } = await supabase
        .from('drivers')
        .update({ payouts_enabled: enabled })
        .eq('id', overrideDriverId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Per-driver payout override saved');
      void queryClient.invalidateQueries({ queryKey: ['payout-driver-override', overrideDriverId] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const get = (key: string, fallback = '') => draft[key] ?? settings?.[key] ?? fallback;
  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  if (isLoading) {
    return <p className="text-sm text-muted-foreground py-6">Loading payout settings…</p>;
  }

  const tz = areaRow?.timezone || 'Europe/London';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Automatic payout schedule</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <Label>
                {get('payouts_enabled', 'true') !== 'false'
                  ? 'Automatic payouts — On (switch off to Pause)'
                  : 'Automatic payouts — Paused (switch on to Resume)'}
              </Label>
              <p className="text-xs text-muted-foreground">
                Pause freezes the weekly scheduler. Resume restores automatic payouts using Available from Wallet SSOT.
                Manual Mark paid remains available on the ledger.
              </p>
            </div>
            <Switch
              checked={get('payouts_enabled', 'true') !== 'false'}
              onCheckedChange={(v) => set('payouts_enabled', v ? 'true' : 'false')}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Frequency</Label>
            <Select value={get('payout_frequency', 'weekly')} onValueChange={(v) => set('payout_frequency', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {FREQUENCIES.map((f) => (
                  <SelectItem key={f} value={f}>{f.replace('_', ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Weekly payout day</Label>
            <Select value={get('weekly_payout_day', 'tuesday')} onValueChange={(v) => set('weekly_payout_day', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {DAYS.map((d) => (
                  <SelectItem key={d} value={d}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Processing time ({tz === 'UTC' ? 'Europe/London' : tz})</Label>
            <Select value={get('payout_processing_time', '12:00')} onValueChange={(v) => set('payout_processing_time', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIMES.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              Service-area local wall time (IANA). Stored as HH:mm; backend converts to UTC via Europe/London for GBP areas — never browser local time, never labelled as UTC unless the timezone truly is UTC.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Minimum payout (pence)</Label>
            <Input value={get('payout_min_pence', '0')} onChange={(e) => set('payout_min_pence', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Maximum payout (pence)</Label>
            <Input value={get('payout_max_pence', '')} onChange={(e) => set('payout_max_pence', e.target.value)} placeholder="Unlimited" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-driver payout override</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <DriverSelector
            value={overrideDriverId}
            onChange={setOverrideDriverId}
            regionId={serviceFilter.regionId}
            serviceAreaId={serviceFilter.serviceAreaId}
            stripeConnectOnly={false}
          />
          {overrideDriverId && (
            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <Label>Allow automatic payouts for this driver</Label>
                <p className="text-xs text-muted-foreground">
                  {overrideDriver?.driver_code
                    ?? [overrideDriver?.first_name, overrideDriver?.last_name].filter(Boolean).join(' ')
                    ?? overrideDriverId}
                  {overrideDriver?.payouts_enabled === false
                    ? ' · automatic payouts paused'
                    : ' · payouts via Driver Wallet Ledger'}
                  {overrideLoading ? ' · loading…' : ''}
                </p>
              </div>
              <Switch
                checked={overrideDriver?.payouts_enabled !== false}
                disabled={!overrideDriver || driverOverrideMutation.isPending}
                onCheckedChange={(v) => driverOverrideMutation.mutate(v)}
              />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Per-driver override writes drivers.payouts_enabled only. Platform pause/resume remains above.
            Service-area instant cash-out is a separate override below.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-service-area schedule override</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {!serviceFilter.serviceAreaId ? (
            <p className="text-sm text-muted-foreground sm:col-span-3">
              Select a service area to override weekly day, time, min, and max for that area.
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>Weekly payout day</Label>
                <Select
                  value={saDraft.weekly_payout_day || get('weekly_payout_day', 'tuesday')}
                  onValueChange={(v) => setSaDraft((d) => ({ ...d, weekly_payout_day: v }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DAYS.map((d) => (
                      <SelectItem key={d} value={d}>{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Processing time ({tz})</Label>
                <Select
                  value={saDraft.payout_processing_time || get('payout_processing_time', '12:00')}
                  onValueChange={(v) => setSaDraft((d) => ({ ...d, payout_processing_time: v }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TIMES.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Minimum payout (pence)</Label>
                <Input
                  value={saDraft.payout_min_pence ?? ''}
                  onChange={(e) => setSaDraft((d) => ({ ...d, payout_min_pence: e.target.value }))}
                  placeholder={get('payout_min_pence', '0')}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Maximum payout (pence)</Label>
                <Input
                  value={saDraft.payout_max_pence ?? ''}
                  onChange={(e) => setSaDraft((d) => ({ ...d, payout_max_pence: e.target.value }))}
                  placeholder={get('payout_max_pence', 'Unlimited')}
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => saOverrideMutation.mutate()}
                  disabled={saOverrideMutation.isPending}
                >
                  Save service-area override
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Eligibility rules</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {([
            ['payout_rule_negative_wallet', 'Negative wallet'],
            ['payout_rule_pending_disputes', 'Pending disputes'],
            ['payout_rule_pending_chargebacks', 'Pending chargebacks'],
            ['payout_rule_manual_review', 'Manual review'],
            ['payout_rule_suspended_driver', 'Suspended driver'],
            ['payout_rule_expired_documents', 'Expired documents'],
          ] as const).map(([key, label]) => (
            <div key={key} className="space-y-1.5">
              <Label>{label}</Label>
              <Select
                value={(get(key, 'block') as RuleMode)}
                onValueChange={(v) => set(key, v)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="hold">Hold</SelectItem>
                  <SelectItem value="block">Block</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Instant cash-out</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex items-center justify-between gap-3 rounded-md border p-3 sm:col-span-2 lg:col-span-3">
            <div>
              <Label>Enable for selected service area</Label>
              <p className="text-xs text-muted-foreground">
                {areaRow?.name ?? 'Select a service area'} · {tz}
              </p>
            </div>
            <Switch
              checked={areaRow?.early_cashout_enabled === true}
              disabled={!serviceFilter.serviceAreaId || cashoutMutation.isPending}
              onCheckedChange={(v) => cashoutMutation.mutate(v)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Fee (pence)</Label>
            <Input value={get('early_cashout_fee_pence', '100')} onChange={(e) => set('early_cashout_fee_pence', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Minimum (pence)</Label>
            <Input value={get('early_cashout_min_pence', '500')} onChange={(e) => set('early_cashout_min_pence', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Maximum (pence)</Label>
            <Input value={get('early_cashout_max_pence', '')} onChange={(e) => set('early_cashout_max_pence', e.target.value)} placeholder="Unlimited" />
          </div>
          <div className="space-y-1.5">
            <Label>Max requests per day</Label>
            <Input value={get('early_cashout_max_per_day', '1')} onChange={(e) => set('early_cashout_max_per_day', e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border p-3 sm:col-span-2">
            <div>
              <Label>Instant payouts flag (legacy)</Label>
              <p className="text-xs text-muted-foreground">Persisted setting — provider capability gate</p>
            </div>
            <Switch
              checked={get('stripe_instant_payouts_enabled', 'false') === 'true'}
              onCheckedChange={(v) => set('stripe_instant_payouts_enabled', v ? 'true' : 'false')}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Company transfer approvals</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Single approval max (pence)</Label>
            <Input
              value={get('company_transfer_approval_single_max_pence', '25000')}
              onChange={(e) => set('company_transfer_approval_single_max_pence', e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">Default £250 = 25000. Requester cannot self-approve.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Dual approval max (pence)</Label>
            <Input
              value={get('company_transfer_approval_dual_max_pence', '250000')}
              onChange={(e) => set('company_transfer_approval_dual_max_pence', e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">Above this requires owner approval. Default £2,500 = 250000.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Default company account</Label>
            <Input
              value={get('company_transfer_default_account', '')}
              onChange={(e) => set('company_transfer_default_account', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Retry max</Label>
            <Input
              value={get('company_transfer_retry_max', '3')}
              onChange={(e) => set('company_transfer_retry_max', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Batch size</Label>
            <Input
              value={get('company_transfer_batch_size', '50')}
              onChange={(e) => set('company_transfer_batch_size', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Supported providers</Label>
            <Input
              value={get('company_transfer_supported_providers', 'manual,revolut')}
              onChange={(e) => set('company_transfer_supported_providers', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>PDF template</Label>
            <Input
              value={get('company_transfer_pdf_template', 'onecab_default')}
              onChange={(e) => set('company_transfer_pdf_template', e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <Label>Notification settings</Label>
              <p className="text-xs text-muted-foreground">Notify admins on company transfer status changes</p>
            </div>
            <Switch
              checked={get('company_transfer_notifications_enabled', 'true') === 'true'}
              onCheckedChange={(v) => set('company_transfer_notifications_enabled', v ? 'true' : 'false')}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border p-3 sm:col-span-2">
            <div>
              <Label>Manual payouts enabled</Label>
              <p className="text-xs text-muted-foreground">Allows manual company and driver payout actions</p>
            </div>
            <Switch
              checked={get('manual_payouts_enabled', 'true') === 'true'}
              onCheckedChange={(v) => set('manual_payouts_enabled', v ? 'true' : 'false')}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Operational / Refund Reserve</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Configuring this setting does not move money. Absence leaves ONECAB Available Company Funds
            UNAVAILABLE (fail-closed) and shows provisional residual under Before Operational Reserve.
            Explicit amount £0.00 is a deliberate zero-reserve policy.
          </p>
          <div className="space-y-1.5 max-w-sm">
            <Label>Reserve amount (pence, GBP)</Label>
            <Input
              type="number"
              min={0}
              value={reserveDraft}
              onChange={(e) => setReserveDraft(e.target.value)}
              placeholder="Leave empty = NOT_CONFIGURED"
            />
          </div>
          <div className="text-xs font-mono text-muted-foreground">
            Current: {reserveConfigured
              ? `${reserveDraft || '0'} pence (configured)`
              : 'OPERATIONAL_RESERVE_NOT_CONFIGURED'}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={reserveSave.isPending}
            onClick={() => reserveSave.mutate()}
          >
            {reserveSave.isPending ? 'Saving…' : 'Save reserve setting'}
          </Button>
        </CardContent>
      </Card>

      <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
        Save payout settings
      </Button>
    </div>
  );
}
