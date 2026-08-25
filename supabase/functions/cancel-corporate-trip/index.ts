import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { notifyCustomerActiveTripEvent } from "../_shared/notifyCustomerActiveTripEvent.ts";
import { disposeTerminalTripPayment } from "../_shared/terminalTripPaymentDisposition.ts";
import {
  disposeOutcomeIndicatesFeeCapture,
  mapFeeTypeToChargedOutcome,
  postChargedFeeTenViaRfo,
  resolveAssignedDriverId,
} from "../_shared/chargedTerminalFeeWalletSSOT.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Auth client to verify user
    const supabaseAuth = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Service role client for privileged operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { trip_id, reason, note, cancelled_by_role } = body;

    if (!trip_id || !reason) {
      return new Response(JSON.stringify({ error: 'trip_id and reason are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 1. Fetch the trip
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id, status, driver_id, confirmed_driver_id, service_area_id, arrived_at, created_at, scheduled_at, final_fare_pence, estimated_fare, payment_method, payment_provider, provider_order_id')
      .eq('id', trip_id)
      .single();

    if (tripError || !trip) {
      return new Response(JSON.stringify({ error: 'Trip not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2. Validate trip is cancellable
    const cancellableStatuses = [
      'pending', 'searching', 'offered', 'broadcasting',
      'accepted', 'en_route_to_pickup', 'driver_assigned',
      'arrived', 'arrived_pickup', 'scheduled',
    ];

    if (!cancellableStatuses.includes(trip.status)) {
      return new Response(JSON.stringify({ error: `Trip cannot be cancelled in status: ${trip.status}` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Fetch dispatch settings for the trip's service area
    let settings: any = null;
    if (trip.service_area_id) {
      const { data } = await supabase
        .from('dispatch_settings')
        .select('cancel_protection, cancellation_fee_after_grace_pence, late_cancel_enabled, late_cancel_threshold_minutes, late_cancel_fee_pence, no_show_charge_pence, pickup_waiting_grace_period_seconds')
        .eq('service_area_id', trip.service_area_id)
        .maybeSingle();
      settings = data;
    }

    // Fallback to global settings
    if (!settings) {
      const { data } = await supabase
        .from('dispatch_settings')
        .select('cancel_protection, cancellation_fee_after_grace_pence, late_cancel_enabled, late_cancel_threshold_minutes, late_cancel_fee_pence, no_show_charge_pence, pickup_waiting_grace_period_seconds')
        .is('service_area_id', null)
        .maybeSingle();
      settings = data;
    }

    // 4. Determine cancellation type and applicable fee
    let cancellation_fee_pence = 0;
    let cancellation_type = 'free';
    const now = new Date();

    const driverAssigned = !!trip.driver_id;
    const driverArrived = !!trip.arrived_at;

    if (settings) {
      // Late cancellation check
      if (settings.late_cancel_enabled && driverAssigned) {
        const arrivedAt = trip.arrived_at ? new Date(trip.arrived_at) : null;
        
        if (driverArrived && arrivedAt) {
          // After arrival, any cancellation is chargeable
          cancellation_fee_pence = settings.cancellation_fee_after_grace_pence || settings.late_cancel_fee_pence || 0;
          cancellation_type = 'late_cancellation_after_arrival';
        } else {
          // Before arrival — check time threshold
          const assignedStatuses = ['accepted', 'en_route_to_pickup', 'driver_assigned'];
          if (assignedStatuses.includes(trip.status)) {
            // If cancel_protection is on and threshold exceeded, charge fee
            const thresholdMinutes = settings.late_cancel_threshold_minutes || 5;
            // We don't have exact assignment time, so use a reasonable heuristic
            // For scheduled trips, check against scheduled time
            if (trip.scheduled_at) {
              const scheduledTime = new Date(trip.scheduled_at);
              const minutesBeforePickup = (scheduledTime.getTime() - now.getTime()) / 60000;
              if (minutesBeforePickup <= thresholdMinutes) {
                cancellation_fee_pence = settings.late_cancel_fee_pence || 0;
                cancellation_type = 'late_cancellation';
              }
            }
          }
        }
      }

      // Cancellation after arrival always charges
      if (driverArrived && settings.cancellation_fee_after_grace_pence > 0 && cancellation_fee_pence === 0) {
        cancellation_fee_pence = settings.cancellation_fee_after_grace_pence;
        cancellation_type = 'cancellation_after_arrival';
      }
    }

    // 5. End any active waiting sessions
    await supabase
      .from('trip_stop_waiting')
      .update({ status: 'cancelled', ended_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('trip_id', trip_id)
      .eq('status', 'active');

    // 6. Update trip status (+ charged-fee stamps when fee applies)
    const feeType =
      cancellation_type === 'late_cancellation'
        ? 'late_cancellation'
        : cancellation_type.includes('arrival')
        ? 'cancellation'
        : cancellation_fee_pence > 0
        ? 'cancellation'
        : 'none';
    const financialOutcome = cancellation_fee_pence > 0
      ? (mapFeeTypeToChargedOutcome(feeType) ?? 'CANCELLED_WITH_FEE')
      : 'CANCELLED_NO_FEE';

    const updatePayload: Record<string, any> = {
      status: 'cancelled',
      cancellation_reason: reason,
      cancellation_note: reason === 'Other' ? (note || null) : null,
      cancelled_by: user.id,
      cancelled_by_role: cancelled_by_role || 'corporate',
      cancelled_at: now.toISOString(),
      financial_outcome: financialOutcome,
      updated_at: now.toISOString(),
    };

    // If there's a fee, stamp non-commissionable driver compensation fields.
    if (cancellation_fee_pence > 0) {
      updatePayload.final_fare_pence = cancellation_fee_pence;
      updatePayload.cancellation_fee_pence = cancellation_fee_pence;
      if (feeType === 'late_cancellation') {
        updatePayload.late_cancel_fee_pence = cancellation_fee_pence;
      }
      updatePayload.commission_pence = 0;
      updatePayload.commission_pct = 0;
      updatePayload.driver_net_pence = cancellation_fee_pence;
      updatePayload.driver_net_before_tip_pence = cancellation_fee_pence;
      updatePayload.gross_fare_pence = cancellation_fee_pence;
    }

    const { error: updateError } = await supabase
      .from('trips')
      .update(updatePayload)
      .eq('id', trip_id);

    if (updateError) {
      console.error('Failed to cancel trip:', updateError);
      return new Response(JSON.stringify({ error: 'Failed to cancel trip' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 7. Clear driver's current_trip_id if assigned
    const settlementDriverId = resolveAssignedDriverId({
      driver_id: trip.driver_id,
      confirmed_driver_id: trip.confirmed_driver_id,
    });
    if (settlementDriverId) {
      await supabase
        .from('drivers')
        .update({ current_trip_id: null, updated_at: now.toISOString() })
        .eq('id', settlementDriverId)
        .eq('current_trip_id', trip_id);
    }

    // 8. Dispose Revolut hold / capture fee; post TEN only after proven capture.
    let holdDisposition: Awaited<ReturnType<typeof disposeTerminalTripPayment>> | null = null;
    let walletSettlementStatus: string = 'NOT_REQUIRED';
    try {
      holdDisposition = await disposeTerminalTripPayment(supabase, {
        tripId: trip_id,
        reason: 'customer_cancel',
        feePence: cancellation_fee_pence,
        forceFeePenceOverride: true,
      });
    } catch (e) {
      console.error('[cancel-corporate-trip] dispose failed', e);
      if (cancellation_fee_pence > 0) {
        return new Response(JSON.stringify({
          success: false,
          error_code: 'FEE_DISPOSITION_FAILED',
          error: 'Fee capture disposition failed after terminal trip update. No second capture attempted.',
        }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    const feeCaptured =
      cancellation_fee_pence > 0 && disposeOutcomeIndicatesFeeCapture(holdDisposition);
    if (feeCaptured) {
      const wallet = await postChargedFeeTenViaRfo({
        supabaseUrl,
        serviceRoleKey: supabaseServiceKey,
        tripId: trip_id,
        driverId: settlementDriverId,
        outcome: financialOutcome,
        feePence: Math.round(Number(holdDisposition?.captured_fee_pence) || cancellation_fee_pence),
        paymentMethod: trip.payment_method ?? null,
        disposition: holdDisposition,
      });
      walletSettlementStatus = wallet.status;
      if (wallet.status !== 'SUCCEEDED') {
        console.error('[cancel-corporate-trip] WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE', {
          trip_id,
          wallet,
        });
        return new Response(JSON.stringify({
          success: false,
          error_code: 'WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE',
          cancellation_type,
          cancellation_fee_pence,
          wallet_settlement_status: wallet.status,
          error: 'Fee was captured but Driver Wallet settlement failed. No second capture.',
        }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Customer active-trip high-priority cancel (deduped tripId:trip_cancelled).
    void notifyCustomerActiveTripEvent(supabase, {
      tripId: trip_id,
      event: "trip_cancelled",
    });

    return new Response(
      JSON.stringify({
        success: true,
        cancellation_type,
        cancellation_fee_pence,
        financial_outcome: financialOutcome,
        hold_disposition_outcome: holdDisposition?.outcome ?? null,
        wallet_settlement_status: walletSettlementStatus,
        message: cancellation_fee_pence > 0
          ? `Trip cancelled with a ${(cancellation_fee_pence / 100).toFixed(2)} fee.`
          : 'Trip cancelled successfully.',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('cancel-corporate-trip error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
