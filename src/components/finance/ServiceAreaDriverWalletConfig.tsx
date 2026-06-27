import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Wallet, Zap } from 'lucide-react';

interface ServiceAreaDriverWalletConfigProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  serviceAreaName?: string;
  disabled?: boolean;
}

export function ServiceAreaDriverWalletConfig({
  enabled,
  onChange,
  serviceAreaName,
  disabled,
}: ServiceAreaDriverWalletConfigProps) {
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
      <CardContent>
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
                Weekly payouts and wallet balance are not affected.
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
