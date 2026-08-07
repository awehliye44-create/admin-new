/**
 * Admin passenger display name helpers.
 * Prefer denormalized trips.passenger_name when real; fall back to customers
 * profile for historical "Guest" / empty snapshots from self-bookings.
 */

import { supabase } from '@/integrations/supabase/client';

export function isPlaceholderPassengerName(name: string | null | undefined): boolean {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return lower === 'guest' || lower === 'unknown' || lower === 'n/a';
}

export function formatCustomerNameParts(input: {
  first_name?: string | null;
  last_name?: string | null;
} | null | undefined): string | null {
  if (!input) return null;
  const name = [input.first_name, input.last_name]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
  return name || null;
}

/**
 * Display label for admin trip tables / dialogs.
 * Real stored name wins; otherwise customer profile; else Unknown.
 */
export function resolvePassengerDisplayName(input: {
  passenger_name?: string | null;
  customer?: { first_name?: string | null; last_name?: string | null } | null;
}): string {
  const stored = (input.passenger_name ?? '').trim();
  const fromCustomer = formatCustomerNameParts(input.customer);
  if (stored && !isPlaceholderPassengerName(stored)) return stored;
  if (fromCustomer) return fromCustomer;
  if (stored) return stored;
  return 'Unknown';
}

type TripWithPassenger = {
  passenger_id?: string | null;
  passenger_name?: string | null;
  passenger_phone?: string | null;
  [key: string]: unknown;
};

/**
 * For trips with Guest/empty passenger_name, fill from customers by passenger_id.
 * Mutates a shallow copy of each trip (does not rewrite the DB).
 */
export async function enrichTripsWithPassengerNames<T extends TripWithPassenger>(
  trips: T[],
): Promise<T[]> {
  const needIds = Array.from(
    new Set(
      trips
        .filter((trip) => isPlaceholderPassengerName(trip.passenger_name) && trip.passenger_id)
        .map((trip) => String(trip.passenger_id)),
    ),
  );
  if (needIds.length === 0) return trips;

  const { data, error } = await supabase
    .from('customers')
    .select('id, first_name, last_name, phone')
    .in('id', needIds);

  if (error || !data?.length) return trips;

  const byId = new Map(
    data.map((row) => [
      row.id as string,
      {
        first_name: (row.first_name as string | null) ?? null,
        last_name: (row.last_name as string | null) ?? null,
        phone: (row.phone as string | null) ?? null,
      },
    ]),
  );

  return trips.map((trip) => {
    if (!isPlaceholderPassengerName(trip.passenger_name) || !trip.passenger_id) {
      return trip;
    }
    const customer = byId.get(String(trip.passenger_id));
    if (!customer) return trip;
    const name = formatCustomerNameParts(customer);
    if (!name && !customer.phone) return trip;
    return {
      ...trip,
      passenger_name: name ?? trip.passenger_name,
      passenger_phone:
        (typeof trip.passenger_phone === 'string' && trip.passenger_phone.trim())
          ? trip.passenger_phone
          : (customer.phone ?? trip.passenger_phone),
    };
  });
}
