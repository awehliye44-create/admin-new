/**
 * Batch-enrich trip rows with read-only Payment Sessions disposition.
 * Operational pages only — never wallet/payout for customer fare.
 */
import { supabase } from '@/integrations/supabase/client';
import {
  ADMIN_PAYMENT_SESSION_DISPOSITION_SELECT,
  buildAdminTripPaymentDispositionRead,
  type AdminPaymentSessionDispositionInput,
  type AdminTripPaymentDispositionRead,
  type AdminTripPaymentDispositionTrip,
} from '../../shared/adminTripPaymentDispositionSSOT';

export async function loadPaymentSessionsByTripIds(
  tripIds: string[],
): Promise<Map<string, AdminPaymentSessionDispositionInput[]>> {
  const map = new Map<string, AdminPaymentSessionDispositionInput[]>();
  if (tripIds.length === 0) return map;

  const { data, error } = await supabase
    .from('payment_sessions')
    .select(ADMIN_PAYMENT_SESSION_DISPOSITION_SELECT)
    .in('trip_id', tripIds);

  if (error) {
    console.warn('[adminTripPaymentDisposition] payment_sessions load failed:', error.message);
    return map;
  }

  for (const row of data ?? []) {
    const tripId = String((row as { trip_id?: string }).trip_id ?? '');
    if (!tripId) continue;
    const list = map.get(tripId) ?? [];
    list.push(row as AdminPaymentSessionDispositionInput);
    map.set(tripId, list);
  }
  return map;
}

export function attachTripPaymentDisposition<T extends AdminTripPaymentDispositionTrip>(
  trip: T,
  sessions: AdminPaymentSessionDispositionInput[] | null | undefined,
  surface: 'trip_history' | 'missed_cancelled',
): T & { payment_disposition: AdminTripPaymentDispositionRead } {
  const payment_disposition = buildAdminTripPaymentDispositionRead({
    trip,
    sessions,
    surface,
  });
  return {
    ...trip,
    payment_disposition,
    terminal_disposition_reason: payment_disposition.terminal_disposition_reason,
  };
}

export async function enrichTripsWithPaymentDisposition<
  T extends AdminTripPaymentDispositionTrip,
>(
  trips: T[],
  surface: 'trip_history' | 'missed_cancelled',
): Promise<Array<T & { payment_disposition: AdminTripPaymentDispositionRead }>> {
  const tripIds = trips.map((t) => String((t as { id?: string }).id ?? '')).filter(Boolean);
  const sessionsByTrip = await loadPaymentSessionsByTripIds(tripIds);
  return trips.map((trip) => {
    const id = String((trip as { id?: string }).id ?? '');
    return attachTripPaymentDisposition(trip, sessionsByTrip.get(id), surface);
  });
}
