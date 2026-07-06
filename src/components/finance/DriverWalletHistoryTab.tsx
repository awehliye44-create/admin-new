import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPence } from '@/hooks/useDriverWallet';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { Loader2 } from 'lucide-react';

type TimelineEvent = {
  id: string;
  at: string;
  kind: string;
  label: string;
  amountPence: number | null;
  detail?: string;
};

function formatDate(iso: string): string {
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

function buildTimeline(driver: DriverWalletSsotRow): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const lr of driver.ledger_rows ?? []) {
    events.push({
      id: `ledger-${String(lr.id)}`,
      at: String(lr.created_at ?? ''),
      kind: 'ledger',
      label: String(lr.type ?? 'Ledger'),
      amountPence: Number(lr.amount_pence ?? 0),
      detail: (lr.related_trip_id ?? lr.trip_id)
        ? `trip ${String(lr.related_trip_id ?? lr.trip_id).slice(0, 8)}`
        : lr.stripe_transfer_id
          ? `transfer ${String(lr.stripe_transfer_id).slice(0, 12)}`
          : undefined,
    });
  }

  for (const pi of driver.payout_items ?? []) {
    events.push({
      id: `payout-${String(pi.id)}`,
      at: String(pi.completed_at ?? pi.created_at ?? ''),
      kind: 'payout',
      label: `Payout ${String(pi.status ?? '')}`,
      amountPence: Number(pi.net_driver_payout_pence ?? pi.amount_pence ?? 0),
      detail: pi.stripe_payout_id ? String(pi.stripe_payout_id) : undefined,
    });
  }

  for (const sp of driver.stripe_connect_payouts ?? []) {
    events.push({
      id: `stripe-po-${String(sp.payout_id)}`,
      at: String(sp.initiated_at ?? ''),
      kind: 'stripe',
      label: `Provider bank payout ${String(sp.status ?? '')}`,
      amountPence: Number(sp.amount_pence ?? 0),
      detail: sp.bank_last4 ? `bank ···${String(sp.bank_last4)}` : undefined,
    });
  }

  return events
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export function DriverWalletHistoryTab({
  driver,
  currencyCode,
  isLoading,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading history…
      </div>
    );
  }

  if (!driver) {
    return <p className="text-sm text-muted-foreground py-8">Select a driver to view timeline history.</p>;
  }

  const timeline = buildTimeline(driver);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Timeline</CardTitle>
        <p className="text-sm text-muted-foreground">Newest first — ledger, payouts, and Provider events.</p>
      </CardHeader>
      <CardContent>
        {timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No history events</p>
        ) : (
          <ol className="space-y-3">
            {timeline.map((event) => (
              <li key={event.id} className="flex gap-3 border-b pb-3 last:border-0">
                <div className="text-xs text-muted-foreground whitespace-nowrap w-36 shrink-0 pt-0.5">
                  {formatDate(event.at)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[10px] capitalize">{event.kind}</Badge>
                    <span className="text-sm font-medium">{event.label}</span>
                    {event.amountPence != null && (
                      <span className="text-sm">{formatPence(event.amountPence, currencyCode)}</span>
                    )}
                  </div>
                  {event.detail && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">{event.detail}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
