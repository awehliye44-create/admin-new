import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { CheckCircle2, Loader2, Store } from 'lucide-react';

const CATEGORIES = [
  { value: 'food', label: 'Restaurant / Food' },
  { value: 'grocery', label: 'Grocery' },
  { value: 'retail', label: 'Retail' },
  { value: 'pharmacy', label: 'Pharmacy' },
  { value: 'parcel', label: 'Parcel / Courier' },
];

interface ServiceArea { id: string; name: string }

const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });

export default function MerchantApply() {
  const [areas, setAreas] = useState<ServiceArea[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [form, setForm] = useState({
    business_name: '',
    merchant_type: '',
    owner_name: '',
    email: '',
    phone: '',
    address: '',
    postcode: '',
    service_area_id: '',
    business_description: '',
    delivery_radius_km: '',
    prep_time_minutes: '',
  });
  const [logo, setLogo] = useState<File | null>(null);
  const [banner, setBanner] = useState<File | null>(null);

  useEffect(() => {
    supabase.from('service_areas').select('id,name').order('name')
      .then(({ data }) => setAreas((data as ServiceArea[]) ?? []));
  }, []);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const required = ['business_name','merchant_type','owner_name','email','phone','address','postcode','service_area_id','business_description'] as const;
    for (const k of required) {
      if (!form[k]) { toast({ title: 'Missing field', description: `Please fill in ${k.replace(/_/g,' ')}`, variant: 'destructive' }); return; }
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        business_name: form.business_name,
        merchant_type: form.merchant_type,
        owner_name: form.owner_name,
        email: form.email,
        phone: form.phone,
        address: form.address,
        postcode: form.postcode,
        service_area_id: form.service_area_id,
        business_description: form.business_description,
      };
      if (form.delivery_radius_km) payload.delivery_radius_km = Number(form.delivery_radius_km);
      if (form.prep_time_minutes) payload.prep_time_minutes = Number(form.prep_time_minutes);
      if (logo) { payload.logo_base64 = await fileToBase64(logo); payload.logo_mime = logo.type; }
      if (banner) { payload.banner_base64 = await fileToBase64(banner); payload.banner_mime = banner.type; }

      console.log('[merchant-apply] submitting', {
        business_name: form.business_name,
        email: form.email,
        merchant_type: form.merchant_type,
        service_area_id: form.service_area_id,
      });

      const { data, error } = await supabase.functions.invoke('merchant-signup', { body: payload });
      const result = data as { success?: boolean; application_id?: string; error?: string } | null;

      if (error || result?.error || !result?.application_id) {
        const message = result?.error || error?.message || 'Application could not be submitted. Please try again.';
        console.error('[merchant-apply] submission failed', { error: error?.message, result });
        toast({ title: 'Submission failed', description: message, variant: 'destructive' });
        return;
      }

      console.log('[merchant-apply] inserted application', { application_id: result.application_id });
      setDone(true);
    } catch (err: any) {
      console.error('[merchant-apply] unexpected error', err);
      toast({
        title: 'Submission failed',
        description: err?.message ?? 'Application could not be submitted. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <Card className="max-w-lg w-full">
          <CardHeader className="text-center">
            <CheckCircle2 className="h-14 w-14 text-emerald-500 mx-auto" />
            <CardTitle className="mt-3">Application submitted</CardTitle>
            <CardDescription>ONECAB will review your merchant account.</CardDescription>
          </CardHeader>
          <CardContent className="text-center text-sm text-muted-foreground">
            You'll receive an email at <strong>{form.email}</strong> once your application is approved.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background py-10 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-lg bg-primary/15 flex items-center justify-center">
            <Store className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">Become a ONECAB Merchant</h1>
            <p className="text-sm text-muted-foreground">Submit your business for approval to start receiving orders.</p>
          </div>
        </div>

        <Card>
          <CardContent className="p-6">
            <form onSubmit={onSubmit} className="space-y-5">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <Label>Business name *</Label>
                  <Input value={form.business_name} onChange={(e) => set('business_name', e.target.value)} maxLength={120} required />
                </div>
                <div>
                  <Label>Merchant type *</Label>
                  <Select value={form.merchant_type} onValueChange={(v) => set('merchant_type', v)}>
                    <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Service area *</Label>
                  <Select value={form.service_area_id} onValueChange={(v) => set('service_area_id', v)}>
                    <SelectTrigger><SelectValue placeholder="Select service area" /></SelectTrigger>
                    <SelectContent>
                      {areas.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Owner name *</Label>
                  <Input value={form.owner_name} onChange={(e) => set('owner_name', e.target.value)} maxLength={120} required />
                </div>
                <div>
                  <Label>Email *</Label>
                  <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} maxLength={255} required />
                </div>
                <div>
                  <Label>Phone *</Label>
                  <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} required />
                </div>
                <div>
                  <Label>Postcode *</Label>
                  <Input value={form.postcode} onChange={(e) => set('postcode', e.target.value)} maxLength={20} required />
                </div>
                <div className="sm:col-span-2">
                  <Label>Address *</Label>
                  <Input value={form.address} onChange={(e) => set('address', e.target.value)} maxLength={300} required />
                </div>
                <div className="sm:col-span-2">
                  <Label>Business description *</Label>
                  <Textarea rows={3} value={form.business_description} onChange={(e) => set('business_description', e.target.value)} maxLength={2000} required />
                </div>
                <div>
                  <Label>Delivery radius (km)</Label>
                  <Input type="number" min={0} max={100} value={form.delivery_radius_km} onChange={(e) => set('delivery_radius_km', e.target.value)} />
                </div>
                <div>
                  <Label>Prep time (minutes)</Label>
                  <Input type="number" min={0} max={600} value={form.prep_time_minutes} onChange={(e) => set('prep_time_minutes', e.target.value)} />
                </div>
                <div>
                  <Label>Logo</Label>
                  <Input type="file" accept="image/*" onChange={(e) => setLogo(e.target.files?.[0] ?? null)} />
                </div>
                <div>
                  <Label>Banner</Label>
                  <Input type="file" accept="image/*" onChange={(e) => setBanner(e.target.files?.[0] ?? null)} />
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Submitting…</> : 'Submit application'}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Your application will be reviewed by ONECAB. Pending merchants are not visible to customers.
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
