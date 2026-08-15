/**
 * Raise the existing Revolut hold to cover a negotiated payable before
 * commit_negotiation_fare / accept_ride_offer. Same-order increment only.
 * Never creates a second provider order. Never weakens assert_payment_gate.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { prepareRevolutModificationAuthorisation } from "./revolutModTopUp.ts";
import {
  isCardLikePaymentMethod,
  isPaymentGateAcceptFailure,
  mapNegotiationCoverFailure,
  NEGOTIATION_PAYABLE_INSUFFICIENT_CODE,
  NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE,
  NEGOTIATION_PERSIST_FAILED_CODE,
  NEGOTIATION_PERSIST_FAILED_MESSAGE,
  NEGOTIATION_RECONCILIATION_PENDING_CODE,
  NEGOTIATION_RECONCILIATION_PENDING_MESSAGE,
} from "./negotiationPayableAuthorisationMap.ts";

export {
  isCardLikePaymentMethod,
  isPaymentGateAcceptFailure,
  mapNegotiationCoverFailure,
  NEGOTIATION_PAYABLE_INSUFFICIENT_CODE,
  NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE,
};

export type NegotiationPayableCoverResult =
  | {
    ok: true;
    authorisedPence: number;
    incrementUsed: boolean;
    skipped: boolean;
  }
  | {
    ok: false;
    code: string;
    message: string;
    status: number;
  };

async function persistAuthorisedCover(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    paymentSessionId: string | null;
    authorisedPence: number;
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const authorised = Math.max(0, Math.round(Number(args.authorisedPence)));
  if (authorised <= 0) {
    return { ok: false, message: "Authorised cover amount was not positive" };
  }
  const now = new Date().toISOString();
  const { error: tripErr } = await supabase
    .from("trips")
    .update({
      authorised_amount_pence: authorised,
      authorized_amount_pence: authorised,
      total_authorized_amount_pence: authorised,
      payment_coverage_status: "authorized",
      updated_at: now,
    })
    .eq("id", args.tripId);
  if (tripErr) {
    return { ok: false, message: tripErr.message };
  }
  if (args.paymentSessionId) {
    const { error: sessErr } = await supabase
      .from("payment_sessions")
      .update({
        total_authorised_amount_pence: authorised,
        updated_at: now,
      })
      .eq("id", args.paymentSessionId);
    if (sessErr) {
      return { ok: false, message: sessErr.message };
    }
  }
  return { ok: true };
}

/**
 * Ensure authorised hold >= requiredFarePence before any fare/assignment mutation.
 * Cash / non-card methods skip (assert_payment_gate also skips them).
 */
export async function ensureNegotiationPayableAuthorised(args: {
  supabase: SupabaseClient;
  tripId: string;
  requiredFarePence: number;
  owner: string;
}): Promise<NegotiationPayableCoverResult> {
  const required = Math.max(0, Math.round(Number(args.requiredFarePence)));
  if (required <= 0) {
    return {
      ok: false,
      code: NEGOTIATION_PAYABLE_INSUFFICIENT_CODE,
      message: NEGOTIATION_PAYABLE_INSUFFICIENT_MESSAGE,
      status: 409,
    };
  }

  const { data: trip, error: tripErr } = await args.supabase
    .from("trips")
    .select(
      "id, payment_method, payment_session_id, provider_order_id, payment_provider, "
        + "currency_code, authorised_amount_pence, authorized_amount_pence, "
        + "total_authorized_amount_pence",
    )
    .eq("id", args.tripId)
    .maybeSingle();

  if (tripErr || !trip) {
    return {
      ok: false,
      code: NEGOTIATION_RECONCILIATION_PENDING_CODE,
      message: NEGOTIATION_RECONCILIATION_PENDING_MESSAGE,
      status: 409,
    };
  }

  if (!isCardLikePaymentMethod(trip.payment_method as string | null)) {
    return {
      ok: true,
      authorisedPence: required,
      incrementUsed: false,
      skipped: true,
    };
  }

  const result = await prepareRevolutModificationAuthorisation({
    supabase: args.supabase,
    trip: trip as Record<string, unknown>,
    paymentSessionId: (trip.payment_session_id as string | null) ?? null,
    targetAuthorisedAmountPence: required,
    updatedEstimatedTotalPence: required,
    allowControlledFallback: false,
    fareRevisionNumber: required,
  });

  if (!result.ok) {
    console.error("[negotiation-payable] increment_failed", {
      trip_id: args.tripId,
      required_pence: required,
      owner: args.owner,
      error_code: result.error_code ?? null,
      error: result.error,
    });
    return { ok: false, ...mapNegotiationCoverFailure(result) };
  }

  if (!result.sufficient) {
    console.error("[negotiation-payable] increment_requires_customer_action", {
      trip_id: args.tripId,
      required_pence: required,
      owner: args.owner,
    });
    return {
      ok: false,
      ...mapNegotiationCoverFailure({
        errorCode: result.error_code,
        error: "requires_revolut_checkout",
        status: 402,
      }),
    };
  }

  const coverWrite = await persistAuthorisedCover(args.supabase, {
    tripId: args.tripId,
    paymentSessionId: (trip.payment_session_id as string | null) ?? null,
    authorisedPence: result.authorised_amount_pence,
  });
  if (!coverWrite.ok) {
    return {
      ok: false,
      code: NEGOTIATION_PERSIST_FAILED_CODE,
      message: NEGOTIATION_PERSIST_FAILED_MESSAGE,
      status: 500,
    };
  }

  console.log("[negotiation-payable] cover_ok", {
    trip_id: args.tripId,
    required_pence: required,
    authorised_pence: result.authorised_amount_pence,
    increment_used: result.increment_used === true,
    owner: args.owner,
  });

  return {
    ok: true,
    authorisedPence: result.authorised_amount_pence,
    incrementUsed: result.increment_used === true,
    skipped: false,
  };
}
