import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { Settings2 } from 'lucide-react';

type Category = 'food' | 'grocery' | 'retail' | 'pharmacy' | 'parcel';
const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'food', label: 'Food' },
  { key: 'grocery', label: 'Grocery' },
  { key: 'retail', label: 'Retail' },
  { key: 'pharmacy', label: 'Pharmacy' },
  { key: 'parcel', label: 'Parcel' },
];

interface SASetting {
  id: string;
  service_area_id: string;
  category: Category;
  enabled: boolean;
  delivery_enabled: boolean;
}

export default function MarketplaceSettings() {
  const { data: serviceAreas } = useServiceAreas();
  const [settings, setSettings] = useState<SASetting[]>([]);
  const [selectedSA, setSelectedSA] = useState<string>('');

  const load = async () => {
    const { data, error } = await supabase.from('service_area_merchant_settings').select('*');
    if (error) return toast({ title: 'Failed to load', description: error.message, variant: 'destructive' });
    setSettings((data as any) ?? []);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!selectedSA && serviceAreas?.length) setSelectedSA(serviceAreas[0].id);
  }, [serviceAreas, selectedSA]);

  const get = (cat: Category) => settings.find((s) => s.service_area_id === selectedSA && s.category === cat);

  // "Delivery enabled" master = any delivery_enabled across categories for this SA
  const deliveryMasterOn = CATEGORIES.some(({ key }) => get(key)?.delivery_enabled);

  const upsertSetting = async (cat: Category, patch: Partial<SASetting>) => {
    if (!selectedSA) return;
    const existing = get(cat);
    if (existing) {
      const { error } = await supabase
        .from('service_area_merchant_settings')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
      setSettings((p) => p.map((s) => (s.id === existing.id ? { ...s, ...patch } as SASetting : s)));
    } else {
      const payload: any = {
        service_area_id: selectedSA,
        category: cat,
        enabled: false,
        delivery_enabled: false,
        ...patch,
      };
      const { data, error } = await supabase
        .from('service_area_merchant_settings')
        .insert(payload)
        .select()
        .single();
      if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
      setSettings((p) => [...p, data as any]);
    }
  };

  const setDeliveryMaster = async (on: boolean) => {
    for (const { key } of CATEGORIES) await upsertSetting(key, { delivery_enabled: on });
    toast({ title: 'Updated', description: `Delivery ${on ? 'enabled' : 'disabled'} for this service area` });
  };

  return (
    <AdminLayout title="Marketplace Settings" description="Per-service-area marketplace visibility controls">
      <div className="space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Settings2 className="h-5 w-5" /> Service Area Marketplace</CardTitle>
            <CardDescription>
              Customer app only shows merchant types enabled here for the customer's service area.
              Disabling Delivery hides the marketplace entirely from customers in that area.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="max-w-sm">
              <Label className="mb-2 block">Service Area</Label>
              <Select value={selectedSA} onValueChange={setSelectedSA}>
                <SelectTrigger><SelectValue placeholder="Select service area" /></SelectTrigger>
                <SelectContent>
                  {serviceAreas?.map((sa) => <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {selectedSA && (
              <>
                <div className="flex items-center justify-between border rounded-lg p-4 bg-muted/30">
                  <div>
                    <div className="font-semibold">Delivery enabled</div>
                    <div className="text-xs text-muted-foreground">Master toggle for the marketplace in this service area.</div>
                  </div>
                  <Switch checked={deliveryMasterOn} onCheckedChange={setDeliveryMaster} />
                </div>

                <div>
                  <h3 className="font-semibold mb-2">Merchant types</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {CATEGORIES.map(({ key, label }) => {
                      const s = get(key);
                      return (
                        <div key={key} className="flex items-center justify-between border rounded-lg p-3">
                          <Label>{label}</Label>
                          <Switch
                            checked={!!s?.enabled}
                            onCheckedChange={(v) => upsertSetting(key, { enabled: v })}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground mt-3">
                    Only approved merchants whose type is enabled here appear in the customer app for this service area.
                    Pending, Rejected, Disabled, or Suspended merchants are never visible to customers.
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
