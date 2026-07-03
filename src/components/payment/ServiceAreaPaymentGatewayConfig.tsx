import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, CreditCard, AlertTriangle, ArrowRightLeft } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface ProviderOption {
  provider: string;
  display_name: string;
  is_enabled: boolean;
  status: string;
  supports_customer_payments: boolean;
  supports_driver_payouts: boolean;
}

interface ServiceAreaPaymentGatewayConfigProps {
  serviceAreaId: string;
  serviceAreaName?: string;
}

const UNSET_VALUE = '__unset__';

export function ServiceAreaPaymentGatewayConfig({
  serviceAreaId,
  serviceAreaName,
}: ServiceAreaPaymentGatewayConfigProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [customerGateway, setCustomerGateway] = useState<string | null>(null);
  const [driverGateway, setDriverGateway] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [providersRes, areaRes] = await Promise.all([
        supabase
          .from('payment_provider_configs')
          .select(
            'provider, display_name, is_enabled, status, supports_customer_payments, supports_driver_payouts',
          )
          .order('display_name'),
        supabase
          .from('service_areas')
          .select('customer_payment_gateway, driver_payout_gateway')
          .eq('id', serviceAreaId)
          .maybeSingle(),
      ]);

      if (providersRes.error) throw providersRes.error;
      if (areaRes.error) throw areaRes.error;

      setProviders((providersRes.data ?? []) as ProviderOption[]);
      setCustomerGateway(areaRes.data?.customer_payment_gateway ?? null);
      setDriverGateway(areaRes.data?.driver_payout_gateway ?? null);
    } catch {
      toast.error('Failed to load payment gateway configuration');
    } finally {
      setIsLoading(false);
    }
  }, [serviceAreaId]);

  useEffect(() => {
    void load();
  }, [load]);

  const customerOptions = providers.filter((p) => p.supports_customer_payments);
  const driverOptions = providers.filter((p) => p.supports_driver_payouts);

  const saveGateway = async (
    field: 'customer_payment_gateway' | 'driver_payout_gateway',
    value: string | null,
  ) => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('service_areas')
        .update({ [field]: value })
        .eq('id', serviceAreaId);

      if (error) throw error;

      if (field === 'customer_payment_gateway') {
        setCustomerGateway(value);
      } else {
        setDriverGateway(value);
      }
      toast.success('Payment gateway updated');
    } catch {
      toast.error('Failed to save payment gateway');
      await load();
    } finally {
      setIsSaving(false);
    }
  };

  const handleCustomerChange = (value: string) => {
    const next = value === UNSET_VALUE ? null : value;
    void saveGateway('customer_payment_gateway', next);
  };

  const handleDriverChange = (value: string) => {
    const next = value === UNSET_VALUE ? null : value;
    void saveGateway('driver_payout_gateway', next);
  };

  const providerLabel = (id: string | null) =>
    providers.find((p) => p.provider === id)?.display_name ?? id ?? 'Not selected';

  const providerStatusBadge = (id: string | null) => {
    if (!id) return null;
    const p = providers.find((x) => x.provider === id);
    if (!p) return <Badge variant="secondary">Unknown</Badge>;
    if (p.is_enabled && p.status !== 'not_configured' && p.status !== 'error') {
      return <Badge variant="outline" className="text-green-700 border-green-500/40">Connected</Badge>;
    }
    return <Badge variant="secondary">Not connected</Badge>;
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

  const gatewayIncomplete = !customerGateway || !driverGateway;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowRightLeft className="h-5 w-5 text-primary" />
          Payment Gateways
        </CardTitle>
        <CardDescription>
          Each service area must explicitly choose a customer payment gateway and a driver payout gateway.
          There is no global fallback — unset gateways return{' '}
          <code className="text-xs">PAYMENT_GATEWAY_NOT_CONFIGURED</code>.
          {serviceAreaName ? ` (${serviceAreaName})` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {gatewayIncomplete && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Both customer and driver gateways are required before digital payments can run in this area.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 p-3 border rounded-lg">
            <div className="flex items-center justify-between gap-2">
              <Label className="flex items-center gap-2 font-medium">
                <CreditCard className="h-4 w-4" />
                Customer payment gateway
              </Label>
              {providerStatusBadge(customerGateway)}
            </div>
            <Select
              value={customerGateway ?? UNSET_VALUE}
              onValueChange={handleCustomerChange}
              disabled={isSaving}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET_VALUE} disabled>
                  — Select provider —
                </SelectItem>
                {customerOptions.map((p) => (
                  <SelectItem key={p.provider} value={p.provider}>
                    {p.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Current: {providerLabel(customerGateway)}
            </p>
          </div>

          <div className="space-y-2 p-3 border rounded-lg">
            <div className="flex items-center justify-between gap-2">
              <Label className="flex items-center gap-2 font-medium">
                <ArrowRightLeft className="h-4 w-4" />
                Driver payout gateway
              </Label>
              {providerStatusBadge(driverGateway)}
            </div>
            <Select
              value={driverGateway ?? UNSET_VALUE}
              onValueChange={handleDriverChange}
              disabled={isSaving}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET_VALUE} disabled>
                  — Select provider —
                </SelectItem>
                {driverOptions.map((p) => (
                  <SelectItem key={p.provider} value={p.provider}>
                    {p.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Current: {providerLabel(driverGateway)}
            </p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Configure provider API keys under Integrations → Payment Providers. Milton Keynes production
          continues on Stripe until you change these selections.
        </p>
      </CardContent>
    </Card>
  );
}
