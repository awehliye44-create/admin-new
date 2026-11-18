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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Pencil, Plus, Archive } from 'lucide-react';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { useRegions } from '@/hooks/useRegions';
import {
  useArchiveDriverTripBonusCampaign,
  useDriverTripBonusCampaignsAdmin,
  useSaveDriverTripBonusCampaign,
  type TripBonusCampaignWithAreas,
} from '@/hooks/useDriverTripBonusesAdmin';
import {
  validateCampaignDraft,
  type TripBonusCampaignStatus,
  type TripBonusScopeType,
} from '../../shared/driverTripBonusCampaignSSOT';

interface Draft {
  id?: string;
  title: string;
  card_headline: string;
  card_body: string;
  trip_target: string;
  bonus_pounds: string;
  status: TripBonusCampaignStatus;
  is_active: boolean;
  starts_at: string;
  ends_at: string;
  scope_type: TripBonusScopeType;
  region_id: string | null;
  display_priority: string;
  serviceAreaIds: string[];
}

const emptyDraft = (): Draft => ({
  title: '',
  card_headline: '',
  card_body: '',
  trip_target: '10',
  bonus_pounds: '20.00',
  status: 'draft',
  is_active: true,
  starts_at: '',
  ends_at: '',
  scope_type: 'selected_service_areas',
  region_id: null,
  display_priority: '0',
  serviceAreaIds: [],
});

