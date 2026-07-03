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
import { invokePaymentProviders } from '@/hooks/usePaymentProviders';
import {
  isCustomerBookingAdapterLive,
  isMobileWalletCollectProvider,
  isStripePreauthProvider,
  providerNotImplementedMessage,
  resolveProviderBookingAdapterStatus,
} from '@/lib/customerPaymentWorkflow';

interface ProviderOption {
  provider: string;
  display_name: string;
  is_enabled: boolean;
  status: string;
  supports_customer_payments: boolean;
  supports_driver_payouts: boolean;
}

type GatewayStatusCode =
  | 'CONNECTED'
  | 'NOT_CONFIGURED'
  | 'DISABLED'
  | 'CONNECTION_FAILED'
  | 'TEST_MODE';

type GatewayStatusSnapshot = {
  status: GatewayStatusCode;
  badge_label: string;
  badge_emoji: string;
  provider: string | null;
  display_name: string | null;
  configured: boolean;
  ready_for_production: boolean;
  message: string | null;
  configuration_error: string | null;
  health?: {
    api_keys_configured?: boolean;
    webhook_configured?: boolean | null;
    webhook_healthy?: boolean | null;
    enabled?: boolean;
    last_connection_test_at?: string | null;
    last_connection_test_status?: string | null;
    last_error_message?: string | null;
    last_webhook_at?: string | null;
  };
};

interface ServiceAreaPaymentGatewayConfigProps {
  serviceAreaId: string;
  serviceAreaName?: string;
  onCustomerGatewayChange?: (provider: string | null) => void;
}

const UNSET_VALUE = '__unset__';

function statusBadgeClass(status: GatewayStatusCode): string {
  switch (status) {
    case 'CONNECTED':
      return 'text-green-700 border-green-500/40 bg-green-50';
    case 'TEST_MODE':
      return 'text-blue-700 border-blue-500/40 bg-blue-50';
    case 'DISABLED':
      return 'text-amber-700 border-amber-500/40 bg-amber-50';
    case 'CONNECTION_FAILED':
      return 'text-red-700 border-red-500/40 bg-red-50';
    default:
      return '';
  }
}

function GatewayStatusBadge({ snapshot }: { snapshot: GatewayStatusSnapshot | null }) {
  if (!snapshot) return <Badge variant="secondary">Loading…</Badge>;
  return (
    <Badge variant="outline" className={statusBadgeClass(snapshot.status)}>
      {snapshot.badge_emoji} {snapshot.badge_label}
    </Badge>
  );
}

