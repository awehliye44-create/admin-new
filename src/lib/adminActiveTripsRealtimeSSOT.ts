/**
 * A-2 — pure Active Trips Realtime apply decisions (testable).
 * Never invents terminal cancel; only reflects provider/DB payload status.
 */
import { isActiveTripDbStatus } from '@/lib/activeTripStatuses';

export type AdminTripsRealtimePayload = {
  eventType?: string;
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
};

export type AdminTripsRealtimeDecision =
  | { kind: 'noop_refresh' }
  | { kind: 'remove'; tripId: string }
  | { kind: 'patch'; tripId: string; fields: Record<string, unknown> }
  | { kind: 'full_refresh' };

/**
 * Decide how to apply a trips postgres_changes payload to the local board.
 * - Terminal / non-active status → remove (authoritative row left active set).
 * - UPDATE of a known row → patch listed fields only.
 * - UPDATE/INSERT of unknown active row → full refresh (never invent a row from a thin payload).
 * - Missing id → full refresh.
 */
export function decideAdminTripsRealtimeApply(
  payload: AdminTripsRealtimePayload,
  knownTripIds: ReadonlySet<string>,
): AdminTripsRealtimeDecision {
  const eventType = String(payload.eventType || '').toUpperCase();
  const next = payload.new ?? null;
  const prev = payload.old ?? null;
  const tripId = String(next?.id ?? prev?.id ?? '');
  if (!tripId) return { kind: 'full_refresh' };

  if (eventType === 'DELETE') {
    return { kind: 'remove', tripId };
  }

  const status = typeof next?.status === 'string' ? next.status : null;
  if (status != null && !isActiveTripDbStatus(status)) {
    return { kind: 'remove', tripId };
  }

  if (eventType === 'UPDATE' && next && knownTripIds.has(tripId)) {
    const fields: Record<string, unknown> = {};
    if (typeof next.status === 'string') fields.status = next.status;
    if (typeof next.passenger_name === 'string') {
      fields.passenger_name = next.passenger_name;
    }
    if (typeof next.pickup_address === 'string') {
      fields.pickup_address = next.pickup_address;
    }
    if (typeof next.dropoff_address === 'string') {
      fields.dropoff_address = next.dropoff_address;
    }
    if (typeof next.driver_id === 'string' || next.driver_id === null) {
      fields.driver_id = next.driver_id;
    }
    if (typeof next.modification_status === 'string') {
      fields.modification_status = next.modification_status;
    }
    return { kind: 'patch', tripId, fields };
  }

  // Unknown active row, INSERT, or thin/out-of-order payload → authoritative refetch.
  return { kind: 'full_refresh' };
}

/**
 * A-1 — Edge cancel body must explicitly confirm success before Admin board mutation.
 * Ambiguous / missing success is rejection (fail closed for authoritative UI).
 */
export function isAdminCancelEdgeConfirmed(body: unknown): {
  confirmed: boolean;
  errorMessage?: string;
} {
  if (body == null || typeof body !== 'object') {
    return {
      confirmed: false,
      errorMessage: 'Cancellation was not confirmed by the server.',
    };
  }
  const b = body as {
    success?: boolean;
    error?: string;
    message?: string;
    result?: { success?: boolean; error?: string };
  };
  if (b.success === false || b.error) {
    return {
      confirmed: false,
      errorMessage: b.error || b.result?.error || b.message || 'Failed to cancel trip',
    };
  }
  if (b.result && b.result.success === false) {
    return {
      confirmed: false,
      errorMessage: b.result.error || 'Failed to cancel trip',
    };
  }
  if (b.success !== true) {
    return {
      confirmed: false,
      errorMessage: 'Cancellation was not confirmed by the server.',
    };
  }
  return { confirmed: true };
}
