/**
 * Customer refund confirmation — push + email + SMS.
 *
 * Called only after a provider-confirmed refund is recorded (applyProviderRefund /
 * confirmed payment_session_refunds upsert). Never from hold release or pending/
 * failed refund paths. Failures never reverse the refund.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { sendResendEmail } from "./resendMail.ts";
import {
  buildCustomerRefundNotifyCopy,
  REFUND_NOTIFY_CHANNELS,
  shouldNotifyCustomerRefund,
  type RefundNotifyChannel,
} from "./customerRefundNotifySSOT.ts";
import { sendTwilioSms } from "./twilioSms.ts";

export type NotifyCustomerRefundArgs = {
  tripId: string;
  providerRefundId: string;
  amountPence: number;
  paymentSessionId?: string | null;
  refundStatus?: string | null;
  /** Extra body lines already handled via trip code in SSOT. */
  source?: string;
};

type ClaimResult =
  | { ok: true; deliveryId: string; mode: "new" | "retry" }
  | { ok: false; reason: "already_done" | "claim_failed"; status?: string };

async function claimChannel(
  supabase: SupabaseClient,
  args: {
    providerRefundId: string;
    channel: RefundNotifyChannel;
    tripId: string;
    paymentSessionId: string | null;
    amountPence: number;
  },
): Promise<ClaimResult> {
  const now = new Date().toISOString();
  const { data: inserted, error: insertErr } = await supabase
    .from("customer_refund_notification_deliveries")
    .insert({
      provider_refund_id: args.providerRefundId,
      channel: args.channel,
      trip_id: args.tripId,
      payment_session_id: args.paymentSessionId,
      amount_pence: args.amountPence,
      status: "sending",
      updated_at: now,
    })
    .select("id")
    .maybeSingle();

  if (!insertErr && inserted?.id) {
    return { ok: true, deliveryId: String(inserted.id), mode: "new" };
  }

  const { data: existing } = await supabase
    .from("customer_refund_notification_deliveries")
    .select("id, status")
    .eq("provider_refund_id", args.providerRefundId)
    .eq("channel", args.channel)
    .maybeSingle();

  if (!existing?.id) {
    return { ok: false, reason: "claim_failed" };
  }
  const status = String(existing.status ?? "");
  if (status === "sent" || status === "skipped" || status === "sending") {
    return { ok: false, reason: "already_done", status };
  }
  if (status !== "failed") {
    return { ok: false, reason: "already_done", status };
  }

  const { data: retried, error: retryErr } = await supabase
    .from("customer_refund_notification_deliveries")
    .update({
      status: "sending",
      error_message: null,
      skipped_reason: null,
      updated_at: now,
    })
    .eq("id", existing.id)
    .eq("status", "failed")
    .select("id")
    .maybeSingle();

  if (retryErr || !retried?.id) {
    return { ok: false, reason: "already_done", status: "failed" };
  }
  return { ok: true, deliveryId: String(retried.id), mode: "retry" };
}

async function markDelivery(
  supabase: SupabaseClient,
  deliveryId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await supabase
    .from("customer_refund_notification_deliveries")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", deliveryId);
}

