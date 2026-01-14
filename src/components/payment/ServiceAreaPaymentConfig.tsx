import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Loader2, Banknote, CreditCard, Wallet, Apple, Smartphone } from 'lucide-react';
import { useServiceAreaPaymentMethods, PaymentMethodType } from '@/hooks/useServiceAreaPaymentMethods';
import { toast } from 'sonner';

interface ServiceAreaPaymentConfigProps {
  serviceAreaId: string;
  serviceAreaName?: string;
}

const PAYMENT_METHOD_ICONS: Record<string, React.ReactNode> = {
  banknote: <Banknote className="h-5 w-5" />,
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
  const { paymentConfig, isLoading, isSaving, updatePaymentMethod, allPaymentMethods } = useServiceAreaPaymentMethods(serviceAreaId);

  const handleToggle = async (method: PaymentMethodType, enabled: boolean) => {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-primary" />
          Payment Methods
        </CardTitle>
        <CardDescription>
          Configure which payment methods are available for customers in {serviceAreaName || 'this service area'}.
          <span className="block mt-1 text-xs text-primary font-medium">
            ✓ Service Area is the single source of truth for payment configuration.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {allPaymentMethods.map((method) => {
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
                    {method.id === 'cash' && 'Accept cash payments'}
                    {method.id === 'card' && 'Credit/debit cards'}
                    {method.id === 'wallet' && 'Wallet balance'}
                    {method.id === 'apple_pay' && 'Apple Pay (iOS)'}
                    {method.id === 'google_pay' && 'Google Pay (Android)'}
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
