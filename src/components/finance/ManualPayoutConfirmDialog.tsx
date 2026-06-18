import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { formatPence } from '@/hooks/useDriverWallet';
import type { PerDriverFinanceSSOT } from '@/hooks/usePerDriverFinancialReconciliation';
import {
  MANUAL_PAYOUT_SOFT_WARNING_MESSAGE,
  hasSoftPayoutWarning,
} from '@/lib/manualPayoutGate';

export type ManualPayoutConfirmDriver = {
  id: string;
  first_name: string;
  last_name: string;
  driver_code?: string | null;
  currency_code: string;
  wallet_balance: number;
};

export function ManualPayoutConfirmDialog({
  open,
  onOpenChange,
  driver,
  ssot,
  onConfirm,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driver: ManualPayoutConfirmDriver;
  ssot: PerDriverFinanceSSOT;
  onConfirm: () => void;
  isPending?: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);

  const amountToPay = ssot.driver_available_now_pence;
  const softWarning = hasSoftPayoutWarning(ssot);
  const driverLabel = driver.driver_code
    ? `${driver.first_name} ${driver.last_name} (${driver.driver_code})`
    : `${driver.first_name} ${driver.last_name}`;

  const handleOpenChange = (next: boolean) => {
    if (!next) setConfirmed(false);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirm Manual Driver Payout</DialogTitle>
          <DialogDescription>
            Review finance SSOT and Stripe allocation before executing payout.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <Row label="Driver" value={driverLabel} />
          <Row label="Wallet Balance (SSOT)" value={formatPence(driver.wallet_balance, driver.currency_code)} />
          <Row label="Ready for Payout" value={formatPence(amountToPay, driver.currency_code)} highlight />
          <Row label="Amount to pay now" value={formatPence(amountToPay, driver.currency_code)} highlight />
          <Row
            label="Available Stripe allocation"
            value={formatPence(ssot.provider_available_balance_allocated_to_driver_pence, driver.currency_code)}
          />
          <Row label="Payout method" value="Stripe Connect transfer" />
          <Row
            label="Hard block status"
            value={ssot.payout_blocked ? 'Blocked' : 'Clear'}
            variant={ssot.payout_blocked ? 'destructive' : 'outline'}
          />
          <Row
            label="Soft warning status"
            value={softWarning ? 'Present' : 'None'}
            variant={softWarning ? 'warning' : 'outline'}
          />

          {softWarning && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-amber-900 dark:text-amber-100">
              <p className="font-medium flex items-center gap-1">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {MANUAL_PAYOUT_SOFT_WARNING_MESSAGE}
              </p>
              <ul className="mt-2 list-disc pl-5 space-y-1 text-xs">
                {ssot.payout_warning_reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          {ssot.payout_blocked_reasons.length > 0 && (
            <ul className="list-disc pl-5 text-destructive space-y-1">
              {ssot.payout_blocked_reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}

          <div className="flex items-start gap-2 pt-2">
            <Checkbox
              id="confirm-payout"
              checked={confirmed}
              onCheckedChange={(v) => setConfirmed(v === true)}
            />
            <Label htmlFor="confirm-payout" className="text-xs leading-snug cursor-pointer">
              I confirm this payout is capped by finance SSOT and Stripe available allocation.
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={!confirmed || isPending || ssot.payout_blocked || amountToPay <= 0}
          >
            {isPending ? 'Processing…' : `Confirm payout ${formatPence(amountToPay, driver.currency_code)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  highlight,
  variant = 'default',
}: {
  label: string;
  value: string;
  highlight?: boolean;
  variant?: 'default' | 'destructive' | 'warning' | 'outline';
}) {
  return (
    <div className="flex justify-between items-center gap-4">
      <span className="text-muted-foreground">{label}</span>
      {variant === 'default' ? (
        <span className={`font-medium ${highlight ? 'text-green-600' : ''}`}>{value}</span>
      ) : (
        <Badge
          variant={variant === 'destructive' ? 'destructive' : variant === 'warning' ? 'secondary' : 'outline'}
          className={variant === 'warning' ? 'bg-amber-100 text-amber-900 border-amber-300' : ''}
        >
          {value}
        </Badge>
      )}
    </div>
  );
}
