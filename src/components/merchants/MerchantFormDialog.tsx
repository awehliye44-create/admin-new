import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { useServiceAreas } from '@/hooks/useServiceAreas';

type Category = 'food' | 'grocery' | 'retail' | 'pharmacy' | 'parcel';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  merchant: any | null;
  onSaved: () => void;
}

const empty = {
  business_name: '',
  category: 'food' as Category,
  service_area_id: '',
  description: '',
  owner_name: '',
  phone: '',
  email: '',
  address: '',
  city: '',
  postcode: '',
  prep_time_minutes: 20,
  delivery_radius_km: 5,
  min_order_amount: 0,
  commission_pct: null as number | null,
  is_open: true,
  logo_url: '',
  banner_url: '',
};

export function MerchantFormDialog({ open, onOpenChange, merchant, onSaved }: Props) {
  const { data: serviceAreas } = useServiceAreas();
  const [form, setForm] = useState<any>(empty);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (merchant) setForm({ ...empty, ...merchant });
    else setForm({ ...empty, service_area_id: serviceAreas?.[0]?.id ?? '' });
  }, [merchant, open, serviceAreas]);

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const uploadImage = async (bucket: string, file: File): Promise<string | null> => {
    const path = `${crypto.randomUUID()}-${file.name}`;
    const { error } = await supabase.storage.from(bucket).upload(path, file, { upsert: true });
    if (error) { toast({ title: 'Upload failed', description: error.message, variant: 'destructive' }); return null; }
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  };

  const save = async () => {
    if (!form.business_name || !form.service_area_id) {
      return toast({ title: 'Missing fields', description: 'Business name and service area are required', variant: 'destructive' });
    }
    setSaving(true);
    const payload = {
      business_name: form.business_name,
      category: form.category,
      service_area_id: form.service_area_id,
      description: form.description || null,
      owner_name: form.owner_name || null,
      phone: form.phone || null,
      email: form.email || null,
      address: form.address || null,
      city: form.city || null,
      postcode: form.postcode || null,
      prep_time_minutes: Number(form.prep_time_minutes) || 20,
      delivery_radius_km: Number(form.delivery_radius_km) || 5,
      min_order_amount: Number(form.min_order_amount) || 0,
      commission_pct: form.commission_pct === '' || form.commission_pct === null ? null : Number(form.commission_pct),
      is_open: !!form.is_open,
      logo_url: form.logo_url || null,
      banner_url: form.banner_url || null,
    };
    const { error } = merchant
      ? await supabase.from('merchants').update(payload).eq('id', merchant.id)
      : await supabase.from('merchants').insert(payload);
    setSaving(false);
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: merchant ? 'Updated' : 'Created' });
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{merchant ? 'Edit Merchant' : 'Add Merchant'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Business name *</Label>
              <Input value={form.business_name} onChange={(e) => set('business_name', e.target.value)} />
            </div>
            <div>
              <Label>Merchant type</Label>
              <Select value={form.category} onValueChange={(v) => set('category', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(['food','grocery','retail','pharmacy','parcel'] as Category[]).map((c) =>
                    <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <Label>Service area *</Label>
              <Select value={form.service_area_id} onValueChange={(v) => set('service_area_id', v)}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {serviceAreas?.map((sa) => <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <Label>Description</Label>
              <Textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={2} />
            </div>
            <div><Label>Owner / contact name</Label><Input value={form.owner_name} onChange={(e) => set('owner_name', e.target.value)} /></div>
            <div><Label>Phone</Label><Input value={form.phone} onChange={(e) => set('phone', e.target.value)} /></div>
            <div className="col-span-2"><Label>Email</Label><Input value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
            <div className="col-span-2"><Label>Address</Label><Input value={form.address} onChange={(e) => set('address', e.target.value)} /></div>
            <div><Label>City</Label><Input value={form.city} onChange={(e) => set('city', e.target.value)} /></div>
            <div><Label>Postcode</Label><Input value={form.postcode} onChange={(e) => set('postcode', e.target.value)} /></div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Logo</Label>
              <Input type="file" accept="image/*" onChange={async (e) => {
                const f = e.target.files?.[0]; if (!f) return;
                const url = await uploadImage('merchant-logos', f); if (url) set('logo_url', url);
              }} />
              {form.logo_url && <img src={form.logo_url} className="mt-2 h-16 w-16 object-cover rounded" alt="" />}
            </div>
            <div>
              <Label>Banner</Label>
              <Input type="file" accept="image/*" onChange={async (e) => {
                const f = e.target.files?.[0]; if (!f) return;
                const url = await uploadImage('merchant-banners', f); if (url) set('banner_url', url);
              }} />
              {form.banner_url && <img src={form.banner_url} className="mt-2 h-16 w-32 object-cover rounded" alt="" />}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div><Label>Prep time (min)</Label><Input type="number" value={form.prep_time_minutes} onChange={(e) => set('prep_time_minutes', e.target.value)} /></div>
            <div><Label>Delivery radius (km)</Label><Input type="number" value={form.delivery_radius_km} onChange={(e) => set('delivery_radius_km', e.target.value)} /></div>
            <div><Label>Min order</Label><Input type="number" value={form.min_order_amount} onChange={(e) => set('min_order_amount', e.target.value)} /></div>
          </div>

          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <Label>Commission % (override; blank = global 15%)</Label>
              <Input type="number" value={form.commission_pct ?? ''} onChange={(e) => set('commission_pct', e.target.value === '' ? null : Number(e.target.value))} />
            </div>
            <div className="flex items-center justify-between border rounded-lg p-3">
              <Label>Store open</Label>
              <Switch checked={form.is_open} onCheckedChange={(v) => set('is_open', v)} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
