/**
 * submit-customer-trip-tip — one-shot passenger tip after trip completion.
 *
 * Hard rules (canonical tip-window state machine):
 * - Requires service_areas.tips_enabled (positive tip)
 * - Customer App channel only (WhatsApp / guest / corporate excluded)
 * - Only after status=completed and within tip window
 * - Exactly one trigger owns finalisation via claim_tip_window_trigger mutex
 * - tip>0 + tip auth decline → TIP_AUTHORISATION_DECLINED; no fare capture; window stays OPEN
 * - tip>0 + fare already captured / tip_shortfall → TIP_NOT_COLLECTED; never seal tip=0 under WITH_TIP; close window (MK-260926-001)
 * - Capture fare (+ tip when tip > 0) then seal CLOSED
 * - On capture failure / decline: release claim (except provider UNKNOWN retains claim)
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { invokeFinalizeTripCapture } from "../_shared/invokeFinalizeTripCapture.ts";
import { isCustomerAppTipChannelEligible } from "../_shared/tipChannelEligibilitySSOT.ts";
import {
  TIP_AUTHORISATION_DECLINED,
  TIP_AUTHORISATION_DECLINED_CUSTOMER_MESSAGE,
  TIP_NOT_COLLECTED,
  TIP_NOT_COLLECTED_CUSTOMER_MESSAGE,
  TIP_WINDOW_STATUS,
  resolveCustomerTipWindowTrigger,
} from "../_shared/tipWindowConstants.ts";
import {
  claimTipWindowTrigger,
  classifyTipWindowCaptureOutcome,
  closeOpenTipWindowAfterFareCapture,
  finalizeTipWindowTrigger,
  newTipWindowClaimToken,
  releaseTipWindowTriggerClaim,
  tipRequestedButNotCollected,
} from "../_shared/tipWindowTriggerMutexSSOT.ts";
import {
  isTipWindowOpen,
  recordedTipPenceAfterCapture,
  tipWindowCloseAllowedAfterFinalize,
} from "../_shared/tripPaymentFinalised.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function nonNegInt(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ success: false, error: "Server misconfigured", error_code: "CONFIG" }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json({ success: false, error: "Unauthorized", error_code: "UNAUTHORIZED" }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey || serviceRoleKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) {
      return json({ success: false, error: "Unauthorized", error_code: "UNAUTHORIZED" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const tripId = String(body.trip_id ?? body.tripId ?? "").trim();
    let tipAmountPence = nonNegInt(body.tip_amount_pence ?? body.tipAmountPence ?? 0);
    const skipRequested = body.skip === true || body.action === "skip";
    // £1 steps only (UI stepper).
    if (tipAmountPence % 100 !== 0) {
      return json({ success: false, error: "Invalid tip", error_code: "INVALID_TIP" }, 400);
    }
    if (!tripId) {
      return json({ success: false, error: "trip_id is required", error_code: "INVALID_TIP" }, 400);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: customer } = await admin
      .from("customers")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!customer?.id) {
      return json({ success: false, error: "Forbidden", error_code: "FORBIDDEN" }, 403);
    }

    const { data: trip, error: tripErr } = await admin
      .from("trips")
      .select(
        "id, status, passenger_id, service_area_id, booking_source, corporate_account_id, payment_method, payment_provider, payment_status, tip_pence, tip_amount_pence, tip_window_expires_at, tip_window_closed_at, tip_window_status, tip_window_trigger, tip_window_claim_token, completed_at, provider_order_id, payment_intent_id, financial_model",
      )
      .eq("id", tripId)
      .maybeSingle();

    if (tripErr || !trip) {
      return json({ success: false, error: "Trip not found", error_code: "NOT_FOUND" }, 404);
    }
    if (String(trip.passenger_id) !== String(customer.id)) {
      return json({ success: false, error: "Forbidden", error_code: "FORBIDDEN" }, 403);
    }
    if (String(trip.status ?? "").toLowerCase() !== "completed") {
      return json({
        success: false,
        error: "Trip must be completed",
        error_code: "TRIP_NOT_COMPLETED",
      }, 409);
    }

    if (
      String(trip.financial_model ?? "").toUpperCase() ===
        "DRIVER_COLLECTED_COMMISSION_WALLET"
    ) {
      return json({
        success: false,
        error: "Platform tip capture forbidden on DRIVER_COLLECTED_COMMISSION_WALLET",
        error_code: "FINANCIAL_MODEL_VIOLATION",
      }, 409);
    }

    if (
      !isCustomerAppTipChannelEligible({
        booking_source: trip.booking_source,
        corporate_account_id: trip.corporate_account_id,
      })
    ) {
      return json({
        success: false,
        error: "Tips are not available for this booking channel",
        error_code: "TIPS_NOT_ALLOWED_FOR_CHANNEL",
      }, 409);
    }

    const existingTip = nonNegInt(trip.tip_amount_pence ?? trip.tip_pence);
    if (trip.tip_window_closed_at) {
      return json({
        success: true,
        already_submitted: true,
        tip_amount_pence: existingTip,
        tip_window_status: trip.tip_window_status ?? TIP_WINDOW_STATUS.CLOSED,
        tip_window_trigger: trip.tip_window_trigger ?? undefined,
        error_code: "TIP_ALREADY_SUBMITTED",
      });
    }

    // Another trigger holds the mutex (incl. provider UNKNOWN) — do not start a second capture.
    if (String(trip.tip_window_status ?? "").toLowerCase() === "processing") {
      return json({
        success: false,
        error: "Tip payment is still processing. Please wait.",
        error_code: "TIP_WINDOW_PROCESSING",
        tip_window_trigger: trip.tip_window_trigger ?? undefined,
      }, 409);
    }

    let tipsEnabled = false;
    if (trip.service_area_id) {
      const { data: area, error: areaErr } = await admin
        .from("service_areas")
        .select("tips_enabled")
        .eq("id", trip.service_area_id)
        .maybeSingle();
      if (areaErr) {
        console.error("[submit-customer-trip-tip] tips_enabled read failed", areaErr.message);
        return json({
          success: false,
          error: "Unable to check tip settings. Please try again.",
          error_code: "TIP_STATUS_UNAVAILABLE",
        }, 503);
      }
      tipsEnabled = area?.tips_enabled === true;
    }

    const windowOpen = isTipWindowOpen(trip, Date.now());

    if (!tipsEnabled && tipAmountPence > 0) {
      if (!windowOpen) {
        return json({
          success: false,
          error: "Tips disabled",
          error_code: "TIPS_DISABLED",
        }, 409);
      }
      tipAmountPence = 0;
    }

    if (!tipsEnabled && tipAmountPence === 0 && !windowOpen) {
      return json({ success: true, tip_amount_pence: 0, tips_disabled: true });
    }

    if (!windowOpen) {
      return json({
        success: false,
        error: "Tip window closed",
        error_code: "TIP_WINDOW_CLOSED",
      }, 409);
    }

    if (existingTip > 0 && tipAmountPence > 0 && tipAmountPence !== existingTip) {
      tipAmountPence = existingTip;
    } else if (existingTip > 0 && tipAmountPence === 0) {
      tipAmountPence = existingTip;
    }

    const nowIso = new Date().toISOString();
    const expiresAt = trip.tip_window_expires_at;
    if (!expiresAt) {
      return json({
        success: false,
        error: "Tip window closed",
        error_code: "TIP_WINDOW_CLOSED",
      }, 409);
    }

    const trigger = resolveCustomerTipWindowTrigger({
      tipAmountPence,
      skip: skipRequested && tipAmountPence === 0,
    });
    const claimToken = newTipWindowClaimToken();

    // Persist tip amount (or tip=0) before mutex claim so finalize tip match works.
    {
      let claimQuery = admin
        .from("trips")
        .update({
          tip_amount_pence: tipAmountPence,
          tip_pence: tipAmountPence,
          tip_window_expires_at: expiresAt,
          updated_at: nowIso,
        })
        .eq("id", tripId)
        .is("tip_window_closed_at", null)
        .neq("tip_window_status", "processing");
      if (existingTip === 0 && tipAmountPence > 0) {
        claimQuery = claimQuery.or("tip_amount_pence.is.null,tip_amount_pence.eq.0");
      }
      if (tipAmountPence === 0) {
        claimQuery = claimQuery.or("tip_amount_pence.is.null,tip_amount_pence.eq.0");
      }
      const { data: claimed, error: claimErr } = await claimQuery.select("id").maybeSingle();

      if (claimErr) {
        console.error("[submit-customer-trip-tip] tip amount claim failed", claimErr.message);
        return json({ success: false, error: "Could not save tip", error_code: "CAPTURE_FAILED" }, 500);
      }
      if (!claimed) {
        const { data: raced } = await admin
          .from("trips")
          .select("tip_amount_pence, tip_pence, tip_window_closed_at, tip_window_status")
          .eq("id", tripId)
          .maybeSingle();
        if (raced?.tip_window_closed_at) {
          return json({
            success: true,
            already_submitted: true,
            tip_amount_pence: nonNegInt(raced.tip_amount_pence ?? raced.tip_pence),
            error_code: "TIP_ALREADY_SUBMITTED",
          });
        }
        if (String(raced?.tip_window_status ?? "").toLowerCase() === "processing") {
          return json({
            success: false,
            error: "Tip payment is still processing. Please wait.",
            error_code: "TIP_WINDOW_PROCESSING",
          }, 409);
        }
        const racedTip = nonNegInt(raced?.tip_amount_pence ?? raced?.tip_pence);
        if (racedTip > 0) {
          tipAmountPence = racedTip;
        } else if (tipAmountPence > 0) {
          return json({
            success: false,
            error: "Could not save tip",
            error_code: "CAPTURE_FAILED",
          }, 409);
        }
      }
    }

    const mutex = await claimTipWindowTrigger(admin, {
      tripId,
      trigger,
      claimToken,
      nowIso,
    });
    if (!mutex.ok) {
      if (mutex.code === "ALREADY_CLOSED") {
        return json({
          success: true,
          already_submitted: true,
          tip_amount_pence: existingTip,
          tip_window_status: mutex.tipWindowStatus,
          tip_window_trigger: mutex.tipWindowTrigger,
          error_code: "TIP_ALREADY_SUBMITTED",
        });
      }
      if (mutex.code === "CLAIM_HELD") {
        return json({
          success: false,
          error: "Tip payment is still processing. Please wait.",
          error_code: "TIP_WINDOW_PROCESSING",
          tip_window_trigger: mutex.tipWindowTrigger,
        }, 409);
      }
      if (mutex.code === "WINDOW_NOT_OPEN") {
        return json({
          success: false,
          error: "Tip window closed",
          error_code: "TIP_WINDOW_CLOSED",
        }, 409);
      }
      return json({
        success: false,
        error: "Could not claim tip window",
        error_code: "CAPTURE_FAILED",
      }, 409);
    }

    const paymentMethod = String(trip.payment_method ?? "").toLowerCase();
    const isCash = paymentMethod === "cash";
    const provider = String(trip.payment_provider ?? "").toLowerCase();
    const hasProvider =
      Boolean(String(trip.provider_order_id ?? "").trim()) ||
      Boolean(String(trip.payment_intent_id ?? "").trim());

    if (!isCash && hasProvider && provider === "revolut") {
      const rec = await invokeFinalizeTripCapture({
        supabaseUrl,
        serviceRoleKey,
        tripId,
        tipPence: tipAmountPence,
        source: "submit_customer_trip_tip",
      });
      const outcome = classifyTipWindowCaptureOutcome(rec.body);

      if (outcome.kind === "tip_authorisation_declined") {
        await releaseTipWindowTriggerClaim(admin, {
          tripId,
          claimToken: mutex.claimToken,
          clearTip: true,
          nowIso: new Date().toISOString(),
        });
        return json({
          success: false,
          error: TIP_AUTHORISATION_DECLINED_CUSTOMER_MESSAGE,
          error_code: TIP_AUTHORISATION_DECLINED,
          tip_window_status: TIP_WINDOW_STATUS.OPEN,
          fare_captured: false,
        }, 402);
      }

      if (outcome.kind === "provider_unknown") {
        // Retain claim — another trigger must not capture.
        return json({
          success: false,
          error: "Payment is still confirming. Please wait.",
          error_code: "PROVIDER_UNKNOWN",
          tip_window_status: TIP_WINDOW_STATUS.PROCESSING,
          tip_window_trigger: trigger,
        }, 502);
      }

      if (!tipWindowCloseAllowedAfterFinalize(rec.body) || outcome.kind !== "capture_confirmed") {
        console.error("[submit-customer-trip-tip] capture not confirmed", {
          trip_id: tripId,
          error: rec.error,
          body: rec.body,
        });
        await releaseTipWindowTriggerClaim(admin, {
          tripId,
          claimToken: mutex.claimToken,
          clearTip: true,
          nowIso: new Date().toISOString(),
        });
        return json({
          success: false,
          error: rec.error ?? "Capture failed",
          error_code: "CAPTURE_FAILED",
        }, 502);
      }

      // MK-260926-001: fare-only already_captured must not seal WITH_TIP at tip=0.
      // Close the tip window immediately so Rate Trip hides tip stepper/timer.
      const requestedTipBeforeCollect = tipAmountPence;
      if (
        tipRequestedButNotCollected({
          requestedTipPence: requestedTipBeforeCollect,
          body: rec.body,
        })
      ) {
        const closeNow = new Date().toISOString();
        await releaseTipWindowTriggerClaim(admin, {
          tripId,
          claimToken: mutex.claimToken,
          clearTip: true,
          nowIso: closeNow,
        });
        await closeOpenTipWindowAfterFareCapture(admin, {
          tripId,
          tipPence: 0,
          nowIso: closeNow,
        });
        return json({
          success: false,
          error: TIP_NOT_COLLECTED_CUSTOMER_MESSAGE,
          error_code: TIP_NOT_COLLECTED,
          tip_window_status: TIP_WINDOW_STATUS.CLOSED,
          tip_window_closed_at: closeNow,
          tip_amount_pence: 0,
          fare_captured: true,
        }, 409);
      }

      if (tipAmountPence > 0) {
        tipAmountPence = recordedTipPenceAfterCapture(rec.body?.tip_collected_pence) ?? 0;
      }

      const sealed = await finalizeTipWindowTrigger(admin, {
        tripId,
        claimToken: mutex.claimToken,
        trigger,
        tipPence: tipAmountPence,
        nowIso: new Date().toISOString(),
      });
      if (!sealed.ok) {
        return json({
          success: false,
          error: "Tip captured but window close failed — retry",
          error_code: "CAPTURE_FAILED",
        }, 502);
      }

      return json({
        success: true,
        tip_amount_pence: tipAmountPence,
        tip_window_closed_at: nowIso,
        tip_window_status: sealed.tipWindowStatus,
        tip_window_trigger: trigger,
        tips_disabled: tipsEnabled ? undefined : true,
      });
    }

    if (isCash) {
      const sealed = await finalizeTipWindowTrigger(admin, {
        tripId,
        claimToken: mutex.claimToken,
        trigger,
        tipPence: tipAmountPence,
        nowIso: new Date().toISOString(),
      });
      if (!sealed.ok) {
        await releaseTipWindowTriggerClaim(admin, {
          tripId,
          claimToken: mutex.claimToken,
          clearTip: true,
        });
        return json({
          success: false,
          error: "Could not close tip window",
          error_code: "CAPTURE_FAILED",
        }, 500);
      }
      return json({
        success: true,
        tip_amount_pence: tipAmountPence,
        tip_window_closed_at: nowIso,
        tip_window_status: sealed.tipWindowStatus,
        tip_window_trigger: trigger,
        tips_disabled: tipsEnabled ? undefined : true,
      });
    }

    await releaseTipWindowTriggerClaim(admin, {
      tripId,
      claimToken: mutex.claimToken,
      clearTip: true,
    });
    return json({
      success: false,
      error: "Card tip capture requires Revolut provider order",
      error_code: "CAPTURE_FAILED",
    }, 409);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[submit-customer-trip-tip]", message);
    return json({ success: false, error: message, error_code: "CAPTURE_FAILED" }, 500);
  }
});
