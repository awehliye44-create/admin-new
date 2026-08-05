import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import {
  DRIVER_NEW_RIDE_OFFER_BODY,
  DRIVER_NEW_RIDE_OFFER_TITLE,
} from "../_shared/negotiationPushCopy.ts";

/** Approved iOS NRO alert sound — must match Driver Copy Bundle Resources. */
const RIDE_OFFER_IOS_ALERT_SOUND = "onecab_new_ride_offer.wav";

/** Android: delay between successive reminders in ms. */
const ANDROID_REMINDER_DELAY_SECONDS = 4;

/** iOS: interval between background heads-up re-alerts until expiry in seconds. */
const IOS_REMINDER_INTERVAL_SECONDS = 10;

interface ReminderJobPayload {
  reminder_index: number;
  platform_type?: string;
}

async function recordReminderPhase(
  supabase: ReturnType<typeof createClient>,
  input: {
    bookingId: string;
    driverId: string;
    offerId: string;
    phase:
      | "offer_reminder_scheduled"
      | "offer_reminder_sent"
      | "offer_reminder_skipped_reason"
      | "offer_reminder_cancelled";
    detail: Record<string, unknown>;
  },
) {
  const { error } = await supabase.rpc("record_booking_delivery", {
    p_booking_id: input.bookingId,
    p_phase: input.phase,
    p_driver_id: input.driverId,
    p_offer_id: input.offerId,
    p_source: "edge",
    p_detail: input.detail,
  });
  if (error) {
    console.warn("[ride-offer-reminders] record_booking_delivery failed:", input.phase, error);
  }
}

async function sendReminderPush(
  supabaseUrl: string,
  serviceKey: string,
  input: {
    driver_id: string;
    offer_id: string;
    trip_id: string;
    booking_id: string;
    expires_at: string;
    title: string;
    body: string;
    notifData: Record<string, string>;
    reminderIndex: number;
    targetPlatform: "ios" | "android";
    iosRealert?: boolean;
  },
): Promise<{ delivered: boolean; reason: string }> {
  const secondsLeft = Math.max(
    0,
    Math.floor((new Date(input.expires_at).getTime() - Date.now()) / 1000),
  );

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/send-driver-notification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        driverId: input.driver_id,
        type: "RIDE_OFFER_REMINDER",
        title: input.title,
        body: input.body,
        targetPlatform: input.targetPlatform,
        data: {
          ...input.notifData,
          type: "new_ride_offer_reminder",
          notificationType: "new_ride_offer_reminder",
          offer_notification_type: "new_ride_offer_reminder",
          offer_id: input.offer_id,
          offerId: input.offer_id,
          booking_id: input.booking_id,
          trip_id: input.trip_id,
          expires_at: input.expires_at,
          expirySeconds: String(secondsLeft),
          reminder_index: String(input.reminderIndex),
          is_reminder: "true",
          sound: RIDE_OFFER_IOS_ALERT_SOUND,
          ...(input.iosRealert ? { ios_realert: "true" } : {}),
        },
      }),
    });

    const responseJson = await resp.json().catch(() => null);
    const delivered =
      resp.ok &&
      !!responseJson &&
      typeof responseJson === "object" &&
      (responseJson as { success?: boolean }).success === true &&
      Number((responseJson as { sent?: number }).sent ?? 0) > 0;

    if (delivered) {
      return { delivered: true, reason: "sent" };
    }

    const reason =
      resp.status === 404
        ? "push_token_missing"
        : !resp.ok
          ? "send_failed"
          : Number((responseJson as { sent?: number })?.sent ?? 0) === 0
            ? "push_sent_no_devices"
            : "send_unsuccessful";
    return { delivered: false, reason };
  } catch (pushErr) {
    return { delivered: false, reason: "network_error" };
  }
}