async function sendPush(args: {
  supabase: SupabaseClient;
  customerUserId: string;
  tripId: string;
  title: string;
  body: string;
  providerRefundId: string;
}): Promise<{ ok: true; messageId?: string } | { ok: false; error: string } | { skipped: true; reason: string }> {
  try {
    // Same invoke path as create-ride / scheduled-dispatch (service client).
    const { data, error } = await args.supabase.functions.invoke("send-customer-notification", {
      body: {
        customer_id: args.customerUserId,
        title: args.title,
        body: args.body,
        type: "payment_success",
        data: {
          type: "payment_success",
          trip_id: args.tripId,
          provider_refund_id: args.providerRefundId,
          path: "/account/rides",
        },
      },
    });
    if (error) {
      const msg = String((error as { message?: string }).message ?? error).slice(0, 200);
      // No device token is a skip, not a hard failure.
      if (/NO_TOKENS|No push tokens/i.test(msg)) {
        return { skipped: true, reason: "no_push_token" };
      }
      return { ok: false, error: `push_invoke:${msg}` };
    }
    const parsed = (data ?? {}) as Record<string, unknown>;
    if (parsed.error && String(parsed.error).toUpperCase() === "NO_TOKENS") {
      return { skipped: true, reason: "no_push_token" };
    }
    if (parsed.success === false && parsed.error) {
      return { ok: false, error: `push_${String(parsed.error).slice(0, 160)}` };
    }
    const sent = Number(parsed.sent ?? parsed.successCount ?? 0);
    if (!Number.isFinite(sent) || sent <= 0) {
      return { skipped: true, reason: "no_push_token" };
    }
    return { ok: true, messageId: typeof parsed.message_id === "string" ? parsed.message_id : undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function sendEmail(args: {
  email: string;
  subject: string;
  body: string;
}): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#111;line-height:1.5">
  <p style="font-size:18px;font-weight:600;margin:0 0 12px">ONECAB</p>
  <p style="white-space:pre-wrap;margin:0">${args.body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>")}</p>
</body></html>`;
  const result = await sendResendEmail({
    to: args.email,
    subject: args.subject,
    html,
    text: args.body,
    tag: "customer_refund_confirmation",
  });
  if (!result.ok) {
    return { ok: false, error: result.message ?? "email_send_failed" };
  }
  return { ok: true, messageId: result.id ?? undefined };
}

/** Twilio Messaging SMS. MSG91 is call-masking only — never use it for refund SMS. */
async function sendSms(args: {
  phoneE164: string;
  body: string;
}): Promise<
  | { ok: true; messageId?: string }
  | { ok: false; error: string }
  | { skipped: true; reason: string }
> {
  return await sendTwilioSms(args);
}

/**
 * Fire-and-forget safe: errors are recorded per channel and never thrown to
 * reverse a confirmed refund.
 */
export async function notifyCustomerConfirmedRefund(
  supabase: SupabaseClient,
  args: NotifyCustomerRefundArgs,
): Promise<{ channels: Record<RefundNotifyChannel, string> }> {
  const results: Record<RefundNotifyChannel, string> = {
    push: "not_attempted",
    email: "not_attempted",
    sms: "not_attempted",
  };

  if (!shouldNotifyCustomerRefund({
    providerRefundId: args.providerRefundId,
    amountPence: args.amountPence,
    refundStatus: args.refundStatus ?? "confirmed",
    isHoldRelease: false,
  })) {
    return { channels: { push: "ineligible", email: "ineligible", sms: "ineligible" } };
  }

  const providerRefundId = String(args.providerRefundId).trim();
  const amountPence = Math.round(Number(args.amountPence));

  const { data: trip } = await supabase
    .from("trips")
    .select("id, trip_code, trip_number, passenger_id, passenger_phone")
    .eq("id", args.tripId)
    .maybeSingle();

  if (!trip?.passenger_id) {
    console.warn("[customerRefundNotify] missing passenger — all channels skipped", {
      trip_id: args.tripId,
      provider_refund_id: providerRefundId,
    });
    return { channels: { push: "skipped_no_passenger", email: "skipped_no_passenger", sms: "skipped_no_passenger" } };
  }

  // customers has no email column — auth.users is the email SSOT (same as tripInvoice).
  const { data: customer } = await supabase
    .from("customers")
    .select("id, user_id, phone")
    .eq("id", trip.passenger_id)
    .maybeSingle();

  const authUserId = String(customer?.user_id ?? "").trim();
  let email = "";
  if (authUserId) {
    try {
      const { data: authUser, error: authErr } = await supabase.auth.admin.getUserById(authUserId);
      if (!authErr) {
        email = String(authUser?.user?.email ?? "").trim();
      }
    } catch (authLookupErr) {
      console.warn("[customerRefundNotify] auth email lookup failed", {
        trip_id: args.tripId,
        user_id: authUserId,
        error: authLookupErr instanceof Error ? authLookupErr.message : String(authLookupErr),
      });
    }
  }
  const phone = String(customer?.phone ?? trip.passenger_phone ?? "").trim();

  const bookingReference = String(trip.trip_code ?? trip.trip_number ?? args.tripId).trim();
  const copy = buildCustomerRefundNotifyCopy({
    amountPence,
    bookingReference,
    tripCode: trip.trip_code ?? trip.trip_number,
  });

  for (const channel of REFUND_NOTIFY_CHANNELS) {
    const claim = await claimChannel(supabase, {
      providerRefundId,
      channel,
      tripId: args.tripId,
      paymentSessionId: args.paymentSessionId ?? null,
      amountPence,
    });
    if (!claim.ok) {
      results[channel] = claim.status === "sent"
        ? "already_sent"
        : claim.status === "skipped"
        ? "already_skipped"
        : "already_claimed";
      continue;
    }

    try {
      if (channel === "push") {
        if (!authUserId) {
          await markDelivery(supabase, claim.deliveryId, {
            status: "skipped",
            skipped_reason: "missing_user_id",
          });
          results[channel] = "skipped_missing_user";
          continue;
        }
        const pushResult = await sendPush({
          supabase,
          customerUserId: authUserId,
          tripId: args.tripId,
          title: copy.title,
          body: copy.body,
          providerRefundId,
        });
        if ("skipped" in pushResult && pushResult.skipped) {
          await markDelivery(supabase, claim.deliveryId, {
            status: "skipped",
            skipped_reason: pushResult.reason,
          });
          results[channel] = `skipped_${pushResult.reason}`;
        } else if ("ok" in pushResult && pushResult.ok) {
          await markDelivery(supabase, claim.deliveryId, {
            status: "sent",
            provider_message_id: pushResult.messageId ?? null,
          });
          results[channel] = "sent";
        } else {
          await markDelivery(supabase, claim.deliveryId, {
            status: "failed",
            error_message: "ok" in pushResult && !pushResult.ok ? pushResult.error : "push_failed",
          });
          results[channel] = "failed";
        }
      } else if (channel === "email") {
        if (!email || !email.includes("@")) {
          await markDelivery(supabase, claim.deliveryId, {
            status: "skipped",
            skipped_reason: "missing_email",
          });
          results[channel] = "skipped_missing_email";
          continue;
        }
        const emailResult = await sendEmail({
          email,
          subject: copy.subject,
          body: copy.body,
        });
        if (emailResult.ok) {
          await markDelivery(supabase, claim.deliveryId, {
            status: "sent",
            provider_message_id: emailResult.messageId ?? null,
          });
          results[channel] = "sent";
        } else {
          await markDelivery(supabase, claim.deliveryId, {
            status: "failed",
            error_message: emailResult.error,
          });
          results[channel] = "failed";
        }
      } else if (channel === "sms") {
        if (!phone) {
          await markDelivery(supabase, claim.deliveryId, {
            status: "skipped",
            skipped_reason: "missing_phone",
          });
          results[channel] = "skipped_missing_phone";
          continue;
        }
        const smsResult = await sendSms({ phoneE164: phone, body: copy.body });
        if ("skipped" in smsResult && smsResult.skipped) {
          await markDelivery(supabase, claim.deliveryId, {
            status: "skipped",
            skipped_reason: smsResult.reason,
          });
          results[channel] = `skipped_${smsResult.reason}`;
        } else if ("ok" in smsResult && smsResult.ok) {
          await markDelivery(supabase, claim.deliveryId, {
            status: "sent",
            provider_message_id: smsResult.messageId ?? null,
          });
          results[channel] = "sent";
        } else {
          await markDelivery(supabase, claim.deliveryId, {
            status: "failed",
            error_message: "ok" in smsResult && !smsResult.ok ? smsResult.error : "sms_failed",
          });
          results[channel] = "failed";
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markDelivery(supabase, claim.deliveryId, {
        status: "failed",
        error_message: message.slice(0, 400),
      });
      results[channel] = "failed";
      console.error("[customerRefundNotify] channel failed (refund unchanged)", {
        channel,
        provider_refund_id: providerRefundId,
        trip_id: args.tripId,
        error: message,
      });
    }
  }

  console.log("[customerRefundNotify] complete", {
    trip_id: args.tripId,
    provider_refund_id: providerRefundId,
    amount_pence: amountPence,
    channels: results,
    source: args.source ?? null,
  });

  return { channels: results };
}
