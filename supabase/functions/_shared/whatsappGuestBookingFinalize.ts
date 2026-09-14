/**
 * Authorised WhatsApp guest session → create-trip-after-payment.
 * bookingPostCommit sets searching_expires_at and invokes auto-dispatch once.
 * Does not call finalize_paid_booking_session or a second dispatcher.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { finalizeBookingAfterPaymentFromSession } from "./paymentSessionSSOT.ts";
import {
  ensureWhatsAppSnapshotReadyForTripCreate,
  isWhatsAppGuestBookingSession,
} from "./whatsappGuestBookingSSOT.ts";
import { bindWhatsAppConversationToCreatedTrip } from "./whatsappTripLifecycleMessages.ts";

export type WhatsAppGuestFinalizeResult = {
  handled: boolean;
  ok: boolean;
  tripId?: string;
  error?: string;
  dispatched?: boolean;
};

export async function finalizeWhatsAppGuestBookingFromSession(
  supabase: SupabaseClient,
  session: Record<string, unknown>,
  args: {
    providerOrderId: string;
    supabaseUrl: string;
    serviceRoleKey: string;
  },
): Promise<WhatsAppGuestFinalizeResult> {
  if (!isWhatsAppGuestBookingSession(session)) {
    return { handled: false, ok: false };
  }

  const providerOrderId = args.providerOrderId.trim();
  const snapshot = ensureWhatsAppSnapshotReadyForTripCreate(
    (session.booking_snapshot && typeof session.booking_snapshot === "object"
      ? session.booking_snapshot
      : {}) as Record<string, unknown>,
    providerOrderId,
  );

  if (session.id) {
    const { error: snapErr } = await supabase
      .from("payment_sessions")
      .update({
        booking_snapshot: snapshot,
        updated_at: new Date().toISOString(),
      })
      .eq("id", String(session.id));
    if (snapErr) {
      return { handled: true, ok: false, error: snapErr.message };
    }
  }

  const finalized = await finalizeBookingAfterPaymentFromSession(supabase, {
    providerOrderId,
    clientActionId: (session.client_action_id as string | null) ?? null,
    supabaseUrl: args.supabaseUrl,
    serviceRoleKey: args.serviceRoleKey,
  });

  if (!finalized.tripId) {
    return {
      handled: true,
      ok: false,
      error: finalized.error ?? "trip_not_created",
    };
  }

  const waId = typeof snapshot.wa_id === "string" ? snapshot.wa_id : "";
  if (waId) {
    await bindWhatsAppConversationToCreatedTrip(supabase, waId, finalized.tripId);
  }

  return {
    handled: true,
    ok: true,
    tripId: finalized.tripId,
  };
}
