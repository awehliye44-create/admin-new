import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Info } from 'lucide-react';
import { formatMoneyMinor } from '@/lib/formatMoneyMinor';

type PlatformStripePendingExplainerProps = {
  pendingPence: number;
  availablePence: number;
  currencyCode?: string | null;
  driverWalletTotalPence?: number | null;
  driverScheduledPayoutPence?: number | null;
};

/**
 * Platform Stripe Pending ≠ driver weekly earnings.
 * ONECAB platform incoming settlement from Stripe (authorisations, uncaptured/captured-not-settled, timing).
 */
export function PlatformStripePendingExplainer({
  pendingPence,
  availablePence,
  currencyCode,
  driverWalletTotalPence,
  driverScheduledPayoutPence,
}: PlatformStripePendingExplainerProps) {
  const fmt = (p: number) => formatMoneyMinor(p, currencyCode ?? 'GBP');
  const hasDriverContext = driverWalletTotalPence != null || driverScheduledPayoutPence != null;

  return (
    <Alert className="border-blue-500/30 bg-blue-500/5">
      <Info className="h-4 w-4 text-blue-600" />
      <AlertTitle className="text-sm">Platform Stripe Pending — {fmt(pendingPence)}</AlertTitle>
      <AlertDescription className="text-xs space-y-2 mt-1">
        <p>
          <strong>Not driver wallet earnings.</strong> This is ONECAB&apos;s platform Stripe balance awaiting settlement
          (card authorisations, captured-but-not-yet-available funds, refunds in transit, platform timing).
        </p>
        <ul className="list-disc pl-4 space-y-0.5">
          <li>Platform Stripe Available: {fmt(availablePence)}</li>
          {hasDriverContext ? (
            <>
              <li>Driver wallet unpaid (all drivers in scope): {fmt(driverWalletTotalPence ?? 0)}</li>
              <li>Driver scheduled payout queue: {fmt(driverScheduledPayoutPence ?? 0)}</li>
            </>
          ) : null}
        </ul>
        <p className="text-muted-foreground">
          Driver Weekly Earnings on the driver app come from ledger + payout cycle SSOT — never from this platform pending figure.
        </p>
      </AlertDescription>
    </Alert>
  );
}
