import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, Phone, PhoneCall, Save, Shield, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { formatMoneyMinor } from '@/lib/formatMoneyMinor';
import { getTripDisplayId } from '@/lib/tripUtils';
import {
  buildUsageMetrics,
  CallMaskingProviderConfig,
  CommunicationDefaultMethod,
  estimateCallCostMinor,
  minutesToSeconds,
  resolveDefaultMethod,
  secondsToMinutes,
  ServiceAreaCallMaskingConfig,
  ServiceAreaCommunicationSettings,
  UnifiedCommunicationCallLog,
  validateCommunicationSettings,
  VOIP_PROVIDER_LABEL,
} from '@/lib/serviceAreaCommunicationModel';
import {
  COMMUNICATION_LOG_EVENTS,
  isPlaceholderOutboundCallerId,
  normalizeOutboundCallerIdE164,
  suggestOutboundCallerId,
} from '@/lib/communicationSsot';

interface Props {
  serviceAreaId: string;
  serviceAreaName?: string;
  currencyCode?: string;
}

const UNSET_PROVIDER = '__unset__';

function defaultSettings(serviceAreaId: string, currency: string): ServiceAreaCommunicationSettings {
  return {
    service_area_id: serviceAreaId,
    voip_enabled: false,
    call_masking_enabled: false,
    default_method: 'voip',
    maximum_call_duration_seconds: 600,
    voip_rate_per_minute_minor: 0,
    masked_call_rate_per_minute_minor: 0,
    currency,
    is_enabled: true,
    voip_provider: 'livekit',
  };
}

