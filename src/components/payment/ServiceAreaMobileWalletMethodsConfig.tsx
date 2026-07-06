import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2, Smartphone, CreditCard } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  catalogMethodsForProvider,
  isMobileWalletCollectProvider,
  type MobileWalletMethodId,
  MOBILE_WALLET_METHOD_LABELS,
  normalizeMobileWalletMethods,
} from '@/lib/customerPaymentWorkflow';

function getMobileWalletMethodLabel(id: MobileWalletMethodId): string {
  return MOBILE_WALLET_METHOD_LABELS[id];
}

interface ServiceAreaMobileWalletMethodsConfigProps {
  serviceAreaId: string;
  serviceAreaName?: string;
  customerPaymentGateway: string | null;
}

export function ServiceAreaMobileWalletMethodsConfig({
  serviceAreaId,
  serviceAreaName,
  customerPaymentGateway,
}: ServiceAreaMobileWalletMethodsConfigProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [enabledMethods, setEnabledMethods] = useState<MobileWalletMethodId[]>([]);
  const [cardEnabled, setCardEnabled] = useState(false);

  const catalog = catalogMethodsForProvider(customerPaymentGateway);
  const isIntaSend = customerPaymentGateway === 'intasend';

  const load = useCallback(async () => {
    if (!isMobileWalletCollectProvider(customerPaymentGateway)) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('service_area_payment_methods')
        .select('mobile_wallet_methods, card_enabled')
        .eq('service_area_id', serviceAreaId)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') throw error;

      setCardEnabled(Boolean(data?.card_enabled));
      setEnabledMethods(
        normalizeMobileWalletMethods(
          customerPaymentGateway,
          data?.mobile_wallet_methods,
        ),
      );
    } catch {
      toast.error('Failed to load mobile wallet methods');
    } finally {
      setIsLoading(false);
    }
  }, [serviceAreaId, customerPaymentGateway]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isMobileWalletCollectProvider(customerPaymentGateway)) {
    return null;
  }

  const persist = async (
    nextMethods: MobileWalletMethodId[],
    nextCardEnabled: boolean = cardEnabled,
  ) => {
    setIsSaving(true);
    try {
      const { data: existing } = await supabase
        .from('service_area_payment_methods')
        .select('wallet_enabled, apple_pay_enabled, google_pay_enabled')
        .eq('service_area_id', serviceAreaId)
        .maybeSingle();

      const { error } = await supabase
        .from('service_area_payment_methods')
        .upsert(
          {
            service_area_id: serviceAreaId,
            card_enabled: isIntaSend ? nextCardEnabled : false,
            wallet_enabled: existing?.wallet_enabled ?? false,
            apple_pay_enabled: existing?.apple_pay_enabled ?? false,
            google_pay_enabled: existing?.google_pay_enabled ?? false,
            mobile_wallet_methods: nextMethods,
          } as any,
          { onConflict: 'service_area_id' },
        );

      if (error) throw error;
      setEnabledMethods(nextMethods);
      setCardEnabled(nextCardEnabled);
      toast.success('Payment methods updated');
    } catch {
      toast.error('Failed to save mobile wallet methods');
      await load();
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggle = (method: MobileWalletMethodId, checked: boolean) => {
    const next = checked
      ? [...new Set([...enabledMethods, method])]
      : enabledMethods.filter((m) => m !== method);
    void persist(next, cardEnabled);
  };

  const handleCardToggle = (checked: boolean) => {
    void persist(enabledMethods, checked);
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-primary" />
          Mobile wallet methods
        </CardTitle>
        <CardDescription>
          Enabled mobile wallet options for {serviceAreaName || 'this service area'}.
          Customers pay in their wallet app before dispatch — no card pre-authorisation.
          Empty selection defaults to all methods supported by the gateway catalog.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {catalog.length === 0 ? (
          <p className="text-sm text-muted-foreground">No mobile wallet catalog for this gateway.</p>
        ) : (
          catalog.map((method) => {
            const isEnabled = enabledMethods.includes(method);
            return (
              <div
                key={method}
                className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 transition-colors"
              >
                <div>
                  <Label className="font-medium">{getMobileWalletMethodLabel(method)}</Label>
                  <p className="text-xs text-muted-foreground font-mono">{method}</p>
                </div>
                <Switch
                  checked={isEnabled}
                  onCheckedChange={(checked) => handleToggle(method, checked)}
                  disabled={isSaving}
                />
              </div>
            );
          })
        )}
        {isIntaSend && (
          <div className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 transition-colors border-dashed">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${cardEnabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                <CreditCard className="h-5 w-5" />
              </div>
              <div>
                <Label className="font-medium">Card (IntaSend)</Label>
                <p className="text-xs text-muted-foreground">
                  Optional card collect via IntaSend — not Stripe preauth. Requires live adapter
                  (PROVIDER_NOT_IMPLEMENTED until contracts confirmed).
                </p>
              </div>
            </div>
            <Switch
              checked={cardEnabled}
              onCheckedChange={handleCardToggle}
              disabled={isSaving}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
