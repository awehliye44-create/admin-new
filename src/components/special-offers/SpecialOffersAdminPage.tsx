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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { useRegions } from '@/hooks/useRegions';
import {
  useDeleteSpecialOffer,
  useDriverTierNames,
  useSaveSpecialOffer,
  useSaveSpecialOfferCategory,
  useSpecialOfferCategories,
  useSpecialOffersAdmin,
  type OfferAudience,
  type SpecialOfferWithAreas,
} from '@/hooks/useDriverSpecialOffersAdmin';
import {
  describeOfferScope,
  validateOfferScope,
  validateSpecialOfferDraft,
  GLOBAL_SCOPE_CONFIRMATION,
  type OfferScopeType,
} from '../../../shared/driverSpecialOffersSSOT';

const ALL = '__all__';

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
  scope_type: OfferScopeType;
  region_id: string | null;
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
  scope_type: 'selected_service_areas',
  region_id: null,
  serviceAreaIds: [],
};

const toLocalInput = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');
const toIso = (v: string) => (v ? new Date(v).toISOString() : null);

function OfferDialog({
  draft,
  audience,
  onClose,
}: {
  draft: OfferDraft;
  audience: OfferAudience;
  onClose: () => void;
}) {
  const isDriver = audience === 'driver';
  const [form, setForm] = useState<OfferDraft>(draft);
  const [areaSearch, setAreaSearch] = useState('');
  const [globalConfirmed, setGlobalConfirmed] = useState(draft.scope_type === 'global');
  const save = useSaveSpecialOffer(audience);
  const { data: categories = [] } = useSpecialOfferCategories(audience);
  const { data: tiers = [] } = useDriverTierNames(isDriver);
  const { data: areas = [] } = useServiceAreas({ activeOnly: true });
  const { data: regions = [] } = useRegions();

  const regionName = (id: string | null) => regions.find((r) => r.id === id)?.name ?? null;

  const activeAreaMap = useMemo(() => {
    const m: Record<string, string> = {};
    areas.forEach((a) => {
      m[a.id] = a.region_id;
    });
    return m;
  }, [areas]);

  const visibleAreas = useMemo(() => {
    const q = areaSearch.trim().toLowerCase();
    return areas
      .filter((a) => (form.region_id ? a.region_id === form.region_id : true))
      .filter((a) => (q ? a.name.toLowerCase().includes(q) : true));
  }, [areas, form.region_id, areaSearch]);

  const set = <K extends keyof OfferDraft>(key: K, value: OfferDraft[K]) => setForm((f) => ({ ...f, [key]: value }));

  const setScope = (scope: OfferScopeType) => {
    setForm((f) => ({
      ...f,
      scope_type: scope,
      region_id: scope === 'global' ? null : f.region_id,
      serviceAreaIds: scope === 'selected_service_areas' ? f.serviceAreaIds : [],
    }));
    if (scope !== 'global') setGlobalConfirmed(false);
  };

  const submit = () => {
    const errors = [
      ...validateSpecialOfferDraft({
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
      }),
      ...validateOfferScope({
        scope_type: form.scope_type,
        region_id: form.region_id,
        serviceAreaIds: form.serviceAreaIds,
        status: form.status,
        activeServiceAreas: activeAreaMap,
      }),
    ];
    if (form.scope_type === 'global' && !globalConfirmed) {
      errors.push('Confirm the global availability warning before saving.');
    }
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
        phone_number: form.phone_number.trim() || null,
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
        scope_type: form.scope_type,
        region_id: form.scope_type === 'global' ? null : form.region_id,
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
          <DialogDescription>
            {isDriver
              ? 'Driver App only — customers never see these offers.'
              : 'Customer App only — drivers never see these offers.'}
          </DialogDescription>
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

          {/* ---------------- Availability area ---------------- */}
          <div className="space-y-3 rounded-md border p-3">
            <div>
              <Label className="text-sm font-medium">Availability area</Label>
              <p className="text-xs text-muted-foreground">
                Offers are scoped by Region → Service Area.{' '}
                {isDriver
                  ? 'Drivers only see offers for their assigned service area.'
                  : 'Customers only see offers for their pickup service area.'}
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Scope type</Label>
                <Select value={form.scope_type} onValueChange={(v) => setScope(v as OfferScopeType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="selected_service_areas">Selected service areas</SelectItem>
                    <SelectItem value="entire_region">Entire region</SelectItem>
                    <SelectItem value="global">Global</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {form.scope_type !== 'global' && (
                <div className="space-y-1">
                  <Label className="text-xs">
                    Region {form.scope_type === 'entire_region' ? '(required)' : '(optional filter)'}
                  </Label>
                  <Select
                    value={form.region_id ?? ALL}
                    onValueChange={(v) => setForm((f) => ({
                      ...f,
                      region_id: v === ALL ? null : v,
                      serviceAreaIds:
                        v === ALL
                          ? f.serviceAreaIds
                          : f.serviceAreaIds.filter((id) => activeAreaMap[id] === v),
                    }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>All regions</SelectItem>
                      {regions.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {form.scope_type === 'entire_region' && (
              <p className="text-xs text-muted-foreground">
                Entire region includes current <strong>and future</strong> active service areas in that Region until
                the offer expires or is changed.
              </p>
            )}

            {form.scope_type === 'selected_service_areas' && (
              <div className="space-y-2">
                <Label className="text-xs">Service areas (at least one required)</Label>
                <Input
                  placeholder="Search service areas…"
                  value={areaSearch}
                  onChange={(e) => setAreaSearch(e.target.value)}
                />
                <div className="max-h-48 overflow-y-auto rounded border p-2 space-y-1">
                  {visibleAreas.length === 0 && (
                    <p className="text-xs text-muted-foreground">No active service areas match.</p>
                  )}
                  {visibleAreas.map((a) => (
                    <label key={a.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={form.serviceAreaIds.includes(a.id)}
                        onCheckedChange={(v) =>
                          set(
                            'serviceAreaIds',
                            v ? [...form.serviceAreaIds, a.id] : form.serviceAreaIds.filter((x) => x !== a.id),
                          )
                        }
                      />
                      <span>{a.name}</span>
                      <span className="text-xs text-muted-foreground">{regionName(a.region_id) ?? '—'}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Only the selected service areas receive this offer. Future service areas do not inherit it.
                </p>
              </div>
            )}

            {form.scope_type === 'global' && (
              <label className="flex items-start gap-2 rounded border border-destructive/40 p-2 text-sm">
                <Checkbox checked={globalConfirmed} onCheckedChange={(v) => setGlobalConfirmed(Boolean(v))} />
                <span>{GLOBAL_SCOPE_CONFIRMATION}</span>
              </label>
            )}
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
              <Label>Phone number (local to the service area)</Label>
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

          {isDriver && (
          <div className="space-y-2 rounded-md border p-3">
            <Label className="text-sm font-medium">Driver eligibility</Label>
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
          </div>
          )}

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

export default function SpecialOffersAdminPage({ audience }: { audience: OfferAudience }) {
  const isDriver = audience === 'driver';
  const { data: offers = [], isLoading } = useSpecialOffersAdmin(audience);
  const { data: categories = [] } = useSpecialOfferCategories(audience);
  const { data: areas = [] } = useServiceAreas();
  const { data: regions = [] } = useRegions();
  const saveCategory = useSaveSpecialOfferCategory(audience);
  const deleteOffer = useDeleteSpecialOffer(audience);
  const [dialog, setDialog] = useState<OfferDraft | null>(null);
  const [newCategory, setNewCategory] = useState('');
  const [areasDialog, setAreasDialog] = useState<SpecialOfferWithAreas | null>(null);

  const [regionFilter, setRegionFilter] = useState<string>(ALL);
  const [areaFilter, setAreaFilter] = useState<string>(ALL);
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL);
  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [activeDate, setActiveDate] = useState<string>('');
  const [search, setSearch] = useState('');

  const areaById = useMemo(() => new Map(areas.map((a) => [a.id, a])), [areas]);
  const regionById = useMemo(() => new Map(regions.map((r) => [r.id, r])), [regions]);

  const filterAreas = useMemo(
    () => areas.filter((a) => (regionFilter === ALL ? true : a.region_id === regionFilter)),
    [areas, regionFilter],
  );

  const offerAreaNames = (o: SpecialOfferWithAreas) =>
    o.service_area_ids.map((id) => areaById.get(id)?.name ?? 'Unknown area');

  const scopeCoversArea = (o: SpecialOfferWithAreas, serviceAreaId: string) => {
    if (o.scope_type === 'global') return true;
    if (o.scope_type === 'entire_region') return areaById.get(serviceAreaId)?.region_id === o.region_id;
    return o.service_area_ids.includes(serviceAreaId);
  };

  const scopeCoversRegion = (o: SpecialOfferWithAreas, regionId: string) => {
    if (o.scope_type === 'global') return true;
    if (o.scope_type === 'entire_region') return o.region_id === regionId;
    return o.service_area_ids.some((id) => areaById.get(id)?.region_id === regionId);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const dateTs = activeDate ? new Date(activeDate).getTime() : null;
    return offers.filter((o) => {
      if (regionFilter !== ALL && !scopeCoversRegion(o, regionFilter)) return false;
      if (areaFilter !== ALL && !scopeCoversArea(o, areaFilter)) return false;
      if (categoryFilter !== ALL && o.category_id !== categoryFilter) return false;
      if (statusFilter !== ALL && o.status !== statusFilter) return false;
      if (dateTs !== null) {
        if (o.starts_at && new Date(o.starts_at).getTime() > dateTs) return false;
        if (o.ends_at && new Date(o.ends_at).getTime() <= dateTs) return false;
      }
      if (q) {
        const hay = `${o.title} ${o.partner_name ?? ''} ${o.short_description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [offers, regionFilter, areaFilter, categoryFilter, statusFilter, activeDate, search, areaById]);

  const summary = useMemo(() => {
    const active = offers.filter((o) => o.status === 'published' && o.is_active);
    const regionSet = new Set<string>();
    const areaSet = new Set<string>();
    let global = 0;
    offers.forEach((o) => {
      if (o.scope_type === 'global') global += 1;
      if (o.scope_type === 'entire_region' && o.region_id) {
        regionSet.add(o.region_id);
        areas.filter((a) => a.region_id === o.region_id).forEach((a) => areaSet.add(a.id));
      }
      o.service_area_ids.forEach((id) => {
        areaSet.add(id);
        const r = areaById.get(id)?.region_id;
        if (r) regionSet.add(r);
      });
    });
    const soon = Date.now() + 14 * 86_400_000;
    const expiring = active.filter((o) => o.ends_at && new Date(o.ends_at).getTime() <= soon).length;
    return {
      total: offers.length,
      active: active.length,
      regions: regionSet.size,
      areas: areaSet.size,
      expiring,
      global,
    };
  }, [offers, areas, areaById]);

  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? 'Uncategorised';

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
    scope_type: o.scope_type ?? 'selected_service_areas',
    region_id: o.region_id ?? null,
    serviceAreaIds: o.service_area_ids,
  });

  const summaryCards = [
    { label: 'Total offers', value: summary.total },
    { label: 'Active offers', value: summary.active },
    { label: 'Regions covered', value: summary.regions },
    { label: 'Service areas covered', value: summary.areas },
    { label: 'Expiring soon', value: summary.expiring },
  ];

  return (
    <AdminLayout
      title={isDriver ? 'Driver Special Offers' : 'Customer Special Offers'}
      description={
        isDriver
          ? 'Manage Driver App partner offers by Region and Service Area'
          : 'Manage Customer App offers and promotions by Region and Service Area'
      }
    >
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {summaryCards.map((c) => (
            <Card key={c.label}>
              <CardHeader className="pb-2">
                <CardDescription className="text-xs">{c.label}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{c.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Offer categories</CardTitle>
            <CardDescription className="text-xs">
              Optional grouping for the {isDriver ? 'Driver' : 'Customer'} App offers screen.
            </CardDescription>
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
                className="w-56"
              />
              <Button
                variant="outline"
                onClick={() => {
                  if (!newCategory.trim()) return;
                  saveCategory.mutate(
                    { name: newCategory.trim(), display_order: categories.length, is_active: true },
                    { onSuccess: () => setNewCategory('') },
                  );
                }}
              >
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Offers</CardTitle>
              <CardDescription className="text-xs">
                {isDriver
                  ? 'Drivers only see offers scoped to their assigned service area.'
                  : 'Customers only see offers scoped to their pickup service area.'}
              </CardDescription>
            </div>
            <Button onClick={() => setDialog({ ...emptyOffer })}>
              <Plus className="h-4 w-4" /> New offer
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-6">
              <Select
                value={regionFilter}
                onValueChange={(v) => {
                  setRegionFilter(v);
                  setAreaFilter(ALL);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Region" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All regions</SelectItem>
                  {regions.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={areaFilter} onValueChange={setAreaFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Service area" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All service areas</SelectItem>
                  {filterAreas.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {!a.is_active ? ' (inactive)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All categories</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>

              <Input type="date" value={activeDate} onChange={(e) => setActiveDate(e.target.value)} />

              <Input
                placeholder="Search offers…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {isLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Offer</TableHead>
                    <TableHead>Partner</TableHead>
                    <TableHead>Region / Scope</TableHead>
                    <TableHead>Service areas</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Start / End</TableHead>
                    <TableHead>Banner</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-sm text-muted-foreground py-8">
                        No offers match the selected filters.
                      </TableCell>
                    </TableRow>
                  )}
                  {filtered.map((o) => {
                    const names = offerAreaNames(o);
                    return (
                      <TableRow key={o.id}>
                        <TableCell className="font-medium">
                          <span className="flex items-center gap-1">
                            {o.is_featured && <Star className="h-3.5 w-3.5 text-primary" />}
                            {o.title}
                          </span>
                        </TableCell>
                        <TableCell>{o.partner_name ?? '—'}</TableCell>
                        <TableCell className="text-sm">
                          {o.scope_type === 'global'
                            ? 'Global'
                            : o.scope_type === 'entire_region'
                              ? `All service areas in ${regionById.get(o.region_id ?? '')?.name ?? '—'}`
                              : o.region_id
                                ? regionById.get(o.region_id)?.name ?? 'Selected areas'
                                : 'Selected areas'}
                        </TableCell>
                        <TableCell className="text-sm">
                          {o.scope_type === 'selected_service_areas' ? (
                            <button
                              type="button"
                              className="underline underline-offset-2"
                              onClick={() => setAreasDialog(o)}
                            >
                              {describeOfferScope(o, names)}
                            </button>
                          ) : (
                            describeOfferScope(o, names, regionById.get(o.region_id ?? '')?.name)
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{categoryName(o.category_id)}</TableCell>
                        <TableCell className="text-xs">
                          {o.starts_at ? new Date(o.starts_at).toLocaleDateString() : '—'} →{' '}
                          {o.ends_at ? new Date(o.ends_at).toLocaleDateString() : 'No end'}
                        </TableCell>
                        <TableCell>{o.show_in_home_banner ? <Badge variant="outline">Banner</Badge> : '—'}</TableCell>
                        <TableCell>
                          <Badge variant={o.status === 'published' && o.is_active ? 'default' : 'secondary'}>
                            {o.status === 'published' && !o.is_active ? 'paused' : o.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="icon" variant="ghost" onClick={() => setDialog(toDraft(o))}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => {
                              if (confirm(`Delete “${o.title}”?`)) deleteOffer.mutate(o.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {dialog && <OfferDialog draft={dialog} audience={audience} onClose={() => setDialog(null)} />}

      {areasDialog && (
        <Dialog open onOpenChange={(o) => !o && setAreasDialog(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Service areas — {areasDialog.title}</DialogTitle>
              <DialogDescription>Complete availability assignment for this offer.</DialogDescription>
            </DialogHeader>
            <ul className="space-y-1 text-sm">
              {areasDialog.service_area_ids.length === 0 && <li>No service areas assigned.</li>}
              {areasDialog.service_area_ids.map((id) => {
                const a = areaById.get(id);
                return (
                  <li key={id} className="flex items-center justify-between">
                    <span>{a?.name ?? 'Unknown area'}</span>
                    <span className="text-xs text-muted-foreground">
                      {regionById.get(a?.region_id ?? '')?.name ?? '—'}
                      {a && !a.is_active ? ' · inactive' : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </DialogContent>
        </Dialog>
      )}
    </AdminLayout>
  );
}
