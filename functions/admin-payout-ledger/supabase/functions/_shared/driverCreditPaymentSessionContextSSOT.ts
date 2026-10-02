/**
 * Payment Session evidence for driver credit monitoring (read-only).
 * Prefer captured sessions when multiple rows exist for one trip.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export type DriverCreditPaymentSessionContext = {
  payment_session_id: string | null;
  provider_state: string | null;
  captured_pence: number | null;
  captured_at: string | null;
  released_pence: number | null;
  refunded_pence: number | null;
  purpose: string | null;
};

type PaymentSessionRow = {
  id?: string | null;
  trip_id?: string | null;
  purpose?: string | null;
  provider_state?: string | null;
  captured_amount_pence?: number | null;
  captured_at?: string | null;
  released_amount_pence?: number | null;
  refunded_amount_pence?: number | null;
};

/** Pure pick — highest confirmed capture wins; tie-breaker keeps first seen. */
export function pickPrimaryPaymentSessionForTrip(
  sessions: PaymentSessionRow[],
): PaymentSessionRow | null {
  if (sessions.length === 0) return null;
  let best: PaymentSessionRow | null = null;
  let bestCapture = -1;
  for (const session of sessions) {
    const capture = Math.max(0, Number(session.captured_amount_pence ?? 0));
    if (!best || capture > bestCapture) {
      best = session;
      bestCapture = capture;
    }
  }
  return best;
}

export function mapPaymentSessionToDriverCreditContext(
  session: PaymentSessionRow | null | undefined,
): DriverCreditPaymentSessionContext {
  if (!session) {
    return {
      payment_session_id: null,
      provider_state: null,
      captured_pence: null,
      captured_at: null,
      released_pence: null,
      refunded_pence: null,
      purpose: null,
    };
  }
  return {
    payment_session_id: session.id == null ? null : String(session.id),
    provider_state: session.provider_state == null ? null : String(session.provider_state),
    captured_pence: session.captured_amount_pence == null
      ? null
      : Number(session.captured_amount_pence),
    captured_at: session.captured_at == null ? null : String(session.captured_at),
    released_pence: session.released_amount_pence == null
      ? null
      : Number(session.released_amount_pence),
    refunded_pence: session.refunded_amount_pence == null
      ? null
      : Number(session.refunded_amount_pence),
    purpose: session.purpose == null ? null : String(session.purpose),
  };
}

export async function loadDriverCreditPaymentSessionContextByTripId(
  supabase: SupabaseClient,
  tripIds: string[],
): Promise<Map<string, DriverCreditPaymentSessionContext>> {
  const out = new Map<string, DriverCreditPaymentSessionContext>();
  if (tripIds.length === 0) return out;

  const { data: sessions, error } = await supabase
    .from("payment_sessions")
    .select(
      "id, trip_id, purpose, provider_state, captured_amount_pence, captured_at, released_amount_pence, refunded_amount_pence",
    )
    .in("trip_id", tripIds);

  if (error) {
    console.warn("[driver-credit] payment session context fetch skipped", error.message);
    return out;
  }

  const byTripId = new Map<string, PaymentSessionRow[]>();
  for (const row of sessions ?? []) {
    const tripId = row.trip_id == null ? null : String(row.trip_id);
    if (!tripId) continue;
    const list = byTripId.get(tripId) ?? [];
    list.push(row as PaymentSessionRow);
    byTripId.set(tripId, list);
  }

  for (const tripId of tripIds) {
    const primary = pickPrimaryPaymentSessionForTrip(byTripId.get(tripId) ?? []);
    out.set(tripId, mapPaymentSessionToDriverCreditContext(primary));
  }

  return out;
}
