/**
 * Payout Ledger settings — schedule, eligibility, instant cash-out.
 * Persists to admin_settings + service_areas. No earnings math.
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

  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

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
              <Label>Automatic payouts</Label>
              <p className="text-xs text-muted-foreground">Uses Available Payout from Wallet SSOT</p>
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
            <Select value={get('weekly_payout_day', 'monday')} onValueChange={(v) => set('weekly_payout_day', v)}>
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
            <Select value={get('payout_processing_time', '10:00')} onValueChange={(v) => set('payout_processing_time', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIMES.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">Service area timezone only — never browser local time.</p>
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
              <Label>Stripe instant payouts flag</Label>
              <p className="text-xs text-muted-foreground">Persisted setting — provider capability gate</p>
            </div>
            <Switch
              checked={get('stripe_instant_payouts_enabled', 'false') === 'true'}
              onCheckedChange={(v) => set('stripe_instant_payouts_enabled', v ? 'true' : 'false')}
            />
          </div>
        </CardContent>
      </Card>

      <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
        Save payout settings
      </Button>
    </div>
  );
}