export function ServiceAreaCommunicationConfig({
  serviceAreaId,
  serviceAreaName,
  currencyCode = 'GBP',
}: Props) {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [settings, setSettings] = useState<ServiceAreaCommunicationSettings>(() =>
    defaultSettings(serviceAreaId, currencyCode),
  );
  const [maskingConfig, setMaskingConfig] = useState<ServiceAreaCallMaskingConfig | null>(null);
  const [providerCatalog, setProviderCatalog] = useState<CallMaskingProviderConfig[]>([]);
  const [selectedProviderConfigId, setSelectedProviderConfigId] = useState<string>(UNSET_PROVIDER);
  const [outboundCallerId, setOutboundCallerId] = useState('');
  const [callLogs, setCallLogs] = useState<UnifiedCommunicationCallLog[]>([]);
  const [metrics, setMetrics] = useState(
    buildUsageMetrics([], [], 0, 0),
  );

  const maxDurationMinutes = useMemo(
    () => secondsToMinutes(settings.maximum_call_duration_seconds),
    [settings.maximum_call_duration_seconds],
  );

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [settingsRes, maskingRes, catalogRes] = await Promise.all([
        supabase
          .from('service_area_communication_settings')
          .select('*')
          .eq('service_area_id', serviceAreaId)
          .maybeSingle(),
        supabase
          .from('service_area_call_masking_config')
          .select('*')
          .eq('service_area_id', serviceAreaId)
          .maybeSingle(),
        supabase
          .from('call_masking_provider_configs')
          .select('*')
          .eq('is_active', true)
          .order('label'),
      ]);

      if (settingsRes.error) throw settingsRes.error;
      if (maskingRes.error) throw maskingRes.error;
      if (catalogRes.error) throw catalogRes.error;

      const loadedSettings = settingsRes.data
        ? ({
            ...(settingsRes.data as ServiceAreaCommunicationSettings),
            currency: settingsRes.data.currency || currencyCode,
          } as ServiceAreaCommunicationSettings)
        : defaultSettings(serviceAreaId, currencyCode);
      setSettings(loadedSettings);

      const loadedMasking = maskingRes.data as ServiceAreaCallMaskingConfig | null;
      setMaskingConfig(loadedMasking);
      setSelectedProviderConfigId(loadedMasking?.provider_config_id ?? UNSET_PROVIDER);
      setOutboundCallerId(
        suggestOutboundCallerId(
          loadedSettings.outbound_caller_id,
          loadedMasking?.outbound_caller_id,
        ),
      );

      const catalog = (catalogRes.data ?? []) as CallMaskingProviderConfig[];
      setProviderCatalog(catalog);

      // Call logs are optional — never block settings UI if history queries fail.
      let voipLogs: Record<string, unknown>[] = [];
      let maskedLogs: Record<string, unknown>[] = [];

      const voipLogsRes = await supabase
        .from('voip_call_logs')
        .select('*')
        .eq('service_area_id', serviceAreaId)
        .order('started_at', { ascending: false })
        .limit(100);
      if (voipLogsRes.error) {
        console.warn('[ServiceAreaCommunicationConfig] voip logs skipped', voipLogsRes.error);
      } else {
        voipLogs = voipLogsRes.data ?? [];
      }

      const maskedLogsRes = await supabase
        .from('call_masking_call_logs')
        .select(`
          id,
          call_start,
          duration_seconds,
          status,
          disconnect_reason,
          booking_id,
          trips!inner(
            id,
            trip_number,
            trip_code,
            service_area_id,
            passenger_name,
            confirmed_driver_id,
            drivers!trips_confirmed_driver_id_fkey(full_name)
          )
        `)
        .eq('trips.service_area_id', serviceAreaId)
        .order('call_start', { ascending: false })
        .limit(100);
      if (maskedLogsRes.error) {
        console.warn('[ServiceAreaCommunicationConfig] masked logs skipped', maskedLogsRes.error);
      } else {
        maskedLogs = maskedLogsRes.data ?? [];
      }

      const voipMetricsInput = voipLogs.map((log) => ({
        duration_seconds: log.duration_seconds as number | null,
        status: String(log.status ?? ''),
      }));
      const maskedMetricsInput = maskedLogs.map((log) => ({
        duration_seconds: log.duration_seconds as number | null,
        status: String(log.status ?? ''),
      }));

      setMetrics(
        buildUsageMetrics(
          voipMetricsInput,
          maskedMetricsInput,
          loadedSettings.voip_rate_per_minute_minor,
          loadedSettings.masked_call_rate_per_minute_minor,
        ),
      );

      const driverNameById = new Map<string, string>();
      const voipDriverIds = voipLogs
        .map((log) => log.driver_id as string | null)
        .filter(Boolean) as string[];
      if (voipDriverIds.length > 0) {
        const { data: drivers } = await supabase
          .from('drivers')
          .select('id, first_name, last_name')
          .in('id', voipDriverIds);
        for (const driver of drivers ?? []) {
          driverNameById.set(driver.id, `${driver.first_name ?? ''} ${driver.last_name ?? ''}`.trim());
        }
      }

      const voipCustomerIds = voipLogs
        .map((log) => log.customer_id as string | null)
        .filter(Boolean) as string[];
      const customerNameById = new Map<string, string>();
      if (voipCustomerIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('user_id, full_name')
          .in('user_id', voipCustomerIds);
        for (const profile of profiles ?? []) {
          customerNameById.set(profile.user_id, profile.full_name ?? 'Customer');
        }
      }

      const unifiedVoip: UnifiedCommunicationCallLog[] = voipLogs.map((log) => ({
        id: String(log.id),
        occurred_at: String(log.started_at),
        trip_id: (log.trip_id as string | null) ?? null,
        trip_label: null,
        driver_name: log.driver_id ? driverNameById.get(String(log.driver_id)) ?? null : null,
        customer_name: log.customer_id
          ? customerNameById.get(String(log.customer_id)) ?? null
          : null,
        method: 'voip',
        provider: String(log.provider ?? 'livekit'),
        status: String(log.status ?? ''),
        duration_seconds: log.duration_seconds as number | null,
        estimated_cost_minor: estimateCallCostMinor(
          log.duration_seconds as number | null,
          loadedSettings.voip_rate_per_minute_minor,
        ),
        end_reason: (log.end_reason as string | null) ?? null,
      }));

      const unifiedMasked: UnifiedCommunicationCallLog[] = maskedLogs.map((log) => {
        const trip = log.trips as {
          id: string;
          trip_number: string | null;
          trip_code: string | null;
          passenger_name: string | null;
          drivers?: { full_name: string | null } | null;
        } | null;
        return {
          id: String(log.id),
          occurred_at: String(log.call_start),
          trip_id: trip?.id ?? String(log.booking_id),
          trip_label: trip ? getTripDisplayId(trip) : null,
          driver_name: trip?.drivers?.full_name ?? null,
          customer_name: trip?.passenger_name ?? null,
          method: 'call_masking',
          provider: 'msg91',
          status: String(log.status ?? ''),
          duration_seconds: log.duration_seconds as number | null,
          estimated_cost_minor: estimateCallCostMinor(
            log.duration_seconds as number | null,
            loadedSettings.masked_call_rate_per_minute_minor,
          ),
          end_reason: (log.disconnect_reason as string | null) ?? null,
        };
      });

      setCallLogs(
        [...unifiedVoip, ...unifiedMasked].sort(
          (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
        ),
      );
    } catch (error) {
      console.error('[ServiceAreaCommunicationConfig] load failed', error);
      toast.error('Failed to load communication settings');
    } finally {
      setIsLoading(false);
    }
  }, [currencyCode, serviceAreaId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const applyProviderSelection = (configId: string) => {
    setSelectedProviderConfigId(configId);
    const selected = providerCatalog.find((entry) => entry.id === configId);
    if (!selected) return;
    if (!outboundCallerId.trim()) {
      const suggested = suggestOutboundCallerId(selected.outbound_caller_id);
      if (suggested) setOutboundCallerId(suggested);
    }
    setMaskingConfig({
      service_area_id: serviceAreaId,
      provider_config_id: selected.id,
      provider: selected.provider,
      country_code: selected.country_code,
      number_pool_id: selected.number_pool_id,
      outbound_caller_id: outboundCallerId || selected.outbound_caller_id,
      is_active: true,
    });
  };

  const handleSave = async () => {
    const validationError = validateCommunicationSettings({
      voip_enabled: settings.voip_enabled,
      call_masking_enabled: settings.call_masking_enabled,
      default_method: settings.default_method,
    });
    if (validationError) {
      toast.error(validationError);
      return;
    }

    if (settings.call_masking_enabled && !maskingConfig?.provider_config_id) {
      toast.error('Select a call masking provider assignment before saving.');
      return;
    }

    const normalizedOutbound = settings.call_masking_enabled
      ? normalizeOutboundCallerIdE164(outboundCallerId)
      : null;
    if (settings.call_masking_enabled && !normalizedOutbound) {
      toast.error('Enter a valid outbound caller ID in E.164 format (example: +441908831211).');
      console.info(COMMUNICATION_LOG_EVENTS.OUTBOUND_CALLER_ID_INVALID, {
        service_area_id: serviceAreaId,
        raw: outboundCallerId,
      });
      return;
    }
    if (settings.call_masking_enabled && isPlaceholderOutboundCallerId(normalizedOutbound)) {
      toast.error(
        'Replace the placeholder outbound caller ID with a real MSG91 E.164 (example: +441908831211).',
      );
      console.info(COMMUNICATION_LOG_EVENTS.OUTBOUND_CALLER_ID_INVALID, {
        service_area_id: serviceAreaId,
        raw: outboundCallerId,
        reason: 'placeholder',
      });
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        ...settings,
        service_area_id: serviceAreaId,
        outbound_caller_id: normalizedOutbound,
        default_method: resolveDefaultMethod(
          settings.voip_enabled,
          settings.call_masking_enabled,
          settings.default_method,
        ),
        currency: currencyCode,
        updated_at: new Date().toISOString(),
      };

      const { error: settingsError } = await supabase
        .from('service_area_communication_settings')
        .upsert(payload, { onConflict: 'service_area_id' });
      if (settingsError) throw settingsError;

      if (settings.call_masking_enabled && maskingConfig) {
        const { error: maskingError } = await supabase
          .from('service_area_call_masking_config')
          .upsert(
            {
              ...maskingConfig,
              service_area_id: serviceAreaId,
              outbound_caller_id: normalizedOutbound!,
              is_active: true,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'service_area_id' },
          );
        if (maskingError) throw maskingError;
      } else {
        await supabase.from('service_area_call_masking_config').delete().eq('service_area_id', serviceAreaId);
      }

      console.info(COMMUNICATION_LOG_EVENTS.CONFIG_SAVED, {
        service_area_id: serviceAreaId,
        voip_enabled: settings.voip_enabled,
        call_masking_enabled: settings.call_masking_enabled,
        outbound_caller_id: normalizedOutbound,
      });

      toast.success(`Communication settings saved for ${serviceAreaName ?? 'service area'}`);
      await loadData();
    } catch (error) {
      console.error('[ServiceAreaCommunicationConfig] save failed', error);
      toast.error('Failed to save communication settings');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12 flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const bothEnabled = settings.voip_enabled && settings.call_masking_enabled;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Phone className="h-5 w-5" />
              Communication (SSOT)
            </CardTitle>
            <CardDescription>
              Per–service-area VoIP (LiveKit Cloud) and call masking assignment. Does not modify
              provider integration — only assigns existing masking config to {serviceAreaName ?? 'this area'}.
            </CardDescription>
          </div>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save communication
          </Button>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div>
                <Label htmlFor="voip-enabled">VoIP enabled</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Provider: {VOIP_PROVIDER_LABEL}. Shows “Call in app” when enabled.
                </p>
              </div>
              <Switch
                id="voip-enabled"
                checked={settings.voip_enabled}
                onCheckedChange={(checked) =>
                  setSettings((current) => ({
                    ...current,
                    voip_enabled: checked,
                    default_method: resolveDefaultMethod(
                      checked,
                      current.call_masking_enabled,
                      current.default_method,
                    ),
                  }))
                }
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div>
                <Label htmlFor="masking-enabled">Call Masking enabled</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Shows normal phone “Call” when enabled. No automatic fallback.
                </p>
              </div>
              <Switch
                id="masking-enabled"
                checked={settings.call_masking_enabled}
                onCheckedChange={(checked) =>
                  setSettings((current) => ({
                    ...current,
                    call_masking_enabled: checked,
                    default_method: resolveDefaultMethod(
                      current.voip_enabled,
                      checked,
                      current.default_method,
                    ),
                  }))
                }
              />
            </div>
          </div>

          {!settings.voip_enabled && !settings.call_masking_enabled && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Both methods disabled — customer and driver apps will not show call options for this
                service area.
              </AlertDescription>
            </Alert>
          )}

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <Label>Default method</Label>
              <Select
                value={settings.default_method}
                disabled={!bothEnabled}
                onValueChange={(value: CommunicationDefaultMethod) =>
                  setSettings((current) => ({ ...current, default_method: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="voip" disabled={!settings.voip_enabled}>
                    VoIP
                  </SelectItem>
                  <SelectItem value="call_masking" disabled={!settings.call_masking_enabled}>
                    Call Masking
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {bothEnabled
                  ? 'Controls which option appears first when both are enabled.'
                  : 'Only applies when both VoIP and Call Masking are enabled.'}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="max-duration">Maximum call duration (minutes)</Label>
              <Input
                id="max-duration"
                type="number"
                min={1}
                step={1}
                value={maxDurationMinutes}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    maximum_call_duration_seconds: minutesToSeconds(Number(event.target.value) || 1),
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">
                Stored as {settings.maximum_call_duration_seconds} seconds.
              </p>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label>Communication module active</Label>
                <p className="text-xs text-muted-foreground">Master toggle for this service area.</p>
              </div>
              <Switch
                checked={settings.is_enabled}
                onCheckedChange={(checked) =>
                  setSettings((current) => ({ ...current, is_enabled: checked }))
                }
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="voip-rate">VoIP rate per minute ({currencyCode})</Label>
              <Input
                id="voip-rate"
                type="number"
                min={0}
                step={0.01}
                value={(settings.voip_rate_per_minute_minor / 100).toFixed(2)}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    voip_rate_per_minute_minor: Math.round(Number(event.target.value || 0) * 100),
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">Cost estimate only.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="masking-rate">Call masking rate per minute ({currencyCode})</Label>
              <Input
                id="masking-rate"
                type="number"
                min={0}
                step={0.01}
                value={(settings.masked_call_rate_per_minute_minor / 100).toFixed(2)}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    masked_call_rate_per_minute_minor: Math.round(Number(event.target.value || 0) * 100),
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">Cost estimate only.</p>
            </div>
          </div>

          {settings.call_masking_enabled && (
            <Card className="border-dashed">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  Call masking assignment
                </CardTitle>
                <CardDescription>
                  Assign an existing provider config to this service area. Integration code is unchanged.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Provider config</Label>
                  {providerCatalog.length === 0 ? (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        No MSG91 provider configs are visible. The catalog may be missing or blocked
                        by database permissions — contact engineering to seed{' '}
                        <code className="text-xs">call_masking_provider_configs</code> or redeploy
                        the latest migration.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Select
                      value={selectedProviderConfigId}
                      onValueChange={applyProviderSelection}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select call masking config" />
                      </SelectTrigger>
                      <SelectContent>
                        {providerCatalog.map((entry) => (
                          <SelectItem key={entry.id} value={entry.id}>
                            {entry.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                {maskingConfig && (
                  <div className="grid gap-3 md:grid-cols-2 text-sm">
                    <div>
                      <span className="text-muted-foreground">Provider</span>
                      <p className="font-medium">{maskingConfig.provider}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Country code</span>
                      <p className="font-medium">{maskingConfig.country_code}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Number pool</span>
                      <p className="font-medium">{maskingConfig.number_pool_id}</p>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor="outbound-caller-id">Outbound caller ID</Label>
                      <Input
                        id="outbound-caller-id"
                        placeholder="+441908831211"
                        value={outboundCallerId}
                        onChange={(event) => setOutboundCallerId(event.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        E.164 format required. Provider catalog suggests{' '}
                        {providerCatalog.find((entry) => entry.id === maskingConfig.provider_config_id)
                          ?.outbound_caller_id ?? 'none'} — manual value takes priority.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Active</span>
                      <Badge variant={maskingConfig.is_active ? 'default' : 'secondary'}>
                        {maskingConfig.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total VoIP minutes</CardDescription>
            <CardTitle>{metrics.totalVoipMinutes}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total masked-call minutes</CardDescription>
            <CardTitle>{metrics.totalMaskedMinutes}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Estimated communication cost</CardDescription>
            <CardTitle>{formatMoneyMinor(metrics.estimatedCostMinor, currencyCode)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Number of calls</CardDescription>
            <CardTitle>{metrics.callCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Average call duration</CardDescription>
            <CardTitle>{metrics.averageDurationSeconds}s</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Call success rate</CardDescription>
            <CardTitle>{metrics.successRate}%</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Call failure rate</CardDescription>
            <CardTitle>{metrics.failureRate}%</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PhoneCall className="h-5 w-5" />
            Call logs
          </CardTitle>
          <CardDescription>
            Read-only history filtered to {serviceAreaName ?? 'this service area'}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {callLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No calls recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date/time</TableHead>
                  <TableHead>Trip</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Est. cost</TableHead>
                  <TableHead>End reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {callLogs.map((log) => (
                  <TableRow key={`${log.method}-${log.id}`}>
                    <TableCell>{format(new Date(log.occurred_at), 'dd MMM yyyy HH:mm')}</TableCell>
                    <TableCell>{log.trip_label ?? log.trip_id?.slice(0, 8) ?? '—'}</TableCell>
                    <TableCell>{log.driver_name ?? '—'}</TableCell>
                    <TableCell>{log.customer_name ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {log.method === 'voip' ? 'VoIP' : 'Call Masking'}
                      </Badge>
                    </TableCell>
                    <TableCell>{log.provider}</TableCell>
                    <TableCell>{log.status}</TableCell>
                    <TableCell>{log.duration_seconds != null ? `${log.duration_seconds}s` : '—'}</TableCell>
                    <TableCell>{formatMoneyMinor(log.estimated_cost_minor, currencyCode)}</TableCell>
                    <TableCell>{log.end_reason ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
