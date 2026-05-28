import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { supabase } from '@/integrations/supabase/client';
import { Car, CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  serviceAreaId: string;
  vehicleType: { id: string; name: string; slug: string; capacity: number; features: string[] | null; is_active: boolean };
  currencyCode: string;
  onChanged?: () => void;
}

interface SavRow {
  id: string;
  is_enabled: boolean;
}

/**
 * Vehicle Types card — pure assignment toggle.
 * Pricing (base fare, per-km/min, minimum, airport charge, distance bands, chips)
 * lives EXCLUSIVELY in the Fare Engine. This row only controls whether a vehicle
 * type is offered in this service area.
 */
export function VehicleTypePricingRow({
  serviceAreaId,
  vehicleType,
  currencyCode,
  onChanged,
}: Props) {
  const [row, setRow] = useState<SavRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('service_area_vehicle_pricing')
      .select('id, is_enabled')
      .eq('service_area_id', serviceAreaId)
      .eq('vehicle_type_id', vehicleType.id)
      .maybeSingle();
    setRow((data as SavRow | null) ?? null);
    setLoading(false);
  };

  useEffect(() => { load(); }, [serviceAreaId, vehicleType.id]);

  const toggleEnabled = async (next: boolean) => {
    setSaving(true);
    try {
      if (!row) {
        const { data, error } = await supabase
          .from('service_area_vehicle_pricing')
          .insert({
            service_area_id: serviceAreaId,
            vehicle_type_id: vehicleType.id,
            currency_code: currencyCode,
            is_enabled: next,
            base_fare: 0,
            minimum_fare: 0,
            per_km_rate_pence: 0,
            per_min_rate_pence: 0,
            airport_charge_pence: 0,
          })
          .select('id, is_enabled')
          .single();
        if (error) throw error;
        setRow(data as SavRow);
      } else {
        const { error } = await supabase
          .from('service_area_vehicle_pricing')
          .update({ is_enabled: next, updated_at: new Date().toISOString() })
          .eq('id', row.id);
        if (error) throw error;
        setRow({ ...row, is_enabled: next });
      }
      toast.success(next ? `${vehicleType.name} enabled` : `${vehicleType.name} disabled`);
      onChanged?.();
    } catch (e: any) {
      toast.error(e.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const isAssigned = row?.is_enabled ?? false;

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
    </div>
  );
}
