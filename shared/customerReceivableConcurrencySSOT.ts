/**
 * Concurrency simulation lock — models pg_advisory_xact_lock +
 * SELECT … FOR UPDATE SKIP LOCKED so two concurrent reserves cannot
 * consume the same OPEN receivable.
 *
 * Runnable: deno test --allow-read shared/customerReceivableConcurrencyLock.deno.test.ts
 * Live SQL proof (do not apply casually): see
 * supabase/migrations/_draft_review_only/customer_receivable_concurrency_proof.sql
 */

export type SimulatedOpenReceivable = {
  id: string;
  customer_id: string;
  outstanding_amount_pence: number;
  status: "OPEN" | "RESERVED";
};

/**
 * Single-threaded model of two overlapping reserve transactions:
 * - both take the same customer advisory lock (serialized)
 * - first locks OPEN rows with SKIP LOCKED semantics
 * - second sees already-RESERVED / locked rows → zero new allocations
 */
export function simulateConcurrentReserves(args: {
  customer_id: string;
  open: SimulatedOpenReceivable[];
}): {
  first: { reserved_ids: string[]; total_pence: number };
  second: { reserved_ids: string[]; total_pence: number };
  final_status_by_id: Record<string, "OPEN" | "RESERVED">;
  overlap_ids: string[];
} {
  const pool = args.open
    .filter((r) => r.customer_id === args.customer_id && r.status === "OPEN")
    .map((r) => ({ ...r }));

  const lockHeld = new Set<string>();

  const runReserve = () => {
    const reserved_ids: string[] = [];
    let total_pence = 0;
    for (const row of pool) {
      if (row.status !== "OPEN") continue;
      if (lockHeld.has(row.id)) continue; // SKIP LOCKED
      lockHeld.add(row.id);
      row.status = "RESERVED";
      reserved_ids.push(row.id);
      total_pence += row.outstanding_amount_pence;
    }
    // Commit releases row locks but status stays RESERVED.
    for (const id of reserved_ids) lockHeld.delete(id);
    return { reserved_ids, total_pence };
  };

  // Advisory lock serializes: first completes before second starts.
  const first = runReserve();
  const second = runReserve();

  const overlap_ids = first.reserved_ids.filter((id) => second.reserved_ids.includes(id));
  const final_status_by_id: Record<string, "OPEN" | "RESERVED"> = {};
  for (const r of pool) final_status_by_id[r.id] = r.status;

  return { first, second, final_status_by_id, overlap_ids };
}

/** Interleaved attempt without advisory lock — shows the race the SQL prevents. */
export function simulateUnsafeInterleavedReserve(args: {
  open: SimulatedOpenReceivable[];
}): { a_ids: string[]; b_ids: string[]; overlap_ids: string[] } {
  const a: SimulatedOpenReceivable[] = args.open.map((r) => ({ ...r }));
  const b: SimulatedOpenReceivable[] = args.open.map((r) => ({ ...r }));
  // Both read OPEN before either writes.
  const aOpen = a.filter((r) => r.status === "OPEN").map((r) => r.id);
  const bOpen = b.filter((r) => r.status === "OPEN").map((r) => r.id);
  for (const id of aOpen) {
    const row = a.find((r) => r.id === id);
    if (row) row.status = "RESERVED";
  }
  for (const id of bOpen) {
    const row = b.find((r) => r.id === id);
    if (row) row.status = "RESERVED";
  }
  const overlap_ids = aOpen.filter((id) => bOpen.includes(id));
  return { a_ids: aOpen, b_ids: bOpen, overlap_ids };
}
