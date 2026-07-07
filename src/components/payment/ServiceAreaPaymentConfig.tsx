import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, CreditCard, Wallet, Apple, Smartphone, Landmark, Bookmark, Info } from 'lucide-react';
import { useDigitalPaymentMethods } from '@/hooks/useDigitalPaymentMethods';
import {
  PAYMENT_METHOD_ADMIN_LABELS,
  PAYMENT_METHOD_TOGGLE_FIELDS,
  isMethodToggleDisabled,
  payoutAdapterDisplayLabel,
  readinessBadgeClass,
  readinessBadgeLabel,
  type PaymentMethodKind,
} from '@/lib/paymentMethodSSOT';
import { toast } from 'sonner';

interface ServiceAreaPaymentConfigProps {
  serviceAreaId: string;
  serviceAreaName?: string;
}

const METHOD_ICONS: Partial<Record<PaymentMethodKind, React.ReactNode>> = {
  card: <CreditCard className="h-5 w-5" />,
  saved_card: <Bookmark className="h-5 w-5" />,
  apple_pay: <Apple className="h-5 w-5" />,
  google_pay: <Smartphone className="h-5 w-5" />,
  mobile_wallet: <Smartphone className="h-5 w-5" />,
  pay_by_bank: <Landmark className="h-5 w-5" />,
  onecab_wallet: <Wallet className="h-5 w-5" />,
};

export function ServiceAreaPaymentConfig({ serviceAreaId, serviceAreaName }: ServiceAreaPaymentConfigProps) {
  const {
    methods,
    customerCollection,
    driverPayout,
    paymentProvider,
    isLoading,
    isSaving,
    error,
    updateMethodToggle,
  } = useDigitalPaymentMethods(serviceAreaId);

  const handleToggle = async (method: PaymentMethodKind, enabled: boolean) => {
    const field = PAYMENT_METHOD_TOGGLE_FIELDS[method];
    try {
      await updateMethodToggle(field, enabled);
      toast.success(`${enabled ? 'Enabled' : 'Disabled'} ${PAYMENT_METHOD_ADMIN_LABELS[method]}`);
    } catch {
      toast.error('Failed to update payment method');
    }
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

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" />
            Digital payment methods
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (!paymentProvider) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" />
            Digital payment methods
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              Select a primary payment provider above before configuring digital payment methods.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const collectionLive =
    customerCollection?.ready_for_production === true
    || customerCollection?.booking_adapter_status === 'live';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-primary" />
          Digital payment methods
        </CardTitle>
        <CardDescription>
          Provider-neutral customer payment options for {serviceAreaName || 'this service area'}.
          Vault implementation follows the selected provider ({paymentProvider}) — saved cards are
          standard ONECAB functionality, not Stripe-only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2 p-3 border rounded-lg bg-muted/30">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Customer collection
            </p>
            <p className="text-sm font-medium capitalize">{paymentProvider.replace(/_/g, ' ')}</p>
            <Badge variant="outline" className="text-green-700 border-green-500/40 bg-green-50">
              {collectionLive ? 'Connected / live' : (customerCollection?.booking_adapter_status ?? 'unknown')}
            </Badge>
            {customerCollection?.message ? (
              <p className="text-xs text-muted-foreground">{customerCollection.message}</p>
            ) : null}
          </div>
          <div className="space-y-2 p-3 border rounded-lg bg-muted/30">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Driver payout
            </p>
            <p className="text-sm font-medium">
              {driverPayout?.payout_automation === 'manual_ready'
                ? 'Manual payout ready'
                : driverPayout?.payout_automation === 'automated_ready'
                  ? 'Automated payout ready'
                  : 'Not configured'}
            </p>
            <Badge variant="outline" className="text-amber-700 border-amber-500/40 bg-amber-50">
              {payoutAdapterDisplayLabel(
                driverPayout?.payout_adapter_status,
                driverPayout?.payout_automation,
              )}
            </Badge>
            {driverPayout?.message ? (
              <p className="text-xs text-muted-foreground">{driverPayout.message}</p>
            ) : null}
            {driverPayout?.automated_payout_message ? (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Automated payout: </span>
                {driverPayout.automated_payout_message}
              </p>
            ) : null}
          </div>
        </div>

        <div className="space-y-3">
          {methods.map((method) => {
            const label = PAYMENT_METHOD_ADMIN_LABELS[method.method];
            const icon = METHOD_ICONS[method.method] ?? <CreditCard className="h-5 w-5" />;
            const toggleDisabled = isMethodToggleDisabled(method.readiness, isSaving);
            const displayEnabled = method.enabled && method.readiness !== 'not_implemented';

            return (
              <div
                key={method.method}
                className="flex items-center justify-between gap-3 p-3 border rounded-lg hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`p-2 rounded-lg shrink-0 ${
                      displayEnabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {icon}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label className="font-medium">{label}</Label>
                      <Badge
                        variant="outline"
                        className={readinessBadgeClass(method.readiness)}
                      >
                        {readinessBadgeLabel(method.readiness, method.message)}
                      </Badge>
                      {method.environment && method.readiness !== 'not_implemented' ? (
                        <Badge variant="secondary" className="text-xs">
                          {method.environment}
                        </Badge>
                      ) : null}
                    </div>
                    {method.message ? (
                      <p className="text-xs text-muted-foreground mt-0.5">{method.message}</p>
                    ) : method.vault_provider ? (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Vault: {method.vault_provider}
                      </p>
                    ) : null}
                  </div>
                </div>
                <Switch
                  checked={displayEnabled}
                  onCheckedChange={(checked) => void handleToggle(method.method, checked)}
                  disabled={toggleDisabled}
                />
              </div>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground">
          Customer card payments are not blocked when automated driver payout is missing. Revolut
          collection uses the Merchant API; automated payouts need the Source Business Account ID.
        </p>
      </CardContent>
    </Card>
  );
}
