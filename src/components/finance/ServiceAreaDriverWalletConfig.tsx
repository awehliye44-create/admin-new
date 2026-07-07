import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Wallet, Zap, Info } from 'lucide-react';
import { useDigitalPaymentMethods } from '@/hooks/useDigitalPaymentMethods';

interface ServiceAreaDriverWalletConfigProps {
  serviceAreaId: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  serviceAreaName?: string;
  disabled?: boolean;
}

export function ServiceAreaDriverWalletConfig({
  serviceAreaId,
  enabled,
  onChange,
  serviceAreaName,
  disabled,
}: ServiceAreaDriverWalletConfigProps) {
  const { driverPayout, paymentProvider } = useDigitalPaymentMethods(serviceAreaId);
  const manualRevolutPayout =
    paymentProvider === 'revolut' && driverPayout?.payout_automation === 'manual_ready';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-5 w-5 text-primary" />
          Driver wallet — Early Cash Out
        </CardTitle>
        <CardDescription>
          Payment / wallet settings for drivers in {serviceAreaName || 'this service area'}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {manualRevolutPayout && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              {driverPayout?.driver_wallet_message
                ?? driverPayout?.message
                ?? 'Payout account ready — weekly payouts handled manually by ONECAB until automated payout is enabled.'}
            </AlertDescription>
          </Alert>
        )}
        <div className="flex items-center justify-between gap-4 p-3 border rounded-lg">
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-lg ${enabled ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground'}`}>
              <Zap className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="early-cashout-toggle" className="font-medium">
                Enable Early Cash Out
              </Label>
              <p className="text-xs text-muted-foreground max-w-xl">
                Controls whether drivers in this service area can use Instant Cash Out.
                Weekly payouts are not affected.
              </p>
            </div>
          </div>
          <Switch
            id="early-cashout-toggle"
            checked={enabled}
            onCheckedChange={onChange}
            disabled={disabled}
          />
        </div>
      </CardContent>
    </Card>
  );
}
