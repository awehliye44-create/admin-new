/**
 * Canonical resolution of who cancelled a trip and why, for admin surfaces.
 * Reads recorded columns first (customer/driver/admin/system) and only falls
 * back to free-text notes when no structured reason was recorded.
 */

export interface TripCancellationReasonInput {
  status?: string | null;
  cancelled_by?: string | null;
  cancelled_by_role?: string | null;
  cancellation_reason?: string | null;
  cancel_reason?: string | null;
  cancellation_note?: string | null;
  arrival_cancellation_reason?: string | null;
  special_instructions?: string | null;
}

export type CancellationActor = 'Customer' | 'Driver' | 'Admin' | 'System' | null;

function clean(value?: string | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Turn codes like `booked-by-mistake` / `cancelled_by_admin` into readable text. */
export function humaniseCancellationReason(raw?: string | null): string {
  const value = clean(raw);
  if (!value) return '';
  const normalised = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalised) return '';
  // Already a sentence written by a human — keep as typed.
  if (/[A-Z]/.test(value) && /\s/.test(value)) return value;
  return normalised.charAt(0).toUpperCase() + normalised.slice(1).toLowerCase();
}

export function resolveCancellationActor(trip: TripCancellationReasonInput): CancellationActor {
  const by = clean(trip.cancelled_by).toLowerCase();
  const role = clean(trip.cancelled_by_role).toLowerCase();
  const source = `${by} ${role}`;
  if (/rider|passenger|customer/.test(source)) return 'Customer';
  if (/driver/.test(source)) return 'Driver';
  if (/admin|staff|support|operator/.test(source)) return 'Admin';
  if (/system|cron|auto/.test(source)) return 'System';

  const status = clean(trip.status).toLowerCase();
  if (status === 'customer_cancelled') return 'Customer';

  const text = clean(trip.special_instructions).toLowerCase();
  if (text.includes('admin cancel') || text.includes('cancelled by admin')) return 'Admin';
  if (text.includes('driver cancel')) return 'Driver';
  if (text.includes('passenger cancel') || text.includes('customer cancel')) return 'Customer';
  if (text.includes('no drivers available')) return 'System';
  return null;
}

/** The recorded reason text, without the actor prefix. */
export function resolveCancellationReasonText(trip: TripCancellationReasonInput): string {
  const actor = resolveCancellationActor(trip);
  const candidates = [
    trip.cancellation_reason,
    trip.cancellation_note,
    trip.cancel_reason,
  ];
  for (const candidate of candidates) {
    const value = humaniseCancellationReason(candidate);
    if (!value) continue;
    // Strip actor-echo codes that carry no customer intent.
    if (/^cancelled by (admin|customer|driver|rider|passenger|system)$/i.test(value)) continue;
    return value;
  }

  const instructions = clean(trip.special_instructions);
  if (instructions) {
    const afterColon = instructions.includes(':')
      ? instructions.slice(instructions.indexOf(':') + 1).trim()
      : instructions;
    const value = humaniseCancellationReason(afterColon);
    if (value && !/^cancelled by (admin|customer|driver|rider|passenger|system)\.?$/i.test(value)) {
      return value;
    }
  }

  const status = clean(trip.status).toLowerCase();
  if (status === 'expired') return 'Expired without acceptance';
  if (status === 'missed') return 'No driver accepted';
  return actor ? 'No reason recorded' : 'Not recorded';
}

/** Full display label, e.g. "Customer — Found another ride". */
export function formatCancellationReason(trip: TripCancellationReasonInput): string {
  const actor = resolveCancellationActor(trip);
  const reason = resolveCancellationReasonText(trip);
  if (actor && reason) return `${actor} — ${reason}`;
  if (actor) return `Cancelled by ${actor}`;
  return reason || 'Not recorded';
}
