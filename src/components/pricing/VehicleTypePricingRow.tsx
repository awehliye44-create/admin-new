import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { supabase } from '@/integrations/supabase/client';
import { Car, CheckCircle2, Loader2, Plane, Save, XCircle } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  serviceAreaId: string;
  vehicleType: { id: string; name: string; slug: string; capacity: number; features: string[] | null; is_active: boolean };
  currencyCode: string;
  currencySymbol: string;
  distanceUnitLabel: string; // "mi" or "km"
  onChanged?: () => void;
}

interface SavRow {
  id: string;
  is_enabled: boolean;
  base_fare: number;
  minimum_fare: number;
  per_km_rate_pence: number;
  per_min_rate_pence: number;
  airport_charge_pence: number;
}

export function VehicleTypePricingRow({
  serviceAreaId,
  vehicleType,
  currencyCode,
  currencySymbol,
  distanceUnitLabel,
  onChanged,
}: Props) {
  const [row, setRow] = useState<SavRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('service_area_vehicle_pricing')
      .select('id, is_enabled, base_fare, minimum_fare, per_km_rate_pence, per_min_rate_pence, airport_charge_pence')
      .eq('service_area_id', serviceAreaId)
      .eq('vehicle_type_id', vehicleType.id)
      .maybeSingle();
    setRow((data as SavRow) ?? null);
    setDirty(false);
    setLoading(false);
  };

  useEffect(() => { load(); }, [serviceAreaId, vehicleType.id]);

  const upsertNew = async (initial: Partial<SavRow>) => {
    const { data, error } = await supabase
      .from('service_area_vehicle_pricing')
      .insert({
        service_area_id: serviceAreaId,
        vehicle_type_id: vehicleType.id,
        currency_code: currencyCode,
        is_enabled: true,
        base_fare: 0,
        minimum_fare: 0,
        per_km_rate_pence: 0,
        per_min_rate_pence: 0,
        airport_charge_pence: 0,
        ...initial,
      })
      .select('id, is_enabled, base_fare, minimum_fare, per_km_rate_pence, per_min_rate_pence, airport_charge_pence')
      .single();
    if (error) throw error;
    return data as SavRow;
  };

  const toggleEnabled = async (next: boolean) => {
    setSaving(true);
    try {
      if (!row) {
        const created = await upsertNew({ is_enabled: next });
        setRow(created);
      } else {
        const { error } = await supabase
          .from('service_area_vehicle_pricing')
          .update({ is_enabled: next, updated_at: new Date().toISOString() })
          .eq('id', row.id);
        if (error) throw error;
        setRow({ ...row, is_enabled: next });
      }
      toast.success(next ? 'Vehicle enabled' : 'Vehicle disabled');
      onChanged?.();
    } catch (e: any) {
      toast.error(e.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!row) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('service_area_vehicle_pricing')
        .update({
          base_fare: row.base_fare,
          minimum_fare: row.minimum_fare,
          per_km_rate_pence: row.per_km_rate_pence,
          per_min_rate_pence: row.per_min_rate_pence,
          airport_charge_pence: row.airport_charge_pence,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (error) throw error;
      toast.success(`${vehicleType.name} pricing saved`);
      setDirty(false);
      onChanged?.();
    } catch (e: any) {
      toast.error(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const isAssigned = row?.is_enabled ?? false;
  const setField = <K extends keyof SavRow>(k: K, v: SavRow[K]) => {
    if (!row) return;
    setRow({ ...row, [k]: v });
    setDirty(true);
  };

  return (
    <div className={`p-4 border rounded-lg transition-colors ${
      isAssigned ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/30'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
            isAssigned ? 'bg-primary/10' : 'bg-muted'
          }`}>
            <Car className={`h-5 w-5 ${isAssigned ? 'text-primary' : 'text-muted-foreground'}`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium">{vehicleType.name}</p>
              <Badge variant="outline" className="text-[10px]">{vehicleType.slug}</Badge>
              {!vehicleType.is_active && <Badge variant="destructive" className="text-[10px]">Inactive</Badge>}
            </div>
            <span className="text-xs text-muted-foreground">Capacity: {vehicleType.capacity}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isAssigned ? (
            <Badge variant="default" className="gap-1"><CheckCircle2 className="h-3 w-3" />Assigned</Badge>
          ) : (
            <Badge variant="secondary" className="gap-1 text-muted-foreground"><XCircle className="h-3 w-3" />Not Assigned</Badge>
          )}
          <Switch checked={isAssigned} disabled={saving || loading} onCheckedChange={toggleEnabled} />
        </div>
      </div>

      {isAssigned && row && (
        <div className="mt-4 pt-4 border-t grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="space-y-1">
            <Label className="text-xs">Base fare ({currencySymbol})</Label>
            <Input type="number" step="0.01" min="0" value={row.base_fare}
              onChange={(e) => setField('base_fare', parseFloat(e.target.value) || 0)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Per {distanceUnitLabel} ({currencySymbol})</Label>
            <Input type="number" step="0.01" min="0" value={(row.per_km_rate_pence / 100).toFixed(2)}
              onChange={(e) => setField('per_km_rate_pence', Math.round((parseFloat(e.target.value) || 0) * 100))} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Per minute ({currencySymbol})</Label>
            <Input type="number" step="0.01" min="0" value={(row.per_min_rate_pence / 100).toFixed(2)}
              onChange={(e) => setField('per_min_rate_pence', Math.round((parseFloat(e.target.value) || 0) * 100))} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Minimum fare ({currencySymbol})</Label>
            <Input type="number" step="0.01" min="0" value={row.minimum_fare}
              onChange={(e) => setField('minimum_fare', parseFloat(e.target.value) || 0)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1"><Plane className="h-3 w-3" />Airport charge ({currencySymbol})</Label>
            <Input type="number" step="0.01" min="0" value={(row.airport_charge_pence / 100).toFixed(2)}
              onChange={(e) => setField('airport_charge_pence', Math.round((parseFloat(e.target.value) || 0) * 100))} />
          </div>
          <div className="col-span-2 md:col-span-5 flex justify-end">
            <Button size="sm" disabled={!dirty || saving} onClick={save}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save {vehicleType.name}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
