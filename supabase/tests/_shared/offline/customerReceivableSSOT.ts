/** Offline test/audit-only helpers; not part of Edge uploads. */
import { PartialCaptureAllocationLine, nonNegPence, positivePence } from "../../../functions/_shared/customerReceivableSSOT.ts";


/**
 * Partial capture allocation order:
 * historical receivables first (created_at ASC), then current trip fare.
 * Example: reserved debt 36, captured 20 → settle 20 of receivables,
 * leave 16 OPEN, trip fare gets 0.
 */
export function planPartialCaptureAllocation(args: {
  reserved_receivables: Array<{
    receivable_id: string;
    allocated_amount_pence: number;
    created_at?: string;
  }>;
  captured_pence: number;
  current_trip_fare_pence?: number | null;
}): {
  receivable_lines: PartialCaptureAllocationLine[];
  debt_settled_pence: number;
  debt_remaining_pence: number;
  current_trip_fare_allocation_pence: number;
} {
  const captured = nonNegPence(args.captured_pence);
  let remaining = captured;
  const sorted = (args.reserved_receivables ?? [])
    .slice()
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));

  const receivable_lines: PartialCaptureAllocationLine[] = [];
  for (const r of sorted) {
    const alloc = positivePence(r.allocated_amount_pence);
    const settle = Math.min(alloc, remaining);
    remaining -= settle;
    receivable_lines.push({
      receivable_id: r.receivable_id,
      allocated_amount_pence: alloc,
      settle_pence: settle,
      remaining_outstanding_pence: alloc - settle,
      next_status: alloc - settle === 0 ? "SETTLED" : "OPEN",
    });
  }
  const debt_settled_pence = receivable_lines.reduce((s, l) => s + l.settle_pence, 0);
  const debt_remaining_pence = receivable_lines.reduce(
    (s, l) => s + l.remaining_outstanding_pence,
    0,
  );
  const fareDue = nonNegPence(args.current_trip_fare_pence);
  const current_trip_fare_allocation_pence = Math.min(fareDue, remaining);
  return {
    receivable_lines,
    debt_settled_pence,
    debt_remaining_pence,
    current_trip_fare_allocation_pence,
  };
}

export * from "../../../functions/_shared/customerReceivableSSOT.ts";
