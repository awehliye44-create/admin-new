import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useRoleCapabilities } from '@/hooks/useRoleCapabilities';
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react';
import {
  ALL_SERVICE_AREAS,
  ALL_SERVICE_AREAS_MESSAGE,
  DEMAND_ZONE_ACTION_KEYS,
  DEFAULT_LEVEL_COLOURS,
  canConfigureForSelection,
  validateDemandZoneSettings,
  type DemandZoneSettings,
} from '../../../shared/demandZoneSurgeSSOT';
import {
  buildDemandZoneSettingsSavePayload,
  demandZoneSettingsFormsEqual,
  formatDemandZoneSettingsLoadError,
  mapDemandZoneSettingsRowToForm,
  pickDemandZoneSettingsRow,
  safeHexColourForDisplay,
  serverSettingsAreNewerThanBaseline,
  starterDemandZoneSettingsForm,
  verifyDemandZoneSettingsSaved,
  type DemandZoneSettingsFormState,
  type DemandZoneSettingsLoadStatus,
} from '@/lib/demandZoneSettingsForm';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serviceAreaId: string;
  serviceAreaName: string;
  /** Optional row already loaded by the page list query — used as cache/fallback. */
  prefetchedSettings?: Partial<DemandZoneSettings> | null;
}

export const DEMAND_ZONE_SETTINGS_SELECT =
  'id,service_area_id,surge_enabled,heat_map_enabled,manual_zones_enabled,recompute_interval_minutes,consecutive_checks_required,zone_radius_meters,open_trip_max_lifetime_minutes,low_min_trips,low_max_trips,medium_min_trips,medium_max_trips,high_min_trips,multiplier_low,multiplier_medium,multiplier_high,max_multiplier,colour_low,colour_medium,colour_high,updated_by,created_at,updated_at';

