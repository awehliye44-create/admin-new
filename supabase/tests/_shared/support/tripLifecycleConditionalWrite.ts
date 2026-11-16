/**
 * Conditional (CAS-style) trip status writes for stop-workflow lifecycle actions.
 *
 * Soft idempotency (read-then-return) is not enough under concurrency: two Completes
 * can both observe status !== completed and both run money / total_trips.
 * The first successful claim wins; losers must treat the write as already applied.
 */

export type TripWriteClient = {
  // deno-lint-ignore no-explicit-any
  from: (table: string) => any;
};

export type TripLifecycleClaimPredicates = {
  /** Require status to be one of these (lowercase-normalized comparison is caller's job). */
  statusIn?: string[];
  /** Require status not equal to this value (e.g. completed). */
  statusNeq?: string;
  arrivedAtIsNull?: boolean;
  startedAtIsNull?: boolean;
  completedAtIsNull?: boolean;
};

export type TripLifecycleClaimResult =
  | { ok: true; claimed: true; id: string }
  | { ok: true; claimed: false }
  | { ok: false; error: { message: string; code?: string } };

/**
 * Update a trip only when CAS predicates match. Returns claimed=false when zero rows match
 * (lost race or already applied) — callers must not repeat money or counters.
 */
export async function claimTripLifecycleWrite(
  supabase: TripWriteClient,
  tripId: string,
  payload: Record<string, unknown>,
  predicates: TripLifecycleClaimPredicates,
): Promise<TripLifecycleClaimResult> {
  const full = { ...payload };
  if (!full.updated_at) full.updated_at = new Date().toISOString();

  // deno-lint-ignore no-explicit-any
  let q: any = supabase.from("trips").update(full).eq("id", tripId);

  if (predicates.statusIn && predicates.statusIn.length > 0) {
    q = q.in("status", predicates.statusIn);
  }
  if (predicates.statusNeq) {
    q = q.neq("status", predicates.statusNeq);
  }
  if (predicates.arrivedAtIsNull) {
    q = q.is("arrived_at", null);
  }
  if (predicates.startedAtIsNull) {
    q = q.is("started_at", null);
  }
  if (predicates.completedAtIsNull) {
    q = q.is("completed_at", null);
  }

  const { data, error } = await q.select("id").maybeSingle();
  if (error) return { ok: false, error };
  if (!data?.id) return { ok: true, claimed: false };
  return { ok: true, claimed: true, id: String(data.id) };
}

/** Complete Trip: only the first writer may flip to completed and continue settlement. */
export function completeTripClaimPredicates(): TripLifecycleClaimPredicates {
  return { statusNeq: "completed", completedAtIsNull: true };
}

/** Arrive at pickup: only stamp arrived_at once. */
export function arrivePickupClaimPredicates(): TripLifecycleClaimPredicates {
  return { arrivedAtIsNull: true, startedAtIsNull: true, completedAtIsNull: true };
}

/** Start Trip: only stamp started_at once. */
export function startTripClaimPredicates(): TripLifecycleClaimPredicates {
  return { startedAtIsNull: true, completedAtIsNull: true };
}

export type StopLifecycleClaimPredicates = {
  arrivedAtIsNull?: boolean;
  statusNeq?: string;
};

/**
 * Conditional trip_stops write. Used for Arrive at Stop / Drive to Next so duplicate
 * taps cannot re-finalize waiting or advance twice under concurrency.
 */
export async function claimStopLifecycleWrite(
  supabase: TripWriteClient,
  stopId: string,
  payload: Record<string, unknown>,
  predicates: StopLifecycleClaimPredicates,
): Promise<TripLifecycleClaimResult> {
  const full = { ...payload };
  if (!full.updated_at) full.updated_at = new Date().toISOString();

  // deno-lint-ignore no-explicit-any
  let q: any = supabase.from("trip_stops").update(full).eq("id", stopId);
  if (predicates.arrivedAtIsNull) {
    q = q.is("arrived_at", null);
  }
  if (predicates.statusNeq) {
    q = q.neq("status", predicates.statusNeq);
  }

  const { data, error } = await q.select("id").maybeSingle();
  if (error) return { ok: false, error };
  if (!data?.id) return { ok: true, claimed: false };
  return { ok: true, claimed: true, id: String(data.id) };
}
