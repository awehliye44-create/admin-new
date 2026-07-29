import { useMemo, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import {
  useDeleteSpecialOffer,
  useDriverSpecialOffersAdmin,
  useDriverTierNames,
  useSaveSpecialOffer,
  useSaveSpecialOfferCategory,
  useSpecialOfferCategories,
  type SpecialOfferWithAreas,
} from '@/hooks/useDriverSpecialOffersAdmin';
import { normaliseUkPhone, validateSpecialOfferDraft } from '../../shared/driverSpecialOffersSSOT';

interface OfferDraft {
  id?: string;
  category_id: string | null;
  title: string;
  partner_name: string;
  short_description: string;
  full_details: string;
  badge_label: string;
  website_url: string;
  phone_number: string;
  email_address: string;
  promo_code: string;
  internal_route: string;
  banner_headline: string;
  banner_button_label: string;
  status: 'draft' | 'published' | 'archived';
  is_active: boolean;
  is_featured: boolean;
  show_in_home_banner: boolean;
  show_in_offer_list: boolean;
  starts_at: string;
  ends_at: string;
  minimum_completed_trips: string;
  new_drivers_only: boolean;
  eligible_driver_tiers: string[];
  display_order: number;
  serviceAreaIds: string[];
}

const emptyOffer: OfferDraft = {
  category_id: null,
  title: '',
  partner_name: '',
  short_description: '',
  full_details: '',
  badge_label: '',
  website_url: '',
  phone_number: '',
  email_address: '',
  promo_code: '',
  internal_route: '',
  banner_headline: '',
  banner_button_label: '',
  status: 'draft',
  is_active: true,
  is_featured: false,
  show_in_home_banner: false,
  show_in_offer_list: true,
  starts_at: '',
  ends_at: '',
  minimum_completed_trips: '',
  new_drivers_only: false,
  eligible_driver_tiers: [],
  display_order: 0,
  serviceAreaIds: [],
};

const toLocalInput = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');
const toIso = (v: string) => (v ? new Date(v).toISOString() : null);

function OfferDialog({ draft, onClose }: { draft: OfferDraft; onClose: () => void }) {
  const [form, setForm] = useState<OfferDraft>(draft);
  const save = useSaveSpecialOffer();
  const { data: categories = [] } = useSpecialOfferCategories();
  const { data: tiers = [] } = useDriverTierNames();
  const { data: areas = [] } = useServiceAreas({ activeOnly: true });

  const set = <K extends keyof OfferDraft>(key: K, value: OfferDraft[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = () => {
    const errors = validateSpecialOfferDraft({
      title: form.title,
      short_description: form.short_description,
      website_url: form.website_url || null,
      phone_number: form.phone_number || null,
      email_address: form.email_address || null,
      promo_code: form.promo_code || null,
      internal_route: form.internal_route || null,
      starts_at: toIso(form.starts_at),
      ends_at: toIso(form.ends_at),
      requires_action: true,
    });
    if (errors.length) {
      toast.error(errors[0]);
      return;
    }
    save.mutate(
      {
        id: form.id,
        category_id: form.category_id,
        title: form.title.trim(),
        partner_name: form.partner_name.trim() || null,
        short_description: form.short_description.trim(),
        full_details: form.full_details.trim() || null,
        badge_label: form.badge_label.trim() || null,
        website_url: form.website_url.trim() || null,
        phone_number: form.phone_number ? normaliseUkPhone(form.phone_number) : null,
        email_address: form.email_address.trim() || null,
        promo_code: form.promo_code.trim() || null,
        internal_route: form.internal_route.trim() || null,
        banner_headline: form.banner_headline.trim() || null,
        banner_button_label: form.banner_button_label.trim() || null,
        status: form.status,
        is_active: form.is_active,
        is_featured: form.is_featured,
        show_in_home_banner: form.show_in_home_banner,
        show_in_offer_list: form.show_in_offer_list,
        starts_at: toIso(form.starts_at),
        ends_at: toIso(form.ends_at),
        minimum_completed_trips: form.minimum_completed_trips ? Number(form.minimum_completed_trips) : null,
        new_drivers_only: form.new_drivers_only,
        eligible_driver_tiers: form.eligible_driver_tiers.length ? form.eligible_driver_tiers : null,
        display_order: form.display_order,
        serviceAreaIds: form.serviceAreaIds,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{form.id ? 'Edit special offer' : 'New special offer'}</DialogTitle>
          <DialogDescription>Driver App only — customers never see these offers.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Title</Label>
              <Input value={form.title} onChange={(e) => set('title', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Partner name</Label>
              <Input value={form.partner_name} onChange={(e) => set('partner_name', e.target.value)} />
            </div>
          </div>

          <div className="space-y-1">
            <Label>Short description</Label>
            <Input value={form.short_description} onChange={(e) => set('short_description', e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label>Full details</Label>
            <Textarea
              value={form.full_details}
              onChange={(e) => set('full_details', e.target.value)}
              className="min-h-[120px]"
            />
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label>Category</Label>
              <Select
                value={form.category_id ?? 'none'}
                onValueChange={(v) => set('category_id', v === 'none' ? null : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Uncategorised</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Badge label</Label>
              <Input value={form.badge_label} onChange={(e) => set('badge_label', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Display order</Label>
              <Input
                type="number"
                value={form.display_order}
                onChange={(e) => set('display_order', Number(e.target.value) || 0)}
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Website URL (https)</Label>
              <Input value={form.website_url} onChange={(e) => set('website_url', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Phone number (UK)</Label>
              <Input value={form.phone_number} onChange={(e) => set('phone_number', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Email address</Label>
              <Input value={form.email_address} onChange={(e) => set('email_address', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Promo code</Label>
              <Input value={form.promo_code} onChange={(e) => set('promo_code', e.target.value)} />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Banner headline</Label>
              <Input value={form.banner_headline} onChange={(e) => set('banner_headline', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Banner button label</Label>
              <Input
                value={form.banner_button_label}
                placeholder="View offers"
                onChange={(e) => set('banner_button_label', e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Starts at</Label>
              <Input type="datetime-local" value={form.starts_at} onChange={(e) => set('starts_at', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Ends at</Label>
              <Input type="datetime-local" value={form.ends_at} onChange={(e) => set('ends_at', e.target.value)} />
            </div>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <Label className="text-sm font-medium">Eligibility</Label>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Minimum completed trips</Label>
                <Input
                  type="number"
                  value={form.minimum_completed_trips}
                  onChange={(e) => set('minimum_completed_trips', e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <Switch checked={form.new_drivers_only} onCheckedChange={(v) => set('new_drivers_only', v)} />
                <Label className="text-sm">New drivers only (first 30 days)</Label>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Driver tiers (none selected = all tiers)</Label>
              <div className="flex flex-wrap gap-3">
                {tiers.map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={form.eligible_driver_tiers.includes(t)}
                      onCheckedChange={(v) =>
                        set(
                          'eligible_driver_tiers',
                          v
                            ? [...form.eligible_driver_tiers, t]
                            : form.eligible_driver_tiers.filter((x) => x !== t),
                        )
                      }
                    />
                    {t}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Service areas (none selected = all areas)</Label>
              <div className="flex flex-wrap gap-3">
                {areas.map((a) => (
                  <label key={a.id} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={form.serviceAreaIds.includes(a.id)}
                      onCheckedChange={(v) =>
                        set(
                          'serviceAreaIds',
                          v ? [...form.serviceAreaIds, a.id] : form.serviceAreaIds.filter((x) => x !== a.id),
                        )
                      }
                    />
                    {a.name}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => set('status', v as OfferDraft['status'])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft (hidden)</SelectItem>
                  <SelectItem value="published">Published (live)</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 pt-6">
              <div className="flex items-center gap-2">
                <Switch checked={form.is_active} onCheckedChange={(v) => set('is_active', v)} />
                <Label className="text-sm">Active</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={form.is_featured} onCheckedChange={(v) => set('is_featured', v)} />
                <Label className="text-sm">Featured</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={form.show_in_offer_list} onCheckedChange={(v) => set('show_in_offer_list', v)} />
                <Label className="text-sm">Show in offers list</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={form.show_in_home_banner} onCheckedChange={(v) => set('show_in_home_banner', v)} />
                <Label className="text-sm">Show home-screen banner</Label>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DriverSpecialOffers() {
  const { data: offers = [], isLoading } = useDriverSpecialOffersAdmin();
  const { data: categories = [] } = useSpecialOfferCategories();
  const saveCategory = useSaveSpecialOfferCategory();
  const deleteOffer = useDeleteSpecialOffer();
  const [dialog, setDialog] = useState<OfferDraft | null>(null);
  const [newCategory, setNewCategory] = useState('');

  const categoryName = useMemo(
    () => (id: string | null) => categories.find((c) => c.id === id)?.name ?? 'Uncategorised',
    [categories],
  );

  const toDraft = (o: SpecialOfferWithAreas): OfferDraft => ({
    id: o.id,
    category_id: o.category_id,
    title: o.title,
    partner_name: o.partner_name ?? '',
    short_description: o.short_description,
    full_details: o.full_details ?? '',
    badge_label: o.badge_label ?? '',
    website_url: o.website_url ?? '',
    phone_number: o.phone_number ?? '',
    email_address: o.email_address ?? '',
    promo_code: o.promo_code ?? '',
    internal_route: o.internal_route ?? '',
    banner_headline: o.banner_headline ?? '',
    banner_button_label: o.banner_button_label ?? '',
    status: o.status,
    is_active: o.is_active,
    is_featured: o.is_featured,
    show_in_home_banner: o.show_in_home_banner,
    show_in_offer_list: o.show_in_offer_list,
    starts_at: toLocalInput(o.starts_at),
    ends_at: toLocalInput(o.ends_at),
    minimum_completed_trips: o.minimum_completed_trips?.toString() ?? '',
    new_drivers_only: o.new_drivers_only,
    eligible_driver_tiers: o.eligible_driver_tiers ?? [],
    display_order: o.display_order,
    serviceAreaIds: o.service_area_ids,
  });

  return (
    <AdminLayout
      title="Driver Special Offers"
      description="Partner deals and perks shown in the Driver App only. Eligibility is enforced by the backend."
    >
      <div className="space-y-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Offer categories</CardTitle>
            <CardDescription className="text-xs">Optional grouping for the Driver App offers screen.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            {categories.map((c) => (
              <Badge key={c.id} variant={c.is_active ? 'default' : 'secondary'}>
                {c.name}
              </Badge>
            ))}
            <div className="flex gap-2 ml-auto">
              <Input
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="New category name"
                className="w-[220px]"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!newCategory.trim() || saveCategory.isPending}
                onClick={() =>
                  saveCategory.mutate(
                    { name: newCategory.trim(), display_order: categories.length, is_active: true },
                    { onSuccess: () => setNewCategory('') },
                  )
                }
              >
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Special offers</CardTitle>
              <CardDescription className="text-xs">
                Only published, active and in-date offers are delivered to eligible drivers.
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setDialog({ ...emptyOffer })}>
              <Plus className="h-4 w-4" /> New offer
            </Button>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : offers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No special offers yet.</p>
            ) : (
              <div className="space-y-2">
                {offers.map((o) => (
                  <div key={o.id} className="flex items-start justify-between rounded-md border p-3 gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {o.is_featured && <Star className="h-3.5 w-3.5 text-primary fill-primary" />}
                        <span className="font-medium text-sm">{o.title}</span>
                        <Badge variant={o.status === 'published' ? 'default' : 'secondary'}>{o.status}</Badge>
                        {!o.is_active && <Badge variant="outline">Inactive</Badge>}
                        {o.show_in_home_banner && <Badge variant="outline">Banner</Badge>}
                        <Badge variant="outline" className="font-normal">
                          {categoryName(o.category_id)}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{o.short_description}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setDialog(toDraft(o))}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive"
                        onClick={() => deleteOffer.mutate(o.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {dialog && <OfferDialog key={dialog.id ?? 'new'} draft={dialog} onClose={() => setDialog(null)} />}
    </AdminLayout>
  );
}