async function validateOfferActionable(
  supabase: ReturnType<typeof createClient>,
  offerId: string,
  driverId: string,
  tripId: string,
  platform: "ios" | "android"
): Promise<{ valid: boolean; reason: string; expiresAt?: string; title?: string; body?: string; notifData?: Record<string, string> }> {
  // 1) Query database for offer status
  const { data: offer, error } = await supabase
    .from("ride_offers")
    .select("status, expires_at, is_stacked, broadcast_round, trips(status, confirmed_driver_id, driver_id, pickup_address)")
    .eq("id", offerId)
    .maybeSingle();

  if (error || !offer) {
    return { valid: false, reason: "offer_not_found" };
  }

  if (offer.status !== "pending") {
    return { valid: false, reason: `offer_status_is_${offer.status}` };
  }

  const now = new Date();
  if (offer.expires_at && new Date(offer.expires_at) <= now) {
    return { valid: false, reason: "offer_expired" };
  }

  const trip = offer.trips as any;
  if (!trip) {
    return { valid: false, reason: "trip_not_found" };
  }

  if (!["pending", "searching", "offered", "searching_new_driver"].includes(trip.status)) {
    return { valid: false, reason: `trip_status_is_${trip.status}` };
  }

  const assignedDriverId = trip.confirmed_driver_id ?? trip.driver_id;
  if (assignedDriverId && assignedDriverId !== driverId) {
    return { valid: false, reason: "assigned_to_another_driver" };
  }

  // Android: check if we've already received a notification ack or popup surfaced
  if (platform === "android") {
    const { data: logRows } = await supabase
      .from("booking_delivery_log")
      .select("phase")
      .eq("offer_id", offerId)
      .in("phase", ["booking_received", "app_received_push", "offer_popup_surfaced"])
      .limit(1);

    if (logRows && logRows.length > 0) {
      return { valid: false, reason: "suppressed_due_to_ack_or_render" };
    }
  }

  // Resolve notification content — approved killed-state OS copy (no fare / address).
  const title = DRIVER_NEW_RIDE_OFFER_TITLE;
  const body = DRIVER_NEW_RIDE_OFFER_BODY;
  const notifData = {
    trip_id: tripId,
    offer_id: offerId,
    is_stacked: String(offer.is_stacked),
    broadcast_round: String(offer.broadcast_round),
  };

  return {
    valid: true,
    reason: "ok",
    expiresAt: offer.expires_at,
    title,
    body,
    notifData,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const action = body.action || "enqueue";

    if (action === "tick") {
      // ── TICK MODE (pg_cron/sweep) ──
      // Claim up to 50 pending reminder jobs using SKIP LOCKED
      const { data: claimedJobs, error: claimErr } = await supabase.rpc("claim_dispatch_jobs", {
        p_limit: 50,
      });

      if (claimErr) {
        console.error("[ride-offer-reminders] claim_dispatch_jobs failed:", claimErr);
        return errorResponse("CLAIM_FAILED", claimErr.message, 500);
      }

      if (!claimedJobs || claimedJobs.length === 0) {
        return successResponse({ processed: 0 });
      }

      console.log(`[ride-offer-reminders] Claimed ${claimedJobs.length} due jobs for processing`);

      for (const job of claimedJobs) {
        const payload: ReminderJobPayload = job.payload || { reminder_index: 1 };
        const reminderIndex = payload.reminder_index;

        // Resolve platform targeting
        const { data: tokenRows } = await supabase
          .from("push_tokens")
          .select("platform")
          .eq("driver_id", job.driver_id)
          .eq("app_type", "driver");

        const platforms = new Set((tokenRows ?? []).map((r) => r?.platform).filter(Boolean));
        const hasIos = platforms.has("ios");
        const hasAndroid = platforms.has("android");

        let jobCompleted = false;

        // --- Android reminder execution ---
        if (hasAndroid) {
          const validity = await validateOfferActionable(supabase, job.offer_id, job.driver_id, job.trip_id, "android");
          if (validity.valid && validity.expiresAt) {
            const push = await sendReminderPush(supabaseUrl, serviceKey, {
              driver_id: job.driver_id,
              offer_id: job.offer_id,
              trip_id: job.trip_id,
              booking_id: job.trip_id,
              expires_at: validity.expiresAt,
              title: validity.title!,
              body: validity.body!,
              notifData: validity.notifData!,
              reminderIndex,
              targetPlatform: "android",
            });

            if (push.delivered) {
              await recordReminderPhase(supabase, {
                bookingId: job.trip_id,
                driverId: job.driver_id,
                offerId: job.offer_id,
                phase: "offer_reminder_sent",
                detail: { reminder_index: reminderIndex, platform: "android", source: "jobs_outbox" },
              });

              // Schedule next Android reminder (if reminder_index < 2)
              if (reminderIndex < 2) {
                await supabase.from("dispatch_jobs").insert({
                  offer_id: job.offer_id,
                  driver_id: job.driver_id,
                  trip_id: job.trip_id,
                  status: "pending",
                  run_at: new Date(Date.now() + ANDROID_REMINDER_DELAY_SECONDS * 1000).toISOString(),
                  payload: { reminder_index: reminderIndex + 1 },
                });
              }
            } else {
              await recordReminderPhase(supabase, {
                bookingId: job.trip_id,
                driverId: job.driver_id,
                offerId: job.offer_id,
                phase: "offer_reminder_skipped_reason",
                detail: { reminder_index: reminderIndex, platform: "android", reason: push.reason, source: "jobs_outbox" },
              });
            }
          } else {
            console.log(`[ride-offer-reminders] Android offer invalid: ${validity.reason}`);
            await recordReminderPhase(supabase, {
              bookingId: job.trip_id,
              driverId: job.driver_id,
              offerId: job.offer_id,
              phase: "offer_reminder_cancelled",
              detail: { reminder_index: reminderIndex, platform: "android", reason: validity.reason, source: "jobs_outbox" },
            });
            jobCompleted = true;
          }
        }

        // --- iOS continuous reminder execution ---
        if (hasIos && !jobCompleted) {
          const validity = await validateOfferActionable(supabase, job.offer_id, job.driver_id, job.trip_id, "ios");
          if (validity.valid && validity.expiresAt) {
            const push = await sendReminderPush(supabaseUrl, serviceKey, {
              driver_id: job.driver_id,
              offer_id: job.offer_id,
              trip_id: job.trip_id,
              booking_id: job.trip_id,
              expires_at: validity.expiresAt,
              title: validity.title!,
              body: validity.body!,
              notifData: validity.notifData!,
              reminderIndex,
              targetPlatform: "ios",
              iosRealert: true,
            });

            if (push.delivered) {
              await recordReminderPhase(supabase, {
                bookingId: job.trip_id,
                driverId: job.driver_id,
                offerId: job.offer_id,
                phase: "offer_reminder_sent",
                detail: { reminder_index: reminderIndex, platform: "ios", source: "jobs_outbox" },
              });

              // iOS: repeat every 10 seconds if not expired
              const nextRun = Date.now() + IOS_REMINDER_INTERVAL_SECONDS * 1000;
              if (nextRun < new Date(validity.expiresAt).getTime()) {
                await supabase.from("dispatch_jobs").insert({
                  offer_id: job.offer_id,
                  driver_id: job.driver_id,
                  trip_id: job.trip_id,
                  status: "pending",
                  run_at: new Date(nextRun).toISOString(),
                  payload: { reminder_index: reminderIndex + 1 },
                });
              }
            } else {
              await recordReminderPhase(supabase, {
                bookingId: job.trip_id,
                driverId: job.driver_id,
                offerId: job.offer_id,
                phase: "offer_reminder_skipped_reason",
                detail: { reminder_index: reminderIndex, platform: "ios", reason: push.reason, source: "jobs_outbox" },
              });
            }
          } else {
            console.log(`[ride-offer-reminders] iOS offer invalid: ${validity.reason}`);
            await recordReminderPhase(supabase, {
              bookingId: job.trip_id,
              driverId: job.driver_id,
              offerId: job.offer_id,
              phase: "offer_reminder_cancelled",
              detail: { reminder_index: reminderIndex, platform: "ios", reason: validity.reason, source: "jobs_outbox" },
            });
            jobCompleted = true;
          }
        }

        // Delete current job from outbox queue
        await supabase.from("dispatch_jobs").delete().eq("id", job.job_id);
      }

      return successResponse({ processed: claimedJobs.length });
    } else {
      // ── ENQUEUE MODE (compatibility fallback) ──
      const { driver_id, offer_id, trip_id, expires_at } = body;
      if (!offer_id || !driver_id || !trip_id) {
        return errorResponse("VALIDATION", "offer_id, driver_id and trip_id required", 400);
      }

      console.log(`[ride-offer-reminders] Enqueueing reminder job for offer=${offer_id}`);

      const { error: insErr } = await supabase.from("dispatch_jobs").insert({
        offer_id,
        driver_id,
        trip_id,
        status: "pending",
        run_at: new Date(Date.now() + ANDROID_REMINDER_DELAY_SECONDS * 1000).toISOString(),
        payload: { reminder_index: 1 },
      });

      if (insErr) {
        console.error("[ride-offer-reminders] Queue insert failed:", insErr);
        return errorResponse("INSERT_FAILED", insErr.message, 500);
      }

      return successResponse({ success: true, queued: true });
    }
  } catch (err) {
    console.error("[ride-offer-reminders] Error:", err);
    return errorResponse("INTERNAL_ERROR", String(err), 500);
  }
});
