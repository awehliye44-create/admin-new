import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, CreditCard, Wallet, Apple, Smartphone, Info } from 'lucide-react';
import { useServiceAreaPaymentMethods, type StripeDigitalPaymentMethodType } from '@/hooks/useServiceAreaPaymentMethods';
import { isStripePreauthProvider, isMobileWalletCollectProvider } from '@/lib/customerPaymentWorkflow';
import { toast } from 'sonner';

interface ServiceAreaPaymentConfigProps {
  serviceAreaId: string;
  serviceAreaName?: string;
}

const PAYMENT_METHOD_ICONS: Record<string, React.ReactNode> = {
  'credit-card': <CreditCard className="h-5 w-5" />,
  wallet: <Wallet className="h-5 w-5" />,
  apple: <Apple className="h-5 w-5" />,
  smartphone: <Smartphone className="h-5 w-5" />,
};

const PLATFORM_LABELS: Record<string, { label: string; color: string }> = {
  ios: { label: 'iOS', color: 'bg-gray-500' },
  android: { label: 'Android', color: 'bg-green-600' },
  all: { label: 'All', color: 'bg-blue-500' },
};

export function ServiceAreaPaymentConfig({ serviceAreaId, serviceAreaName }: ServiceAreaPaymentConfigProps) {
  const {
    paymentConfig,
    customerPaymentGateway,
    isLoading,
    isSaving,
    updatePaymentMethod,
    stripeDigitalMethods,
  } = useServiceAreaPaymentMethods(serviceAreaId);

  const handleToggle = async (method: StripeDigitalPaymentMethodType, enabled: boolean) => {
    try {
      await updatePaymentMethod(method, enabled);
      toast.success(`${enabled ? 'Enabled' : 'Disabled'} ${method.replace('_', ' ')}`);
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

  if (!paymentConfig) {
    return null;
  }

  if (isMobileWalletCollectProvider(customerPaymentGateway)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-primary" />
            Card / wallet preauth methods
          </CardTitle>
          <CardDescription>
            This service area uses a mobile-wallet collect gateway ({customerPaymentGateway}).
            Card, Apple Pay, and Google Pay are not offered — configure mobile wallet methods below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              ONECAB is fully digital. Cash is not enabled. Stripe card preauth toggles do not apply
              to this gateway.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (!isStripePreauthProvider(customerPaymentGateway)) {
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
            <AlertDescription>
              Select a customer payment gateway above before enabling digital payment methods.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-primary" />
          Stripe digital payment methods
        </CardTitle>
        <CardDescription>
          Methods available for customers in {serviceAreaName || 'this service area'} when the gateway
          is Stripe (card pre-authorisation workflow). Cash is disabled — ONECAB is fully digital.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <Badge variant="outline">Gateway: Stripe</Badge>
          <Badge variant="secondary">No cash</Badge>
        </div>
        {stripeDigitalMethods.map((method) => {
          const isEnabled = paymentConfig[`${method.id}_enabled` as keyof typeof paymentConfig] as boolean;
          const platformInfo = PLATFORM_LABELS[method.platform];

          return (
            <div
              key={method.id}
              className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${isEnabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  {PAYMENT_METHOD_ICONS[method.icon]}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <Label className="font-medium">{method.name}</Label>
                    {method.platform !== 'all' && (
                      <Badge variant="secondary" className={`text-xs text-white ${platformInfo.color}`}>
                        {platformInfo.label}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {method.id === 'card' && 'Credit/debit cards (preauth → capture)'}
                    {method.id === 'wallet' && 'ONECAB in-app wallet balance'}
                    {method.id === 'apple_pay' && 'Apple Pay (iOS native)'}
                    {method.id === 'google_pay' && 'Google Pay (Android native)'}
                  </p>
                </div>
              </div>
              <Switch
                checked={isEnabled}
                onCheckedChange={(checked) => handleToggle(method.id, checked)}
                disabled={isSaving}
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