export function ServiceAreaPaymentGatewayConfig({
  serviceAreaId,
  serviceAreaName,
  onCustomerGatewayChange,
}: ServiceAreaPaymentGatewayConfigProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [customerGateway, setCustomerGateway] = useState<string | null>(null);
  const [driverGateway, setDriverGateway] = useState<string | null>(null);
  const [customerStatus, setCustomerStatus] = useState<GatewayStatusSnapshot | null>(null);
  const [driverStatus, setDriverStatus] = useState<GatewayStatusSnapshot | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [providersRes, areaRes, statusRes] = await Promise.all([
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
        invokePaymentProviders('GET', {
          action: 'service-area-gateways',
          service_area_id: serviceAreaId,
        }) as Promise<{
          success?: boolean;
          customer?: GatewayStatusSnapshot;
          driver?: GatewayStatusSnapshot;
        }>,
      ]);

      if (providersRes.error) throw providersRes.error;
      if (areaRes.error) throw areaRes.error;

      setProviders((providersRes.data ?? []) as ProviderOption[]);
      setCustomerGateway(areaRes.data?.customer_payment_gateway ?? null);
      onCustomerGatewayChange?.(areaRes.data?.customer_payment_gateway ?? null);
      setDriverGateway(areaRes.data?.driver_payout_gateway ?? null);
      setCustomerStatus(statusRes.customer ?? null);
      setDriverStatus(statusRes.driver ?? null);
    } catch {
      toast.error('Failed to load payment gateway configuration');
    } finally {
      setIsLoading(false);
    }
  }, [serviceAreaId, onCustomerGatewayChange]);

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
      await load();
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
  const hasConfigErrors = Boolean(
    customerStatus?.configuration_error || driverStatus?.configuration_error,
  );

  const customerAdapterStatus = customerStatus
    ? resolveProviderBookingAdapterStatus(
        customerStatus.provider,
        customerStatus.ready_for_production,
      )
    : 'not_configured';

  const customerAdapterNotLive =
    Boolean(customerGateway)
    && customerStatus?.ready_for_production === true
    && !isCustomerBookingAdapterLive(customerGateway);

  const bookingWorkflowLabel = isStripePreauthProvider(customerGateway)
    ? 'Stripe preauth (card / Apple Pay / Google Pay)'
    : isMobileWalletCollectProvider(customerGateway)
      ? 'Mobile wallet collect (pay before dispatch)'
      : 'Not configured';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowRightLeft className="h-5 w-5 text-primary" />
          Payment Gateways
        </CardTitle>
        <CardDescription>
          Each service area must explicitly choose a customer payment gateway and a driver payout gateway.
          Operational status comes from the backend — API keys, webhooks, health, and connection tests.
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

        {hasConfigErrors && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {customerStatus?.configuration_error
                ? `Customer: ${customerStatus.configuration_error}. `
                : ''}
              {driverStatus?.configuration_error
                ? `Driver: ${driverStatus.configuration_error}.`
                : ''}
            </AlertDescription>
          </Alert>
        )}

        {customerAdapterNotLive && (
          <Alert className="border-amber-500/50 bg-amber-50">
            <AlertTriangle className="h-4 w-4 text-amber-700" />
            <AlertDescription className="text-amber-900">
              <strong>PROVIDER_NOT_IMPLEMENTED — </strong>
              {providerNotImplementedMessage(
                customerStatus?.display_name ?? null,
                customerGateway!,
              )}
              {' '}
              Customer apps will block booking until the live adapter is deployed. Do not enable
              this gateway for production until contracts, sandbox keys, webhooks, and settlement
              are confirmed.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Booking workflow:</span>
          <Badge variant="outline">{bookingWorkflowLabel}</Badge>
          {customerAdapterStatus === 'live' && (
            <Badge className="bg-green-600">Live adapter</Badge>
          )}
          {customerAdapterStatus === 'not_implemented' && (
            <Badge variant="destructive">PROVIDER_NOT_IMPLEMENTED</Badge>
          )}
          {customerAdapterStatus === 'not_configured' && (
            <Badge variant="secondary">Not ready</Badge>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 p-3 border rounded-lg">
            <div className="flex items-center justify-between gap-2">
              <Label className="flex items-center gap-2 font-medium">
                <CreditCard className="h-4 w-4" />
                Customer payment gateway
              </Label>
              <GatewayStatusBadge snapshot={customerStatus} />
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
              Selected: {providerLabel(customerGateway)}
            </p>
            {customerStatus?.message ? (
              <p className="text-xs text-muted-foreground">{customerStatus.message}</p>
            ) : null}
          </div>

          <div className="space-y-2 p-3 border rounded-lg">
            <div className="flex items-center justify-between gap-2">
              <Label className="flex items-center gap-2 font-medium">
                <ArrowRightLeft className="h-4 w-4" />
                Driver payout gateway
              </Label>
              <GatewayStatusBadge snapshot={driverStatus} />
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
              Selected: {providerLabel(driverGateway)}
            </p>
            {driverStatus?.message ? (
              <p className="text-xs text-muted-foreground">{driverStatus.message}</p>
            ) : null}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Configure provider API keys under Integrations → Payment Providers. Status reflects live
          backend checks — never the dropdown selection alone.
        </p>
      </CardContent>
    </Card>
  );
}
