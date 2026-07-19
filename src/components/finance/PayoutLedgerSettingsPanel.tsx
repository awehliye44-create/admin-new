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
import {
  RESERVE_MODE,
  RESERVE_POLICY_STATUS,
  validateReservePolicyDraft,
  type ReserveMode,
  type ReservePolicyStatus,
} from '../../../shared/companyOperationalReserveSSOT';

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
  'allow_sole_admin_company_transfer_approval',
  'sole_admin_company_transfer_limit_pence',
  'sole_admin_company_transfer_allowed_types',
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

  type ReserveRow = {
    id: string;
    service_area_id: string | null;
    currency: string;
    reserve_mode: ReserveMode;
    reserve_amount_pence: number | null;
    reserve_percentage_bps: number | null;
    minimum_reserve_pence: number | null;
    effective_from: string | null;
    effective_to: string | null;
    status: ReservePolicyStatus;
    audit_note: string | null;
    updated_at: string;
  };

  const { data: reservePolicies = [], refetch: refetchReserves } = useQuery({
    queryKey: ['company-operational-refund-reserves', serviceFilter.serviceAreaId],
    queryFn: async () => {
      let q = supabase
        .from('company_operational_refund_reserves')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(20);
      if (serviceFilter.serviceAreaId) {
        q = q.or(`service_area_id.eq.${serviceFilter.serviceAreaId},service_area_id.is.null`);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ReserveRow[];
    },
    staleTime: 15_000,
  });

  const activeReserve = reservePolicies.find((r) => r.status === 'ACTIVE') ?? null;
  const draftReserve = reservePolicies.find((r) => r.status === 'DRAFT') ?? null;
  const currentReserve = activeReserve ?? draftReserve ?? reservePolicies[0] ?? null;

  const [reserveMode, setReserveMode] = useState<ReserveMode>(RESERVE_MODE.FIXED_AMOUNT);
  const [reserveAmount, setReserveAmount] = useState('');
  const [reserveBps, setReserveBps] = useState('');
  const [reserveMinimum, setReserveMinimum] = useState('0');
  const [reserveEffectiveFrom, setReserveEffectiveFrom] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [reserveAuditNote, setReserveAuditNote] = useState('');

  useEffect(() => {
    if (!currentReserve) {
      setReserveMode(RESERVE_MODE.FIXED_AMOUNT);
      setReserveAmount('');
      setReserveBps('');
      setReserveMinimum('0');
      return;
    }
    setReserveMode(currentReserve.reserve_mode);
    setReserveAmount(
      currentReserve.reserve_amount_pence != null ? String(currentReserve.reserve_amount_pence) : '',
    );
    setReserveBps(
      currentReserve.reserve_percentage_bps != null
        ? String(currentReserve.reserve_percentage_bps)
        : '',
    );
    setReserveMinimum(String(currentReserve.minimum_reserve_pence ?? 0));
    if (currentReserve.effective_from) {
      setReserveEffectiveFrom(String(currentReserve.effective_from).slice(0, 10));
    }
    setReserveAuditNote(currentReserve.audit_note ?? '');
  }, [currentReserve?.id, currentReserve?.updated_at]);

  const invalidateReserveQueries = () => {
    void queryClient.invalidateQueries({ queryKey: ['company-operational-refund-reserves'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
    void refetchReserves();
  };

  async function writeReserveAudit(args: {
    reserve_id: string | null;
    action: string;
    from_status: string | null;
    to_status: string | null;
    payload: Record<string, unknown>;
    note?: string;
  }) {
    const { data: auth } = await supabase.auth.getUser();
    await supabase.from('company_operational_reserve_audit').insert({
      reserve_id: args.reserve_id,
      action: args.action,
      actor_id: auth.user?.id ?? null,
      from_status: args.from_status,
      to_status: args.to_status,
      payload: args.payload as never,
      note: args.note ?? 'Config only — no money movement',
      money_moved: false,
    });
  }

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

  const reserveSaveDraft = useMutation({
    mutationFn: async () => {
      const currency = (serviceFilter.currencyCode ?? 'GBP').toUpperCase();
      const amountPence = reserveAmount.trim() === '' ? null : Number(reserveAmount);
      const bps = reserveBps.trim() === '' ? null : Number(reserveBps);
      const minimum = reserveMinimum.trim() === '' ? 0 : Number(reserveMinimum);
      const validated = validateReservePolicyDraft({
        reserve_mode: reserveMode,
        reserve_amount_pence: amountPence,
        reserve_percentage_bps: bps,
        minimum_reserve_pence: minimum,
        currency,
      });
      if (!validated.ok) throw new Error((validated as { message: string }).message);

      const { data: auth } = await supabase.auth.getUser();
      const payload = {
        service_area_id: serviceFilter.serviceAreaId,
        currency,
        reserve_mode: reserveMode,
        reserve_amount_pence: reserveMode === RESERVE_MODE.FIXED_AMOUNT
          ? Math.round(Number(amountPence))
          : null,
        reserve_percentage_bps: reserveMode === RESERVE_MODE.PERCENTAGE
          ? Math.round(Number(bps))
          : null,
        minimum_reserve_pence: Math.round(minimum),
        effective_from: new Date(`${reserveEffectiveFrom}T00:00:00.000Z`).toISOString(),
        effective_to: null as string | null,
        status: RESERVE_POLICY_STATUS.DRAFT,
        audit_note: reserveAuditNote.trim()
          || 'Draft via Payout Ledger settings (no money movement)',
        updated_at: new Date().toISOString(),
      };

      if (draftReserve?.id) {
        const { error } = await supabase
          .from('company_operational_refund_reserves')
          .update(payload)
          .eq('id', draftReserve.id)
          .eq('status', 'DRAFT');
        if (error) throw error;
        await writeReserveAudit({
          reserve_id: draftReserve.id,
          action: 'UPDATE_DRAFT',
          from_status: 'DRAFT',
          to_status: 'DRAFT',
          payload,
        });
        return draftReserve.id;
      }

      const insertPayload = {
        ...payload,
        created_by: auth.user?.id ?? null,
      };
      const { data: inserted, error } = await supabase
        .from('company_operational_refund_reserves')
        .insert(insertPayload)
        .select('id')
        .single();
      if (error) throw error;
      await writeReserveAudit({
        reserve_id: inserted.id,
        action: 'SAVE_DRAFT',
        from_status: null,
        to_status: 'DRAFT',
        payload: insertPayload,
      });
      return inserted.id as string;
    },
    onSuccess: () => {
      toast.success('Reserve draft saved (no money moved)');
      invalidateReserveQueries();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const reserveActivate = useMutation({
    mutationFn: async () => {
      const targetId = draftReserve?.id ?? currentReserve?.id;
      if (!targetId) throw new Error('Save a draft before activating');
      const confirmed = window.confirm(
        'Activate this Operational / Refund Reserve policy?\n\n'
          + 'This unlocks ONECAB Available Company Funds using the safer transferable base. '
          + 'It does NOT move money, create reservations, or execute transfers.',
      );
      if (!confirmed) throw new Error('Activation cancelled');

      // Demote any other ACTIVE for same SA+currency first (unique index).
      if (activeReserve && activeReserve.id !== targetId) {
        const { error: disableErr } = await supabase
          .from('company_operational_refund_reserves')
          .update({
            status: 'DISABLED',
            disabled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', activeReserve.id);
        if (disableErr) throw disableErr;
        await writeReserveAudit({
          reserve_id: activeReserve.id,
          action: 'DISABLE',
          from_status: 'ACTIVE',
          to_status: 'DISABLED',
          payload: { reason: 'replaced_by_activation' },
        });
      }

      const { data: auth } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('company_operational_refund_reserves')
        .update({
          status: 'ACTIVE',
          approved_by: auth.user?.id ?? null,
          activated_at: new Date().toISOString(),
          disabled_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', targetId);
      if (error) throw error;
      await writeReserveAudit({
        reserve_id: targetId,
        action: 'ACTIVATE',
        from_status: draftReserve?.status ?? currentReserve?.status ?? null,
        to_status: 'ACTIVE',
        payload: { confirmed: true },
        note: 'Explicit activation confirmation — no money movement',
      });
    },
    onSuccess: () => {
      toast.success('Reserve activated (config only — no money moved)');
      invalidateReserveQueries();
    },
    onError: (err: Error) => {
      if (err.message !== 'Activation cancelled') toast.error(err.message);
    },
  });

  const reserveDisable = useMutation({
    mutationFn: async () => {
      const targetId = activeReserve?.id ?? currentReserve?.id;
      if (!targetId) throw new Error('No reserve policy to disable');
      const confirmed = window.confirm(
        'Disable this reserve policy?\n\n'
          + 'Final ONECAB Available funds will return to UNAVAILABLE (fail-closed). '
          + 'No money is moved.',
      );
      if (!confirmed) throw new Error('Disable cancelled');
      const from = activeReserve?.status ?? currentReserve?.status ?? null;
      const { error } = await supabase
        .from('company_operational_refund_reserves')
        .update({
          status: 'DISABLED',
          disabled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', targetId);
      if (error) throw error;
      await writeReserveAudit({
        reserve_id: targetId,
        action: 'DISABLE',
        from_status: from,
        to_status: 'DISABLED',
        payload: { confirmed: true },
      });
    },
    onSuccess: () => {
      toast.success('Reserve disabled — final available UNAVAILABLE (no money moved)');
      invalidateReserveQueries();
    },
    onError: (err: Error) => {
      if (err.message !== 'Disable cancelled') toast.error(err.message);
    },
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
          <div className="flex items-center justify-between gap-3 rounded-md border p-3 sm:col-span-2">
            <div>
              <Label>Allow sole-admin self-approval</Label>
              <p className="text-xs text-muted-foreground">
                Only when no second company-transfer approver exists. Super admin only.
                Does not disable four-eyes globally.
              </p>
            </div>
            <Switch
              checked={get('allow_sole_admin_company_transfer_approval', 'false') === 'true'}
              onCheckedChange={(v) => set('allow_sole_admin_company_transfer_approval', v ? 'true' : 'false')}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Sole-admin limit (pence)</Label>
            <Input
              value={get('sole_admin_company_transfer_limit_pence', '1')}
              onChange={(e) => set('sole_admin_company_transfer_limit_pence', e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">Certification default = 1 (£0.01).</p>
          </div>
          <div className="space-y-1.5">
            <Label>Sole-admin allowed transfer types</Label>
            <Input
              value={get('sole_admin_company_transfer_allowed_types', 'CERTIFICATION')}
              onChange={(e) => set('sole_admin_company_transfer_allowed_types', e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">Comma-separated. Fail-closed default: CERTIFICATION.</p>
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
            Backend SSOT only — configuration never moves money. Until an ACTIVE policy exists,
            reserve is OPERATIONAL_RESERVE_NOT_CONFIGURED and final Available stays UNAVAILABLE
            (fail-closed). Unclassified residual cash is never transferable.
          </p>
          <div className="text-xs font-mono rounded-md border p-2 space-y-1">
            <div>
              Gate:{' '}
              {activeReserve
                ? `ACTIVE · ${activeReserve.reserve_mode} · ${activeReserve.currency}`
                : 'OPERATIONAL_RESERVE_NOT_CONFIGURED'}
            </div>
            {currentReserve ? (
              <div>
                Latest: {currentReserve.status} · id {currentReserve.id.slice(0, 8)}…
                {currentReserve.reserve_mode === 'FIXED_AMOUNT'
                  ? ` · ${currentReserve.reserve_amount_pence ?? 0}p`
                  : ` · ${currentReserve.reserve_percentage_bps ?? 0} bps (min ${currentReserve.minimum_reserve_pence ?? 0}p)`}
              </div>
            ) : (
              <div>No draft/active/disabled row for this service area yet.</div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Reserve type</Label>
              <Select
                value={reserveMode}
                onValueChange={(v) => setReserveMode(v as ReserveMode)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={RESERVE_MODE.FIXED_AMOUNT}>Fixed amount (pence)</SelectItem>
                  <SelectItem value={RESERVE_MODE.PERCENTAGE}>Percentage of eligible cash</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Currency / service area</Label>
              <div className="text-sm font-mono pt-2">
                {(serviceFilter.currencyCode ?? 'GBP').toUpperCase()}
                {serviceFilter.serviceAreaId
                  ? ` · SA ${serviceFilter.serviceAreaId.slice(0, 8)}…`
                  : ' · (select a service area)'}
              </div>
            </div>
            {reserveMode === RESERVE_MODE.FIXED_AMOUNT ? (
              <div className="space-y-1.5">
                <Label>Reserve amount (pence)</Label>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={reserveAmount}
                  onChange={(e) => setReserveAmount(e.target.value)}
                  placeholder="e.g. 1"
                />
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>Reserve percentage (bps)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={reserveBps}
                    onChange={(e) => setReserveBps(e.target.value)}
                    placeholder="1000 = 10%"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Minimum reserve (pence)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={reserveMinimum}
                    onChange={(e) => setReserveMinimum(e.target.value)}
                  />
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <Label>Effective from</Label>
              <Input
                type="date"
                value={reserveEffectiveFrom}
                onChange={(e) => setReserveEffectiveFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Audit note (optional)</Label>
              <Input
                value={reserveAuditNote}
                onChange={(e) => setReserveAuditNote(e.target.value)}
                placeholder="Config only — no money movement"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={reserveSaveDraft.isPending || !serviceFilter.serviceAreaId}
              onClick={() => reserveSaveDraft.mutate()}
            >
              {reserveSaveDraft.isPending ? 'Saving…' : 'Save draft'}
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={reserveActivate.isPending || (!draftReserve && !currentReserve)}
              onClick={() => reserveActivate.mutate()}
            >
              {reserveActivate.isPending ? 'Activating…' : 'Activate'}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={reserveDisable.isPending || (!activeReserve && !currentReserve)}
              onClick={() => reserveDisable.mutate()}
            >
              {reserveDisable.isPending ? 'Disabling…' : 'Disable'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
        Save payout settings
      </Button>
    </div>
  );
}
