import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { COMMISSION_WALLET_CAMPAIGN_TYPE } from '../../shared/commissionWalletSSOT';

type CampaignRow = Record<string, unknown> & {
  id?: string;
  campaign_name?: string;
  campaign_type?: string;
  active?: boolean;
  claim_count?: number;
  currency?: string;
  credit_amount_minor?: number;
  bonus_percent?: number | null;
  minimum_topup_amount_minor?: number;
  maximum_bonus_amount_minor?: number | null;
  maximum_claims?: number | null;
  start_at?: string | null;
  end_at?: string | null;
};

const TYPE_OPTIONS = Object.values(COMMISSION_WALLET_CAMPAIGN_TYPE);

function formatMinor(n: unknown, currency = 'USD'): string {
  const v = Number(n) || 0;
  return `${currency} ${(v / 100).toFixed(2)}`;
}

export function CommissionWalletCampaigns(props: {
  serviceAreaId: string | null;
  currency: string;
  workflowEnabled: boolean;
}) {
  const { serviceAreaId, currency, workflowEnabled } = props;
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [campaignType, setCampaignType] = useState<string>(
    COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS,
  );
  const [active, setActive] = useState(true);
  const [creditMajor, setCreditMajor] = useState('5');
  const [bonusPercent, setBonusPercent] = useState('10');
  const [minTopupMajor, setMinTopupMajor] = useState('10');
  const [maxBonusMajor, setMaxBonusMajor] = useState('20');
  const [maxClaims, setMaxClaims] = useState('');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['admin-commission-wallet-campaigns', serviceAreaId],
    enabled: Boolean(serviceAreaId),
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('admin-commission-wallet-campaigns', {
        body: { op: 'list', service_area_id: serviceAreaId },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'Failed to list campaigns');
      return (data.campaigns ?? []) as CampaignRow[];
    },
  });

  useEffect(() => {
    setEditingId(null);
    setName('');
  }, [serviceAreaId]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!serviceAreaId) throw new Error('Select a service area');
      if (!name.trim()) throw new Error('Campaign name required');
      const credit_amount_minor = Math.round(Number(creditMajor) * 100);
      const minimum_topup_amount_minor = Math.round(Number(minTopupMajor) * 100);
      const maximum_bonus_amount_minor = Math.round(Number(maxBonusMajor) * 100);
      const body: Record<string, unknown> = {
        op: editingId ? 'update' : 'create',
        campaign_id: editingId,
        service_area_id: serviceAreaId,
        campaign_name: name.trim(),
        campaign_type: campaignType,
        currency,
        active,
        credit_amount_minor: Number.isFinite(credit_amount_minor) ? credit_amount_minor : 0,
        bonus_percent: Number(bonusPercent) || null,
        minimum_topup_amount_minor: Number.isFinite(minimum_topup_amount_minor)
          ? minimum_topup_amount_minor
          : 0,
        maximum_bonus_amount_minor: Number.isFinite(maximum_bonus_amount_minor)
          ? maximum_bonus_amount_minor
          : null,
        maximum_claims: maxClaims.trim() === ''
          ? null
          : Math.max(0, Math.round(Number(maxClaims) || 0)),
        start_at: startAt.trim()
          ? new Date(startAt).toISOString()
          : null,
        end_at: endAt.trim()
          ? new Date(endAt).toISOString()
          : null,
      };
      const { data, error } = await supabase.functions.invoke('admin-commission-wallet-campaigns', {
        body,
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'Save failed');
      return data;
    },
    onSuccess: () => {
      toast.success(editingId ? 'Campaign updated' : 'Campaign created');
      setEditingId(null);
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['admin-commission-wallet-campaigns'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-commission-wallet-overview'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deactivateMutation = useMutation({
    mutationFn: async (campaignId: string) => {
      const { data, error } = await supabase.functions.invoke('admin-commission-wallet-campaigns', {
        body: { op: 'deactivate', campaign_id: campaignId },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'Deactivate failed');
      return data;
    },
    onSuccess: () => {
      toast.success('Campaign deactivated');
      void queryClient.invalidateQueries({ queryKey: ['admin-commission-wallet-campaigns'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-commission-wallet-overview'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toLocalInput = (iso: string | null | undefined) => {
    if (!iso) return '';
    const d = new Date(String(iso));
    if (!Number.isFinite(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const loadForEdit = (row: CampaignRow) => {
    setEditingId(String(row.id));
    setName(String(row.campaign_name ?? ''));
    setCampaignType(String(row.campaign_type ?? COMMISSION_WALLET_CAMPAIGN_TYPE.MANUAL_PROMOTIONAL_CREDIT));
    setActive(row.active === true);
    setCreditMajor(String((Number(row.credit_amount_minor) || 0) / 100));
    setBonusPercent(String(row.bonus_percent ?? '10'));
    setMinTopupMajor(String((Number(row.minimum_topup_amount_minor) || 0) / 100));
    setMaxBonusMajor(String((Number(row.maximum_bonus_amount_minor) || 0) / 100));
    setMaxClaims(row.maximum_claims == null ? '' : String(row.maximum_claims));
    setStartAt(toLocalInput(row.start_at));
    setEndAt(toLocalInput(row.end_at));
  };

  if (!serviceAreaId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Phase 5 — Campaigns</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Select a service area to manage welcome / top-up bonus / promotional campaigns.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Phase 5 — Campaigns</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!workflowEnabled && (
          <p className="text-sm text-muted-foreground">
            Enable Commission Wallet on this service area before creating campaigns.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1 sm:col-span-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name" />
          </div>
          <div className="space-y-1">
            <Label>Type</Label>
            <Select value={campaignType} onValueChange={setCampaignType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(campaignType === COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS
            || campaignType === COMMISSION_WALLET_CAMPAIGN_TYPE.WELCOME_CREDIT
            || campaignType === COMMISSION_WALLET_CAMPAIGN_TYPE.MANUAL_PROMOTIONAL_CREDIT) && (
            <div className="space-y-1">
              <Label>Credit amount ({currency})</Label>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={creditMajor}
                onChange={(e) => setCreditMajor(e.target.value)}
              />
            </div>
          )}
          {campaignType === COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS && (
            <>
              <div className="space-y-1">
                <Label>Bonus percent</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.1}
                  value={bonusPercent}
                  onChange={(e) => setBonusPercent(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>Max bonus ({currency})</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={maxBonusMajor}
                  onChange={(e) => setMaxBonusMajor(e.target.value)}
                />
              </div>
            </>
          )}
          {(campaignType === COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS
            || campaignType === COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS) && (
            <div className="space-y-1">
              <Label>Minimum top-up ({currency})</Label>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={minTopupMajor}
                onChange={(e) => setMinTopupMajor(e.target.value)}
              />
            </div>
          )}
          <div className="space-y-1">
            <Label>Max claims (optional)</Label>
            <Input
              type="number"
              min={0}
              step={1}
              value={maxClaims}
              onChange={(e) => setMaxClaims(e.target.value)}
              placeholder="Unlimited"
            />
          </div>
          <div className="space-y-1">
            <Label>Start (optional)</Label>
            <Input
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>End (optional)</Label>
            <Input
              type="datetime-local"
              value={endAt}
              onChange={(e) => setEndAt(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3 pt-6">
            <Switch checked={active} onCheckedChange={setActive} />
            <Label>Active</Label>
          </div>
          <div className="sm:col-span-2 lg:col-span-3 flex flex-wrap gap-2">
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !workflowEnabled}
            >
              {editingId ? 'Update campaign' : 'Create campaign'}
            </Button>
            {editingId && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditingId(null);
                  setName('');
                }}
              >
                Cancel edit
              </Button>
            )}
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Claims</TableHead>
              <TableHead>Details</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(listQuery.data ?? []).map((row) => (
              <TableRow key={String(row.id)}>
                <TableCell className="text-sm">{String(row.campaign_name)}</TableCell>
                <TableCell className="text-xs">{String(row.campaign_type)}</TableCell>
                <TableCell>
                  {row.active
                    ? <Badge>Active</Badge>
                    : <Badge variant="outline">Off</Badge>}
                </TableCell>
                <TableCell>{Number(row.claim_count) || 0}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.campaign_type === COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS
                    ? `${row.bonus_percent ?? 0}% · min ${formatMinor(row.minimum_topup_amount_minor, String(row.currency || currency))}`
                    : formatMinor(row.credit_amount_minor, String(row.currency || currency))}
                </TableCell>
                <TableCell className="space-x-2 whitespace-nowrap">
                  <Button type="button" size="sm" variant="outline" onClick={() => loadForEdit(row)}>
                    Edit
                  </Button>
                  {row.active && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={deactivateMutation.isPending}
                      onClick={() => deactivateMutation.mutate(String(row.id))}
                    >
                      Deactivate
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {(listQuery.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-sm text-muted-foreground">
                  {listQuery.isLoading ? 'Loading campaigns…' : 'No campaigns for this service area.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
