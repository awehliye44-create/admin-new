import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPence } from '@/hooks/useDriverWallet';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { driverWalletTxTypeLabel } from '@/lib/driverWalletTransactionTypes';
import {
  formatStoredPenceOrUnknown,
  isPositiveStoredPence,
  resolveTripAirportPence,
} from '@/lib/adminFareComponentDisplay';
import { Loader2 } from 'lucide-react';

type TimelineEvent = {
  id: string;
  at: string;
  kind: string;
  label: string;
  amountPence: number | null;
  detail?: string;
  airportBreakdownPence?: number | null;
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
  const airportByTrip = new Map<string, number | null>();
  for (const row of driver.settlement_history ?? []) {
    if (row.trip_id) {
      airportByTrip.set(row.trip_id, row.airport_charge_pence ?? null);
    }
  }

  for (const lr of driver.ledger_rows ?? []) {
    const rawType = String(lr.type ?? 'Ledger');
    const tripId = lr.related_trip_id ?? lr.trip_id;
    const tripKey = tripId ? String(tripId) : null;
    const upper = rawType.toUpperCase();
    const isTen = upper === 'TRIP_EARNING_NET' || upper === 'TRIP_CREDIT';
    events.push({
      id: `ledger-${String(lr.id)}`,
      at: String(lr.created_at ?? ''),
      kind: 'ledger',
      label: driverWalletTxTypeLabel(rawType),
      amountPence: Number(lr.amount_pence ?? 0),
      detail: tripKey
        ? `trip ${tripKey.slice(0, 8)}`
        : lr.provider_transfer_id
          ? `transfer ${String(lr.provider_transfer_id).slice(0, 12)}`
          : undefined,
      airportBreakdownPence: isTen && tripKey
        ? resolveTripAirportPence({ airport_charge_pence: airportByTrip.get(tripKey) ?? null })
        : null,
    });
  }

  for (const pi of driver.payout_items ?? []) {
    events.push({
      id: `payout-${String(pi.id)}`,
      at: String(pi.completed_at ?? pi.created_at ?? ''),
      kind: 'payout',
      label: `Payout ${String(pi.status ?? '')}`,
      amountPence: Number(pi.net_driver_payout_pence ?? pi.amount_pence ?? 0),
      detail: pi.provider_payout_id ? String(pi.provider_payout_id) : undefined,
    });
  }

  for (const sp of driver.provider_connect_payouts ?? []) {
    events.push({
      id: `provider-po-${String(sp.payout_id)}`,
      at: String(sp.initiated_at ?? ''),
      kind: 'provider',
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
  const ccy = currencyCode ?? 'GBP';

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Timeline</CardTitle>
        <p className="text-sm text-muted-foreground">
          Newest first — ledger, payouts, and Provider events. Tips stay as Tip (never folded into Trip earning).
        </p>
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
                  {isPositiveStoredPence(event.airportBreakdownPence) ? (
                    <p
                      className="text-[11px] text-muted-foreground mt-0.5"
                      data-testid="ten-airport-breakdown"
                    >
                      Airport included in trip earning:{' '}
                      {formatStoredPenceOrUnknown(event.airportBreakdownPence, ccy)}
                      {' '}(not a separate ledger row)
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
