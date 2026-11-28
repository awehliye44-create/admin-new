/** Admin presentation-only helpers; not part of Edge uploads. */
import { CAPTURED_PAYMENT_STATUSES } from "../../supabase/functions/_shared/liveTripFareSSOT.ts";


/** True when trip is still live for fare preview (not yet captured/settled). */
export function isUncapturedActivePaymentStatus(
  paymentStatus: string | null | undefined,
): boolean {
  const s = (paymentStatus ?? "").trim().toLowerCase();
  if (!s) return true;
  return !CAPTURED_PAYMENT_STATUSES.has(s);
}
