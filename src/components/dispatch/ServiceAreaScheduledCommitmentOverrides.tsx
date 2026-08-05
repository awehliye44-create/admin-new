import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, RotateCcw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import {
  COMMITMENT_POLICY_FIELD_DEFS,
  SCHEDULED_COMMITMENT_POLICY_KEYS,
  buildSaCommitmentOverridePayload,
  parseSaCommitmentOverride,
  validateSaCommitmentOverride,
  type ScheduledCommitmentPolicy,
  type ScheduledCommitmentPolicyKey,
} from '../../../shared/scheduledRidesPolicySSOT';

type OverrideDraft = Partial<
  Record<ScheduledCommitmentPolicyKey, number | null>
>;

type Props = {
  /** Effective global commitment values shown as inherit placeholders. */
  globalCommitment: ScheduledCommitmentPolicy;
  disabled?: boolean;
};

export function ServiceAreaScheduledCommitmentOverrides({
  globalCommitment,
  disabled = false,
}: Props) {
  const { data: serviceAreas = [], isLoading: areasLoading } = useServiceAreas({
    activeOnly: true,
  });
  const [serviceAreaId, setServiceAreaId] = useState<string>('');
  const [draft, setDraft] = useState<OverrideDraft>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (!serviceAreaId && serviceAreas.length > 0) {
      setServiceAreaId(serviceAreas[0].id);
    }
  }, [serviceAreaId, serviceAreas]);

  const loadOverrides = useCallback(async (saId: string) => {
    if (!saId) return;
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('dispatch_settings')
        .select('id, scheduled_commitment_policy')
        .eq('service_area_id', saId)
        .maybeSingle();
      if (error) throw error;
      const parsed = parseSaCommitmentOverride(
        (data as Record<string, unknown> | null) ?? null,
      );
      const next: OverrideDraft = {};
      for (const key of SCHEDULED_COMMITMENT_POLICY_KEYS) {
        next[key] = parsed[key] ?? null;
      }
      setDraft(next);
      setHasChanges(false);
    } catch (err) {
      console.error('Failed to load SA commitment overrides:', err);
      toast.error('Failed to load service-area commitment overrides');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (serviceAreaId) {
      void loadOverrides(serviceAreaId);
    }
  }, [serviceAreaId, loadOverrides]);

  const overrideCount = useMemo(
    () =>
      SCHEDULED_COMMITMENT_POLICY_KEYS.filter(
        (key) => draft[key] != null,
      ).length,
    [draft],
  );

  const updateField = (key: ScheduledCommitmentPolicyKey, raw: string) => {
    const next =
      raw.trim() === ''
        ? null
        : Math.max(0, Number.parseInt(raw, 10) || 0);
    setDraft((prev) => ({ ...prev, [key]: next }));
    setHasChanges(true);
  };

  const handleClear = () => {
    const cleared: OverrideDraft = {};
    for (const key of SCHEDULED_COMMITMENT_POLICY_KEYS) {
      cleared[key] = null;
    }
    setDraft(cleared);
    setHasChanges(true);
  };

  const handleSave = async () => {
    if (!serviceAreaId) return;
    const partial = buildSaCommitmentOverridePayload(draft) ?? {};
    const issues = validateSaCommitmentOverride(partial, globalCommitment);
    if (issues.length > 0) {
      toast.error(issues[0]?.message ?? 'Invalid service-area override');
      return;
    }

    setIsSaving(true);
    try {
      const payload = buildSaCommitmentOverridePayload(draft);
      const { data: existing, error: lookupError } = await supabase
        .from('dispatch_settings')
        .select('id')
        .eq('service_area_id', serviceAreaId)
        .maybeSingle();
      if (lookupError) throw lookupError;

      if (existing?.id) {
        const { error } = await supabase
          .from('dispatch_settings')
          .update({
            scheduled_commitment_policy: payload,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('dispatch_settings').insert({
          service_area_id: serviceAreaId,
          scheduled_commitment_policy: payload,
        });
        if (error) throw error;
      }

      setHasChanges(false);
      toast.success(
        payload
          ? 'Service-area commitment overrides saved'
          : 'Service-area overrides cleared — inheriting system defaults',
      );
    } catch (err) {
      console.error('Failed to save SA commitment overrides:', err);
      toast.error('Failed to save service-area commitment overrides');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4 border rounded-lg p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">Service-area overrides (optional)</p>
        <p className="text-xs text-muted-foreground">
          Prefer SA defaults where needed. Empty fields inherit the system-wide
          Commitment Policy above. Location access time still uses Custom Zones —
          no separate workflow.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
        <div className="space-y-2 flex-1">
          <Label>Service area</Label>
          <Select
            value={serviceAreaId}
            onValueChange={(id) => {
              setServiceAreaId(id);
              setHasChanges(false);
            }}
            disabled={disabled || areasLoading || isLoading}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select service area" />
            </SelectTrigger>
            <SelectContent>
              {serviceAreas.map((area) => (
                <SelectItem key={area.id} value={area.id}>
                  {area.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClear}
            disabled={disabled || isLoading || isSaving || overrideCount === 0}
          >
            <RotateCcw className="h-4 w-4 mr-1" />
            Clear overrides
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={disabled || isLoading || isSaving || !hasChanges || !serviceAreaId}
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            Save SA overrides
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {isLoading
          ? 'Loading overrides…'
          : `${overrideCount} override${overrideCount === 1 ? '' : 's'} set for this service area`}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {COMMITMENT_POLICY_FIELD_DEFS.map(({ key, label, help }) => (
          <div key={key} className="space-y-2">
            <Label>{label}</Label>
            <Input
              type="number"
              min={0}
              value={draft[key] ?? ''}
              placeholder={`Inherit (${globalCommitment[key]})`}
              onChange={(e) => updateField(key, e.target.value)}
              disabled={disabled || isLoading || isSaving}
            />
            <p className="text-xs text-muted-foreground">{help}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