function poundsToPence(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function penceToPounds(pence: number): string {
  return (Math.max(0, pence) / 100).toFixed(2);
}

function toDraft(row: TripBonusCampaignWithAreas): Draft {
  return {
    id: row.id,
    title: row.title,
    card_headline: row.card_headline,
    card_body: row.card_body ?? '',
    trip_target: String(row.trip_target),
    bonus_pounds: penceToPounds(row.bonus_amount_pence),
    status: row.status,
    is_active: row.is_active,
    starts_at: row.starts_at ? row.starts_at.slice(0, 16) : '',
    ends_at: row.ends_at ? row.ends_at.slice(0, 16) : '',
    scope_type: row.scope_type,
    region_id: row.region_id,
    display_priority: String(row.display_priority ?? 0),
    serviceAreaIds: row.service_area_ids ?? [],
  };
}

export default function DriverTripBonuses() {
  const { data: campaigns = [], isLoading } = useDriverTripBonusCampaignsAdmin();
  const {
    data: serviceAreas = [],
    isLoading: areasLoading,
    isError: areasError,
  } = useServiceAreas({ pageSlug: 'driver-trip-bonuses', activeOnly: true });
  const { data: regions = [] } = useRegions();
  const save = useSaveDriverTripBonusCampaign();
  const archive = useArchiveDriverTripBonusCampaign();

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [formError, setFormError] = useState<string | null>(null);

  const activeAreas = useMemo(
    () => (serviceAreas as Array<{ id: string; name: string; is_active?: boolean }>),
    [serviceAreas],
  );

  const openCreate = () => {
    setDraft(emptyDraft());
    setFormError(null);
    setOpen(true);
  };

  const openEdit = (row: TripBonusCampaignWithAreas) => {
    setDraft(toDraft(row));
    setFormError(null);
    setOpen(true);
  };

  const onSave = async () => {
    const tripTarget = Number(draft.trip_target);
    const bonusPence = poundsToPence(draft.bonus_pounds);
    const errors = validateCampaignDraft({
      title: draft.title,
      card_headline: draft.card_headline,
      trip_target: tripTarget,
      bonus_amount_pence: bonusPence,
      scope_type: draft.scope_type,
      region_id: draft.region_id,
      service_area_ids: draft.serviceAreaIds,
    });
    if (errors.length) {
      setFormError(errors.join(', '));
      return;
    }
    setFormError(null);
    await save.mutateAsync({
      id: draft.id,
      title: draft.title.trim(),
      card_headline: draft.card_headline.trim(),
      card_body: draft.card_body.trim(),
      trip_target: tripTarget,
      bonus_amount_pence: bonusPence,
      status: draft.status,
      is_active: draft.is_active,
      starts_at: draft.starts_at ? new Date(draft.starts_at).toISOString() : null,
      ends_at: draft.ends_at ? new Date(draft.ends_at).toISOString() : null,
      scope_type: draft.scope_type,
      region_id: draft.scope_type === 'global' ? null : draft.region_id,
      display_priority: Number(draft.display_priority) || 0,
      service_area_ids: draft.serviceAreaIds,
    });
    setOpen(false);
  };

  return (
    <AdminLayout>
      <div className="space-y-6 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Driver Trip Bonuses</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Service-area progress campaigns. Drivers see a white Home progress card; hitting the
              trip target credits a BONUS wallet row (payout-eligible).
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-2" />
            New campaign
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Campaigns</CardTitle>
            <CardDescription>
              Separate from Driver Special Offers (partner content / gold banner).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Bonus</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead className="w-[100px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {campaigns.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.title}</TableCell>
                      <TableCell>{c.trip_target} trips</TableCell>
                      <TableCell>£{penceToPounds(c.bonus_amount_pence)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{c.scope_type}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={c.status === 'published' ? 'default' : 'secondary'}>
                          {c.status}
                          {!c.is_active ? ' (off)' : ''}
                        </Badge>
                      </TableCell>
                      <TableCell>{c.display_priority}</TableCell>
                      <TableCell className="flex gap-1">
                        <Button size="icon" variant="ghost" onClick={() => openEdit(c)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        {c.status !== 'archived' && (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => archive.mutate(c.id)}
                          >
                            <Archive className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!campaigns.length && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                        No trip-bonus campaigns yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{draft.id ? 'Edit campaign' : 'New campaign'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label>Title</Label>
              <Input
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </div>
            <div>
              <Label>Home card headline</Label>
              <Input
                value={draft.card_headline}
                onChange={(e) => setDraft((d) => ({ ...d, card_headline: e.target.value }))}
              />
            </div>
            <div>
              <Label>Home card body</Label>
              <Textarea
                value={draft.card_body}
                onChange={(e) => setDraft((d) => ({ ...d, card_body: e.target.value }))}
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Trip target</Label>
                <Input
                  type="number"
                  min={1}
                  value={draft.trip_target}
                  onChange={(e) => setDraft((d) => ({ ...d, trip_target: e.target.value }))}
                />
              </div>
              <div>
                <Label>Bonus (£)</Label>
                <Input
                  value={draft.bonus_pounds}
                  onChange={(e) => setDraft((d) => ({ ...d, bonus_pounds: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Status</Label>
                <Select
                  value={draft.status}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, status: v as TripBonusCampaignStatus }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="published">Published</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Display priority</Label>
                <Input
                  type="number"
                  value={draft.display_priority}
                  onChange={(e) => setDraft((d) => ({ ...d, display_priority: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label>Active</Label>
              <Switch
                checked={draft.is_active}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, is_active: v }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Starts</Label>
                <Input
                  type="datetime-local"
                  value={draft.starts_at}
                  onChange={(e) => setDraft((d) => ({ ...d, starts_at: e.target.value }))}
                />
              </div>
              <div>
                <Label>Ends</Label>
                <Input
                  type="datetime-local"
                  value={draft.ends_at}
                  onChange={(e) => setDraft((d) => ({ ...d, ends_at: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Scope</Label>
              <Select
                value={draft.scope_type}
                onValueChange={(v) =>
                  setDraft((d) => ({ ...d, scope_type: v as TripBonusScopeType }))
                }
              >
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
            {draft.scope_type === 'entire_region' && (
              <div>
                <Label>Region</Label>
                <Select
                  value={draft.region_id ?? ''}
                  onValueChange={(v) => setDraft((d) => ({ ...d, region_id: v || null }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select region" />
                  </SelectTrigger>
                  <SelectContent>
                    {(regions as Array<{ id: string; name: string }>).map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {draft.scope_type === 'selected_service_areas' && (
              <div className="space-y-2 max-h-40 overflow-y-auto border rounded-md p-2">
                <Label>Service areas</Label>
                {areasLoading && (
                  <p className="text-sm text-muted-foreground py-2">Loading service areas…</p>
                )}
                {!areasLoading && areasError && (
                  <p className="text-sm text-destructive py-2">
                    Could not load service areas. Check page access and try again.
                  </p>
                )}
                {!areasLoading && !areasError && activeAreas.length === 0 && (
                  <p className="text-sm text-muted-foreground py-2">No active service areas found.</p>
                )}
                {activeAreas.map((a) => {
                  const checked = draft.serviceAreaIds.includes(a.id);
                  return (
                    <label key={a.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) =>
                          setDraft((d) => ({
                            ...d,
                            serviceAreaIds: v
                              ? [...d.serviceAreaIds, a.id]
                              : d.serviceAreaIds.filter((id) => id !== a.id),
                          }))
                        }
                      />
                      {a.name}
                    </label>
                  );
                })}
              </div>
            )}
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
