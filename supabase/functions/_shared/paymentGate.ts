// P0 Payment Gate — independent re-check used by dispatch/broadcast/apply-offer/accept-trip.
// Calls the SECURITY DEFINER function public.assert_payment_gate(trip_id) which raises
// PAYMENT_GATE_NOT_SATISFIED when the trip's payment_sessions row is not authoritative
// (not AUTHORISED/COMPLETED, wrong currency, zero authorised amount, cancelled/failed/etc).
//
// Callers should await assertPaymentGate(supabase, trip_id) BEFORE doing any dispatch,
// broadcast, offer-apply or driver-assign write. On failure, return
// errorResponse('PAYMENT_GATE_NOT_SATISFIED', 409, { detail }, 'PAYMENT_GATE_NOT_SATISFIED').

// deno-lint-ignore no-explicit-any
export async function assertPaymentGate(supabase: any, tripId: string): Promise<void> {
  const { error } = await supabase.rpc("assert_payment_gate", { p_trip_id: tripId });
  if (error) {
    const msg = String(error.message || "");
    if (msg.includes("PAYMENT_GATE_NOT_SATISFIED")) {
      throw new PaymentGateError(msg);
    }
    throw error;
  }
}

export class PaymentGateError extends Error {
  code = "PAYMENT_GATE_NOT_SATISFIED";
  constructor(detail: string) {
    super(detail);
    this.name = "PaymentGateError";
  }
}
