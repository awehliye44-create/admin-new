import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { toast } from 'sonner';

type FeeConfigRow = {
  id: string;
  collection_provider: string;
  payment_method: string;
  fee_type: string;
  percentage_fee_bps: number;
  fixed_fee_pence: number;
  currency_code: string;
  version: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
};

/**
 * Admin control for versioned provider-fee configuration.
 * Historical payment snapshots must never be edited here — add a new version instead.
 */
export function ProviderFeeConfigPanel({
  serviceAreaId,
  currencyCode = 'GBP',
  activeConfig,
}: {
  serviceAreaId: string | null;
  currencyCode?: string;
  activeConfig: Record<string, unknown> | null;
}) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState(String(activeConfig?.collection_provider ?? 'revolut'));
  const [method, setMethod] = useState(String(activeConfig?.payment_method ?? 'card'));
  const [pct, setPct] = useState(
    activeConfig?.percentage_fee_bps != null
      ? String(Number(activeConfig.percentage_fee_bps) / 100)
      : '1.00',
  );
  const [fixedMajor, setFixedMajor] = useState(
    activeConfig?.fixed_fee_pence != null
      ? (Number(activeConfig.fixed_fee_pence) / 100).toFixed(2)
      : '0.20',
  );
  const [version, setVersion] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: versions = [], isLoading } = useQuery({
    queryKey: ['provider-fee-configurations', serviceAreaId],
    enabled: Boolean(serviceAreaId),
    queryFn: async (): Promise<FeeConfigRow[]> => {
      const { data, error } = await supabase
        .from('provider_fee_configurations' as 'service_areas')
        .select('*')
        .eq('service_area_id', serviceAreaId!)
        .order('effective_from', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as FeeConfigRow[];
    },
  });

  const addVersion = async () => {
    if (!serviceAreaId) return;
    const pctNum = Number(pct);
    const fixedNum = Number(fixedMajor);
    if (!Number.isFinite(pctNum) || !Number.isFinite(fixedNum) || !version.trim()) {
      toast.error('Enter percentage, fixed fee, and version');
      return;
    }
    setSaving(true);
    try {
      // Disable current active versions for same provider/method (append-only history).
      await supabase
        .from('provider_fee_configurations' as 'service_areas')
        .update({ is_active: false, effective_to: new Date().toISOString() } as never)
        .eq('service_area_id', serviceAreaId)
        .eq('collection_provider', provider)
        .eq('payment_method', method)
        .eq('is_active', true);

      const { error } = await supabase
        .from('provider_fee_configurations' as 'service_areas')
        .insert({
          service_area_id: serviceAreaId,
          currency_code: currencyCode,
          collection_provider: provider.trim().toLowerCase(),
          payment_method: method.trim().toLowerCase(),
          fee_type: 'percentage_plus_fixed',
          percentage_fee_bps: Math.round(pctNum * 100),
          fixed_fee_pence: Math.round(fixedNum * 100),
          version: version.trim(),
          effective_from: new Date().toISOString(),
          is_active: true,
        } as never);
      if (error) throw error;
      toast.success('New fee version activated — historical snapshots unchanged');
      setVersion('');
      void queryClient.invalidateQueries({ queryKey: ['provider-fee-configurations', serviceAreaId] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot-detail'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save fee version');
    } finally {
      setSaving(false);
    }
  };

  const disableVersion = async (id: string) => {
    const { error } = await supabase
      .from('provider_fee_configurations' as 'service_areas')
      .update({ is_active: false, effective_to: new Date().toISOString() } as never)
      .eq('id', id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success('Fee version disabled');
    void queryClient.invalidateQueries({ queryKey: ['provider-fee-configurations', serviceAreaId] });
    void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot-detail'] });
  };

  if (!serviceAreaId) {
    return (
      <Card>
        <CardContent className="pt-4 text-sm text-muted-foreground">
          Assign a service area to manage provider-fee configuration.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Provider fee configuration (admin)</CardTitle>
        <p className="text-xs text-muted-foreground">
          Add future-effective versions or disable obsolete ones. Do not edit historical transaction fee snapshots —
          corrections create append-only adjustments at payment confirmation time.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-5">
          <div>
            <Label>Provider</Label>
            <Input value={provider} onChange={(e) => setProvider(e.target.value)} />
          </div>
          <div>
            <Label>Payment method</Label>
            <Input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="card / apple_pay / …" />
          </div>
          <div>
            <Label>Percentage %</Label>
            <Input value={pct} onChange={(e) => setPct(e.target.value)} />
          </div>
          <div>
            <Label>Fixed fee ({currencyCode})</Label>
            <Input value={fixedMajor} onChange={(e) => setFixedMajor(e.target.value)} />
          </div>
          <div>
            <Label>Version</Label>
            <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="REVOLUT_GB_V2" />
          </div>
        </div>
        <Button type="button" size="sm" onClick={() => void addVersion()} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Add future-effective fee version
        </Button>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading versions…</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">%</TableHead>
                  <TableHead className="text-right">Fixed</TableHead>
                  <TableHead>Effective from</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-mono text-xs">{v.version}</TableCell>
                    <TableCell className="text-xs">{v.collection_provider}</TableCell>
                    <TableCell className="text-xs">{v.payment_method}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {(v.percentage_fee_bps / 100).toFixed(2)}%
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {formatNullablePence(v.fixed_fee_pence, v.currency_code || currencyCode)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {format(new Date(v.effective_from), 'dd MMM yyyy')}
                    </TableCell>
                    <TableCell>
                      <Badge variant={v.is_active ? 'default' : 'secondary'}>
                        {v.is_active ? 'ACTIVE' : 'DISABLED'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {v.is_active ? (
                        <Button variant="outline" size="sm" onClick={() => void disableVersion(v.id)}>
                          Disable
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
