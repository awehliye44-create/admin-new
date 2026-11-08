import { adminLookupByIds } from '@/lib/adminPageGatedData';

/**
 * Trip passenger display SSOT.
 *
 * `trips.passenger_name` / `trips.passenger_phone` are booking-time snapshots and are
 * frequently blank or a placeholder ("Guest"). The authoritative rider identity lives on
 * `customers`, matched by `trips.passenger_id`. Admin pages must always prefer the customer
 * record and only fall back to the snapshot.
 */

const PLACEHOLDER_NAMES = new Set([
  '',
  'guest',
  'unknown',
  'unknown customer',
  'customer',
  'rider',
  'passenger',
  'n/a',
  'na',
  '-',
  'null',
  'undefined',
]);

export function isPlaceholderPassengerName(value: string | null | undefined): boolean {
  return PLACEHOLDER_NAMES.has((value ?? '').trim().toLowerCase());
}

export interface PassengerDirectoryEntry {
  name: string | null;
  phone: string | null;
}

export type PassengerDirectory = Map<string, PassengerDirectoryEntry>;

/**
 * Load rider identities for the given passenger ids (deduped, chunked).
 * `pageSlug` must be a page that is allowlisted for customers SELECT.
 */
export async function fetchPassengerDirectory(
  passengerIds: Array<string | null | undefined>,
  pageSlug = 'trip-history',
): Promise<PassengerDirectory> {
  const ids = Array.from(new Set(passengerIds.filter((id): id is string => Boolean(id))));
  const directory: PassengerDirectory = new Map();
  if (ids.length === 0) return directory;

  const rows = await adminLookupByIds<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
  }>(pageSlug, 'customers', ids, ['id', 'first_name', 'last_name', 'phone']);

  for (const row of rows) {
    const name = [row.first_name, row.last_name]
      .map((part) => (part ?? '').trim())
      .filter(Boolean)
      .join(' ');
    directory.set(row.id, {
      name: name.length > 0 ? name : null,
      phone: (row.phone ?? '').trim() || null,
    });
  }
  return directory;
}

export interface PassengerSnapshotLike {
  passenger_id?: string | null;
  passenger_name?: string | null;
  passenger_phone?: string | null;
}

export function resolvePassengerName(
  trip: PassengerSnapshotLike,
  directory: PassengerDirectory,
): string | null {
  const fromDirectory = trip.passenger_id ? directory.get(trip.passenger_id)?.name : null;
  if (fromDirectory) return fromDirectory;
  const snapshot = (trip.passenger_name ?? '').trim();
  if (snapshot && !isPlaceholderPassengerName(snapshot)) return snapshot;
  return null;
}

export function resolvePassengerPhone(
  trip: PassengerSnapshotLike,
  directory: PassengerDirectory,
): string | null {
  const snapshot = (trip.passenger_phone ?? '').trim();
  if (snapshot) return snapshot;
  const fromDirectory = trip.passenger_id ? directory.get(trip.passenger_id)?.phone : null;
  return fromDirectory ?? null;
}

/** Overwrite snapshot fields with the resolved rider identity. */
export function hydratePassengerIdentity<T extends PassengerSnapshotLike>(
  rows: T[],
  directory: PassengerDirectory,
): T[] {
  return rows.map((row) => ({
    ...row,
    passenger_name: resolvePassengerName(row, directory),
    passenger_phone: resolvePassengerPhone(row, directory),
  }));
}
