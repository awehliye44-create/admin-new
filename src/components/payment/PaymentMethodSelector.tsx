import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Banknote, CreditCard, Wallet, Apple, Smartphone, Check } from 'lucide-react';
import { usePaymentMethods, PaymentMethodType } from '@/hooks/usePaymentMethods';

interface PaymentMethodSelectorProps {
  regionId: string;
  selectedMethod: PaymentMethodType | null;
  onMethodSelect: (method: PaymentMethodType) => void;
  className?: string;
}

const PAYMENT_METHOD_ICONS: Record<string, React.ReactNode> = {
  banknote: <Banknote className="h-5 w-5" />,
  'credit-card': <CreditCard className="h-5 w-5" />,
  wallet: <Wallet className="h-5 w-5" />,
  apple: <Apple className="h-5 w-5" />,
  smartphone: <Smartphone className="h-5 w-5" />,
};

export function PaymentMethodSelector({
  regionId,
  selectedMethod,
  onMethodSelect,
  className,
}: PaymentMethodSelectorProps) {
  const { availablePaymentMethods, isLoading, error } = usePaymentMethods(regionId);

  if (isLoading) {
    return (
      <div className={`space-y-3 ${className}`}>
        <Label className="text-sm font-medium">Payment Method</Label>
        <div className="grid gap-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`space-y-3 ${className}`}>
        <Label className="text-sm font-medium">Payment Method</Label>
        <Card className="border-destructive">
          <CardContent className="py-4 text-center text-sm text-destructive">
            Unable to load payment methods
          </CardContent>
        </Card>
      </div>
    );
  }

  if (availablePaymentMethods.length === 0) {
    return (
      <div className={`space-y-3 ${className}`}>
        <Label className="text-sm font-medium">Payment Method</Label>
        <Card>
          <CardContent className="py-4 text-center text-sm text-muted-foreground">
            No payment methods available for this region
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`}>
      <Label className="text-sm font-medium">Payment Method</Label>
      <RadioGroup
        value={selectedMethod || ''}
        onValueChange={(value) => onMethodSelect(value as PaymentMethodType)}
        className="grid gap-3"
      >
        {availablePaymentMethods.map((method) => {
          const isSelected = selectedMethod === method.id;

          return (
            <label
              key={method.id}
              className={`
                flex items-center gap-4 p-4 rounded-lg border-2 cursor-pointer transition-all
                ${isSelected
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50 hover:bg-muted/50'
                }
              `}
            >
              <RadioGroupItem value={method.id} id={method.id} className="sr-only" />
              
              <div className={`p-2 rounded-lg ${isSelected ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                {PAYMENT_METHOD_ICONS[method.icon]}
              </div>

              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{method.name}</span>
                  {method.platform === 'ios' && (
                    <Badge variant="secondary" className="text-xs">iOS</Badge>
                  )}
                  {method.platform === 'android' && (
                    <Badge variant="secondary" className="text-xs">Android</Badge>
                  )}
                </div>
              </div>

              {isSelected && (
                <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center">
                  <Check className="h-4 w-4 text-primary-foreground" />
                </div>
              )}
            </label>
          );
        })}
      </RadioGroup>
    </div>
  );
}
