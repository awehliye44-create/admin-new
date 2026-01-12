import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Loader2, Banknote, CreditCard, Wallet, Apple, Smartphone } from 'lucide-react';
import { usePaymentMethodsAdmin, PaymentMethodType } from '@/hooks/usePaymentMethods';
import { toast } from 'sonner';

interface PaymentMethodsConfigProps {
  regionId: string;
  regionName?: string;
}

const PAYMENT_METHOD_ICONS: Record<string, React.ReactNode> = {
  banknote: <Banknote className="h-5 w-5" />,
  'credit-card': <CreditCard className="h-5 w-5" />,
  wallet: <Wallet className="h-5 w-5" />,
  apple: <Apple className="h-5 w-5" />,
  smartphone: <Smartphone className="h-5 w-5" />,
};

const PLATFORM_LABELS: Record<string, { label: string; color: string }> = {
  ios: { label: 'iOS Only', color: 'bg-gray-500' },
  android: { label: 'Android Only', color: 'bg-green-600' },
  all: { label: 'All Platforms', color: 'bg-blue-500' },
};

export function PaymentMethodsConfig({ regionId, regionName }: PaymentMethodsConfigProps) {
  const { paymentConfig, isLoading, isSaving, updatePaymentMethod, allPaymentMethods } = usePaymentMethodsAdmin(regionId);

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
          Configure which payment methods are available for customers in {regionName || 'this region'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {allPaymentMethods.map((method) => {
          const isEnabled = paymentConfig[`${method.id}_enabled` as keyof typeof paymentConfig] as boolean;
          const platformInfo = PLATFORM_LABELS[method.platform || 'all'];

          return (
            <div
              key={method.id}
              className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
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
                  <p className="text-sm text-muted-foreground">
                    {method.id === 'cash' && 'Accept cash payments from customers'}
                    {method.id === 'card' && 'Accept credit/debit card payments'}
                    {method.id === 'wallet' && 'Accept payments from customer wallet balance'}
                    {method.id === 'apple_pay' && 'Enable Apple Pay for iOS customers'}
                    {method.id === 'google_pay' && 'Enable Google Pay for Android customers'}
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

        <div className="mt-4 p-3 bg-muted/50 rounded-lg text-sm text-muted-foreground">
          <p className="font-medium mb-1">💡 Platform-specific payments</p>
          <p>Apple Pay will only appear for iOS customers. Google Pay will only appear for Android customers.</p>
        </div>
      </CardContent>
    </Card>
  );
}
