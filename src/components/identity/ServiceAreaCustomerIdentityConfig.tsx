import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, Save, ShieldCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

type CustomerIdentityMode = 'off' | 'optional' | 'mandatory';

type Settings = {
  service_area_id: string;
  mode: CustomerIdentityMode;
  provider: string;
  maximum_attempts: number;
  session_expiry_minutes: number;
};

interface Props {
  serviceAreaId: string;
  serviceAreaName?: string;
}

function defaults(serviceAreaId: string): Settings {
  return {
    service_area_id: serviceAreaId,
    mode: 'off',
    provider: 'manual',
    maximum_attempts: 3,
    session_expiry_minutes: 60,
  };
}

export function ServiceAreaCustomerIdentityConfig({
  serviceAreaId,
  serviceAreaName,
}: Props) {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => defaults(serviceAreaId));

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('service_area_customer_identity_settings' as never)
        .select(
          'service_area_id, mode, provider, maximum_attempts, session_expiry_minutes',
        )
        .eq('service_area_id', serviceAreaId)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        const row = data as Record<string, unknown>;
        setSettings({
          service_area_id: serviceAreaId,
          mode: (row.mode as CustomerIdentityMode) || 'off',
          provider: (row.provider as string) || 'manual',
          maximum_attempts: Number(row.maximum_attempts) || 3,
          session_expiry_minutes: Number(row.session_expiry_minutes) || 60,
        });
      } else {
        setSettings(defaults(serviceAreaId));
      }
    } catch (err) {
      console.error('[ServiceAreaCustomerIdentityConfig] load failed', err);
      toast.error('Could not load customer identity settings');
      setSettings(defaults(serviceAreaId));
    } finally {
      setIsLoading(false);
    }
  }, [serviceAreaId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSave = async () => {
    setIsSaving(true);
    try {
      const payload = {
        service_area_id: serviceAreaId,
        mode: settings.mode,
        provider: 'manual',
        provider_workflow_id: null,
        maximum_attempts: Math.min(20, Math.max(1, settings.maximum_attempts || 3)),
        session_expiry_minutes: Math.min(
          1440,
          Math.max(5, settings.session_expiry_minutes || 60),
        ),
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase
        .from('service_area_customer_identity_settings' as never)
        .upsert(payload as never, { onConflict: 'service_area_id' });
      if (error) throw error;
      toast.success('Customer identity settings saved');
      await load();
    } catch (err) {
      console.error('[ServiceAreaCustomerIdentityConfig] save failed', err);
      toast.error('Could not save customer identity settings');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" />
          Customer identity verification
        </CardTitle>
        <CardDescription>
          In-app ID + selfie capture with Admin review for riders in{' '}
          {serviceAreaName || 'this service area'}. Default is Off. Switch to
          Optional to show an in-app CTA, or Mandatory to block booking until
          verified. Approved verification locks the rider name until Admin unlocks
          it on Riders.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label>Mode</Label>
              <Select
                value={settings.mode}
                onValueChange={(v) =>
                  setSettings((s) => ({ ...s, mode: v as CustomerIdentityMode }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off — feature hidden</SelectItem>
                  <SelectItem value="optional">Optional — CTA only</SelectItem>
                  <SelectItem value="mandatory">Mandatory — required to book</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Provider</Label>
              <Input value="Manual review" disabled />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Maximum attempts</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={settings.maximum_attempts}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      maximum_attempts: Number(e.target.value) || 3,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Session expiry (minutes)</Label>
                <Input
                  type="number"
                  min={5}
                  max={1440}
                  value={settings.session_expiry_minutes}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      session_expiry_minutes: Number(e.target.value) || 60,
                    }))
                  }
                />
              </div>
            </div>

            <Button onClick={() => void onSave()} disabled={isSaving}>
              {isSaving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save identity settings
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
