import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { canAutoSendCustomerInvoice } from "./tripInvoiceEligibility.ts";
import { hasAutoCustomerReceiptBeenSent } from "./invoiceEmailOutbox.ts";
import { resolveCustomerUserId } from "./tripInvoiceData.ts";

const AUTO_INVOICE_TRIP_SELECT =
  "id, passenger_id, status, completed_at, financial_outcome, payment_method, payment_status, stripe_payment_intent_id, tip_window_closed_at, tip_window_expires_at, invoice_email_sent";

export async function invokeTripInvoiceProcess(
  supabaseUrl: string,
  serviceKey: string,
  tripId: string,
  action: "auto" | "regenerate" | "resend" | "generate_only" = "auto",
): Promise<void> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/trip-invoice-process`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ trip_id: tripId, action }),
    });
    const text = await res.text();
    const logPayload = {
      trip_id: tripId,
      action,
      status: res.status,
      body: text.slice(0, 500),
    };
    if (!res.ok) {
      console.error("[TRIP_INVOICE] invoke_failed", JSON.stringify(logPayload));
    } else {
      console.log("[TRIP_INVOICE]", JSON.stringify(logPayload));
    }
  } catch (err) {
    console.error("[TRIP_INVOICE] invoke failed", {
      trip_id: tripId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Hard-gated auto invoice — only after completed trip, closed tip window, final payment, and not yet sent.
 */
export async function maybeInvokeAutoTripInvoice(
  supabase: SupabaseClient,
  supabaseUrl: string,
  serviceKey: string,
  tripId: string,
  source: string,
): Promise<void> {
  if (!supabaseUrl || !serviceKey) return;

  const { data: trip, error } = await supabase
    .from("trips")
    .select(AUTO_INVOICE_TRIP_SELECT)
    .eq("id", tripId)
    .maybeSingle();

  if (error || !trip) {
    console.warn("[TRIP_INVOICE] auto_send_lookup_failed", {
      trip_id: tripId,
      source,
      error: error?.message ?? "trip_not_found",
    });
    return;
  }

  const gate = canAutoSendCustomerInvoice(trip);
  if (!gate.ok) {
    console.log("[TRIP_INVOICE] auto_send_suppressed", {
      trip_id: tripId,
      source,
      reason: gate.reason,
      status: trip.status,
    });
    return;
  }

  const recipientUserId = await resolveCustomerUserId(
    supabase,
    (trip.passenger_id as string) ?? null,
  );
  if (recipientUserId && await hasAutoCustomerReceiptBeenSent(supabase, tripId, recipientUserId)) {
    console.log("[TRIP_INVOICE] auto_send_suppressed", {
      trip_id: tripId,
      source,
      reason: "outbox_already_sent",
    });
    return;
  }

  await invokeTripInvoiceProcess(supabaseUrl, serviceKey, tripId, "auto");
}