export function DemandZoneSettingsDialog({
  open,
  onOpenChange,
  serviceAreaId,
  serviceAreaName,
  prefetchedSettings = null,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { actor, isLoading: capsLoading } = useRoleCapabilities();

  const [form, setForm] = useState<DemandZoneSettingsFormState>(starterDemandZoneSettingsForm);
  const [baseline, setBaseline] = useState<DemandZoneSettingsFormState | null>(null);
  const [hydratedServiceAreaId, setHydratedServiceAreaId] = useState<string | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [serverConflict, setServerConflict] = useState(false);
  /** Fingerprint of server row for which the admin dismissed the conflict banner. */
  const [conflictDismissedFor, setConflictDismissedFor] = useState<string | null>(null);
  const [seededForCreate, setSeededForCreate] = useState(false);
  /** Raw text buffers so typing decimals ("1." → "1.15") is never re-formatted mid-edit. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const isAllAreas = !serviceAreaId || serviceAreaId === ALL_SERVICE_AREAS;

  const can = (actionKey: (typeof DEMAND_ZONE_ACTION_KEYS)[keyof typeof DEMAND_ZONE_ACTION_KEYS]) =>
    canConfigureForSelection({
      selectedServiceAreaId: serviceAreaId,
      isSuperAdmin: actor.isSuperAdmin,
      allowedActions: actor.allowedActions,
      actionKey,
    });

  const canHeatMap = can(DEMAND_ZONE_ACTION_KEYS.configureHeatMap);
  const canColours = can(DEMAND_ZONE_ACTION_KEYS.configureColours);
  const canSurge = can(DEMAND_ZONE_ACTION_KEYS.configureSurge);
  const readOnly = !canHeatMap && !canColours && !canSurge;

  const cachedFromParent = useMemo(() => {
    if (!prefetchedSettings || isAllAreas) return null;
    if (prefetchedSettings.service_area_id && prefetchedSettings.service_area_id !== serviceAreaId) {
      return null;
    }
    return prefetchedSettings as DemandZoneSettings;
  }, [prefetchedSettings, isAllAreas, serviceAreaId]);

  const {
    data: settings,
    isPending,
    isError,
    error: loadError,
    isSuccess,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['demand-zone-settings', serviceAreaId],
    enabled: open && !isAllAreas,
    // Prefer already-loaded page data so the dialog is not blocked by a flaky single-row read.
    initialData: () => {
      const fromAll = queryClient.getQueryData<DemandZoneSettings[]>(['demand-zone-settings-all']);
      const match = fromAll?.find((row) => row.service_area_id === serviceAreaId);
      return match ?? cachedFromParent ?? undefined;
    },
    initialDataUpdatedAt: 0,
    queryFn: async () => {
      // Avoid maybeSingle(): duplicate rows for one service_area_id yield PGRST116 and blank the dialog
      // even though the list query on this page succeeds.
      const { data, error } = await supabase
        .from('service_area_demand_zone_settings')
        .select(DEMAND_ZONE_SETTINGS_SELECT)
        .eq('service_area_id', serviceAreaId)
        .order('updated_at', { ascending: false })
        .limit(1);
      if (error) {
        throw new Error(formatDemandZoneSettingsLoadError(error));
      }
      const row = pickDemandZoneSettingsRow(data as DemandZoneSettings[] | null);
      if (row) return row;
      // Fall back to page cache / prefetch before declaring missing.
      const fromAll = queryClient.getQueryData<DemandZoneSettings[]>(['demand-zone-settings-all']);
      const match = fromAll?.find((r) => r.service_area_id === serviceAreaId);
      return match ?? cachedFromParent ?? null;
    },
  });

  const loadStatus: DemandZoneSettingsLoadStatus = useMemo(() => {
    if (!open || isAllAreas) return 'idle';
    // Prefer a successful row (including cache) over a background refetch error.
    if (settings != null) return 'ready';
    if (isPending) return 'loading';
    if (isError) return 'error';
    if (isSuccess && settings == null) return 'missing';
    return 'loading';
  }, [open, isAllAreas, isPending, isError, isSuccess, settings]);

  // Reset session when dialog closes or the selected service area changes.
  useEffect(() => {
    if (!open) {
      setHydratedServiceAreaId(null);
      setForm(starterDemandZoneSettingsForm());
      setBaseline(null);
      setFormDirty(false);
      setServerConflict(false);
      setConflictDismissedFor(null);
      setSeededForCreate(false);
      setDrafts({});
      return;
    }
    if (isAllAreas) {
      setHydratedServiceAreaId(null);
      setForm(starterDemandZoneSettingsForm());
      setBaseline(null);
      setFormDirty(false);
      setServerConflict(false);
      setConflictDismissedFor(null);
      setSeededForCreate(false);
      setDrafts({});
      return;
    }
    if (hydratedServiceAreaId != null && hydratedServiceAreaId !== serviceAreaId) {
      setHydratedServiceAreaId(null);
      setForm(starterDemandZoneSettingsForm());
      setBaseline(null);
      setFormDirty(false);
      setServerConflict(false);
      setConflictDismissedFor(null);
      setSeededForCreate(false);
      setDrafts({});
    }
  }, [open, isAllAreas, serviceAreaId, hydratedServiceAreaId]);

  // Hydrate after a successful load/retry for the current service area.
  useEffect(() => {
    if (!open || isAllAreas) return;
    if (loadStatus !== 'ready' && loadStatus !== 'missing') return;

    if (hydratedServiceAreaId === serviceAreaId) {
      // Background refetch: never overwrite unsaved edits.
      if (loadStatus === 'ready' && settings) {
        const incoming = mapDemandZoneSettingsRowToForm(settings);
        if (!formDirty) {
          if (!baseline || !demandZoneSettingsFormsEqual(baseline, incoming)) {
            setForm(incoming);
            setBaseline(incoming);
            setDrafts({});
            setServerConflict(false);
            setConflictDismissedFor(null);
          }
          return;
        }
        if (
          serverSettingsAreNewerThanBaseline({
            baseline,
            incoming,
            formDirty: true,
          })
        ) {
          const fingerprint =
            typeof (settings as { updated_at?: unknown }).updated_at === 'string'
              ? String((settings as { updated_at: string }).updated_at)
              : JSON.stringify(incoming);
          if (conflictDismissedFor !== fingerprint) {
            setServerConflict(true);
          }
        }
      }
      return;
    }

    if (loadStatus === 'ready' && settings) {
      const mapped = mapDemandZoneSettingsRowToForm(settings);
      setForm(mapped);
      setBaseline(mapped);
      setHydratedServiceAreaId(serviceAreaId);
      setFormDirty(false);
      setServerConflict(false);
      setConflictDismissedFor(null);
      setSeededForCreate(false);
      setDrafts({});
      return;
    }

    if (loadStatus === 'missing') {
      // Do not present starter defaults as a successful load.
      setForm(starterDemandZoneSettingsForm());
      setBaseline(null);
      setHydratedServiceAreaId(serviceAreaId);
      setFormDirty(false);
      setServerConflict(false);
      setConflictDismissedFor(null);
      setSeededForCreate(false);
      setDrafts({});
    }
  }, [
    open,
    isAllAreas,
    loadStatus,
    settings,
    serviceAreaId,
    hydratedServiceAreaId,
    formDirty,
    baseline,
    conflictDismissedFor,
  ]);

  const validation = useMemo(
    () => validateDemandZoneSettings({ ...form, service_area_id: serviceAreaId }),
    [form, serviceAreaId],
  );

  const settingsLoadedSuccessfully = loadStatus === 'ready';
  const canEditForm =
    !isAllAreas &&
    !capsLoading &&
    (settingsLoadedSuccessfully || (loadStatus === 'missing' && seededForCreate));

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (isAllAreas) throw new Error(ALL_SERVICE_AREAS_MESSAGE);
      if (loadStatus !== 'ready' && !(loadStatus === 'missing' && seededForCreate)) {
        throw new Error('Settings have not loaded successfully. Retry load before saving.');
      }
      if (!validation.valid) throw new Error(validation.errors.join(' · '));

      const payload = buildDemandZoneSettingsSavePayload(form);
      const { data, error } = await supabase.rpc('admin_save_demand_zone_settings', {
        _service_area_id: serviceAreaId,
        _settings: payload,
      });
      if (error) throw error;
      const saved = data as unknown as DemandZoneSettings | null;
      const mismatches = verifyDemandZoneSettingsSaved(form, saved);
      if (mismatches.length > 0) {
        throw new Error(
          `Saved settings did not match the form (${mismatches.join(', ')}). Please try again.`,
        );
      }
      return saved as DemandZoneSettings;
    },
    onSuccess: async (saved) => {
      const mapped = mapDemandZoneSettingsRowToForm(saved);
      setForm(mapped);
      setBaseline(mapped);
      setFormDirty(false);
      setServerConflict(false);
      setConflictDismissedFor(null);
      setSeededForCreate(false);
      setDrafts({});
      setHydratedServiceAreaId(serviceAreaId);
      queryClient.setQueryData(['demand-zone-settings', serviceAreaId], saved);
      toast({
        title: 'Settings saved',
        description: `${serviceAreaName} demand-zone settings updated.`,
      });
      await queryClient.invalidateQueries({ queryKey: ['demand-zone-settings-all'] });
      await queryClient.invalidateQueries({ queryKey: ['driver-demand-zones'] });
      await queryClient.invalidateQueries({ queryKey: ['demand-zone-audit'] });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
    },
  });

  const saveEnabled =
    canEditForm &&
    !readOnly &&
    validation.valid &&
    !saveMutation.isPending &&
    !serverConflict;

  const markDirty = () => setFormDirty(true);

  const set = <K extends keyof DemandZoneSettingsFormState>(
    key: K,
    value: DemandZoneSettingsFormState[K],
  ) => {
    markDirty();
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const setSurgeEnabled = (enabled: boolean) => {
    markDirty();
    setForm((prev) => ({
      ...prev,
      surge_enabled: enabled,
      // A newly configured service area has null optional multipliers. Enabling surge
      // must create a valid neutral configuration instead of making Save unavailable.
      multiplier_medium: enabled
        ? (prev.multiplier_medium ?? prev.multiplier_low ?? 1)
        : prev.multiplier_medium,
      multiplier_high: enabled
        ? (prev.multiplier_high ?? prev.multiplier_medium ?? prev.multiplier_low ?? 1)
        : prev.multiplier_high,
    }));
  };

  const seedStarterDefaults = () => {
    const starters = starterDemandZoneSettingsForm();
    setForm(starters);
    setBaseline(null);
    setSeededForCreate(true);
    setFormDirty(true);
    setDrafts({});
    setServerConflict(false);
  };

  const reloadFromServer = () => {
    if (!settings) return;
    const mapped = mapDemandZoneSettingsRowToForm(settings);
    setForm(mapped);
    setBaseline(mapped);
    setFormDirty(false);
    setServerConflict(false);
    setConflictDismissedFor(null);
    setSeededForCreate(false);
    setDrafts({});
  };

  const keepEditingDespiteConflict = () => {
    const fingerprint =
      settings && typeof (settings as { updated_at?: unknown }).updated_at === 'string'
        ? String((settings as { updated_at: string }).updated_at)
        : settings
          ? JSON.stringify(mapDemandZoneSettingsRowToForm(settings))
          : 'unknown';
    setConflictDismissedFor(fingerprint);
    setServerConflict(false);
  };

  const colourRow = (
    label: string,
    key: 'colour_low' | 'colour_medium' | 'colour_high',
    fallback: string,
  ) => {
    const display = safeHexColourForDisplay(form[key], fallback);
    return (
      <div className="flex items-center gap-3">
        <Label className="w-28 text-xs">{label}</Label>
        <input
          type="color"
          aria-label={`${label} colour`}
          className="h-9 w-12 cursor-pointer rounded border bg-background p-1 disabled:cursor-not-allowed"
          value={display}
          disabled={!canColours || !canEditForm}
          onChange={(e) => set(key, safeHexColourForDisplay(e.target.value, fallback))}
        />
        <Input
          className="w-32 font-mono text-xs"
          value={form[key] ?? ''}
          disabled={!canColours || !canEditForm}
          onChange={(e) => set(key, e.target.value)}
        />
        <span
          className="h-6 flex-1 rounded border"
          style={{ backgroundColor: display }}
          aria-hidden
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={!canColours || !canEditForm}
          onClick={() => set(key, fallback)}
          title="Reset to default"
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>
    );
  };

  const numberRow = (
    label: string,
    key: keyof DemandZoneSettingsFormState,
    enabled: boolean,
    step = '1',
  ) => (
    <div className="flex items-center justify-between gap-3">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step={step}
        className="w-28"
        disabled={!enabled || !canEditForm}
        value={drafts[key as string] ?? String(form[key] ?? '')}
        onChange={(e) => {
          const raw = e.target.value;
          markDirty();
          setDrafts((prev) => ({ ...prev, [key as string]: raw }));
          if (raw.trim() === '') return;
          const n = Number(raw);
          if (Number.isFinite(n)) {
            setForm((prev) => ({ ...prev, [key]: n as never }));
          }
        }}
        onBlur={() => {
          setDrafts((prev) => {
            const next = { ...prev };
            delete next[key as string];
            return next;
          });
        }}
      />
    </div>
  );

  const scopeLabel = isAllAreas
    ? 'All service areas (no editable configuration)'
    : `Service area: ${serviceAreaName}`;

  const showFormBody = canEditForm;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Heat map &amp; surge settings</DialogTitle>
          <DialogDescription>
            {isAllAreas ? ALL_SERVICE_AREAS_MESSAGE : `Applies only to ${serviceAreaName}.`}
          </DialogDescription>
          <p className="text-xs font-medium text-foreground">{scopeLabel}</p>
        </DialogHeader>

        {isAllAreas ? (
          <div className="rounded-md border border-amber-300/60 bg-amber-50/70 p-4 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            <p className="font-medium">Select one service area</p>
            <p className="mt-1 text-xs">
              Heat map and surge settings are per service area. Choose a single service area in the
              filter above, then reopen this dialog. There is no shared editable configuration for
              “All service areas”.
            </p>
          </div>
        ) : capsLoading || loadStatus === 'loading' ? (
          <div className="py-10 text-center text-muted-foreground">
            <Loader2 className="mx-auto h-5 w-5 animate-spin" />
            <p className="mt-2 text-xs">Loading settings for {serviceAreaName}…</p>
          </div>
        ) : loadStatus === 'error' ? (
          <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-4">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Could not load settings</p>
                <p className="mt-1 text-xs">
                  {formatDemandZoneSettingsLoadError(loadError)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Editable defaults are not shown. Save stays disabled until load succeeds.
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setHydratedServiceAreaId(null);
                void refetch();
              }}
              disabled={isFetching}
            >
              {isFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Retry
            </Button>
          </div>
        ) : loadStatus === 'missing' && !seededForCreate ? (
          <div className="space-y-3 rounded-md border border-amber-300/60 bg-amber-50/70 p-4 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            <p className="font-medium">No saved settings for {serviceAreaName}</p>
            <p className="text-xs">
              There is no settings row for this service area yet. Starter defaults are not shown as
              saved values. Prepare starter defaults only if you intend to create a new row with
              Save.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={seedStarterDefaults}>
              Prepare starter defaults
            </Button>
          </div>
        ) : showFormBody ? (
          <div className="space-y-5">
            {loadStatus === 'missing' && seededForCreate && (
              <p className="rounded-md border border-sky-300/60 bg-sky-50/70 p-3 text-xs text-sky-900 dark:border-sky-900/40 dark:bg-sky-950/30 dark:text-sky-200">
                Starter defaults are shown for first-time create only — they are not loaded from the
                database. Save will create the settings row for {serviceAreaName}.
              </p>
            )}

            {serverConflict && (
              <div className="space-y-2 rounded-md border border-amber-300/60 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                <p className="font-medium">Server settings changed while you were editing</p>
                <p>
                  Your unsaved edits were kept. Reload server values to discard them, or keep
                  editing and Save carefully.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={reloadFromServer}>
                    Reload server values
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={keepEditingDespiteConflict}
                  >
                    Keep editing
                  </Button>
                </div>
              </div>
            )}

            {readOnly && (
              <p className="rounded-md border border-amber-300/60 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                You have read-only access to these settings.
              </p>
            )}

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Heat map</h3>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Heat map enabled</Label>
                <Switch
                  checked={form.heat_map_enabled}
                  disabled={!canHeatMap || !canEditForm}
                  onCheckedChange={(v) => set('heat_map_enabled', v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Manual zones enabled</Label>
                <Switch
                  checked={form.manual_zones_enabled}
                  disabled={!canHeatMap || !canEditForm}
                  onCheckedChange={(v) => set('manual_zones_enabled', v)}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {numberRow('Recompute interval (min)', 'recompute_interval_minutes', canHeatMap)}
                {numberRow('Open trip lifetime (min)', 'open_trip_max_lifetime_minutes', canHeatMap)}
                {numberRow('Zone radius (m)', 'zone_radius_meters', canHeatMap)}
                {numberRow('Consecutive checks required', 'consecutive_checks_required', canHeatMap)}
                {numberRow('Low: min trips', 'low_min_trips', canHeatMap)}
                {numberRow('Low: max trips', 'low_max_trips', canHeatMap)}
                {numberRow('Medium: min trips', 'medium_min_trips', canHeatMap)}
                {numberRow('Medium: max trips', 'medium_max_trips', canHeatMap)}
                {numberRow('High: min trips', 'high_min_trips', canHeatMap)}
              </div>
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Colours</h3>
              <p className="text-xs text-muted-foreground">
                Colours are display-only and never affect pricing.
              </p>
              {colourRow('Low demand', 'colour_low', DEFAULT_LEVEL_COLOURS.LOW)}
              {colourRow('Medium demand', 'colour_medium', DEFAULT_LEVEL_COLOURS.MEDIUM)}
              {colourRow('High demand', 'colour_high', DEFAULT_LEVEL_COLOURS.HIGH)}
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Automatic zone surge</h3>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Surge enabled</Label>
                <Switch
                  checked={form.surge_enabled}
                  disabled={!canSurge || !canEditForm}
                  onCheckedChange={setSurgeEnabled}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {numberRow('Low multiplier', 'multiplier_low', canSurge, '0.01')}
                {numberRow('Medium multiplier', 'multiplier_medium', canSurge, '0.01')}
                {numberRow('High multiplier', 'multiplier_high', canSurge, '0.01')}
                {numberRow('Max multiplier', 'max_multiplier', canSurge, '0.01')}
              </div>
              <p className="text-xs text-muted-foreground">
                Surge applies only to the confirmed demand level of the pickup zone. It never
                applies service-area wide.
              </p>
            </section>

            {!validation.valid && (
              <ul className="list-disc space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 pl-6 text-xs text-destructive">
                {validation.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => saveMutation.mutate()} disabled={!saveEnabled}>
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
