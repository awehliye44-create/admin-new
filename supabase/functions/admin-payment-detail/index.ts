import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getDriverCommissionPct } from "../_shared/commission.ts";
import { resolveCurrencyFromTrip } from "../_shared/regionCurrency.ts";
import {
  getPaymentRowCapturedPence,
  getTripDriverNetPence,
  getTripSettlementFarePence,
} from "../_shared/tripSettlementFinanceSSOT.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get authorization header to verify admin
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check admin role via user_roles table (NOT profiles — prevents privilege escalation)
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .maybeSingle();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(req.url);

    // === POST: Confirm payment ===
    if (req.method === 'POST') {
      const body = await req.json();
      const { trip_id, action } = body;

      if (!trip_id) {
        return new Response(JSON.stringify({ error: 'trip_id is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (action === 'confirm_payment') {
        const { data: trip, error: tripErr } = await supabase
          .from('trips')
          .select('id, status, payment_status, payment_method, gross_fare_pence, commission_pence, driver_net_pence, driver_id')
          .eq('id', trip_id)
          .single();

        if (tripErr || !trip) {
          return new Response(JSON.stringify({ error: 'Trip not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // === Resolve currency from Region (single source of truth) ===
        let currency_code: string;
        try {
          const regionCurrency = await resolveCurrencyFromTrip(supabase, trip_id);
          currency_code = regionCurrency.currency_code;
        } catch (e) {
          console.error('[admin-payment-detail] Currency resolution failed:', e);
          return new Response(JSON.stringify({ error: (e as Error).message, error_code: 'REGION_CURRENCY_UNRESOLVABLE' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }


        // Update payment status to confirmed/paid
        const newStatus = 'captured';
        const { error: updateErr } = await supabase
          .from('trips')
          .update({ 
            payment_status: newStatus,
            updated_at: new Date().toISOString(),
          })
          .eq('id', trip_id);

        if (updateErr) {
          return new Response(JSON.stringify({ error: updateErr.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // If trip has fare data and a driver, create ledger entry if not already exists
        if (trip.driver_id && trip.commission_pence && trip.commission_pence > 0) {
          const { data: existingEntry } = await supabase
            .from('driver_wallet_ledger')
            .select('id')
            .eq('related_trip_id', trip_id)
            .limit(1);

          if (!existingEntry || existingEntry.length === 0) {
            const netPence = trip.driver_net_pence || (trip.gross_fare_pence || 0) - trip.commission_pence;
            await supabase.from('driver_wallet_ledger').insert({
              driver_id: trip.driver_id,
              related_trip_id: trip_id,
              type: 'TRIP_EARNING_NET',
              amount_pence: netPence,
              currency: currency_code,
              description: 'Net earnings from trip (admin confirmed)',
            });
          }
        }

        // Log the action
        await supabase.from('audit_logs').insert({
          event_type: 'admin_confirm_payment',
          user_id: user.id,
          trip_id: trip_id,
          details: { previous_status: trip.payment_status, new_status: newStatus },
        });

        return new Response(JSON.stringify({ 
          success: true, 
          message: `Payment ${newStatus}`,
          newStatus,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'Unknown action' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === GET: Fetch payment detail ===
    const tripId = url.searchParams.get('trip_id');

    if (!tripId) {
      return new Response(JSON.stringify({ error: 'trip_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch trip with driver join only (no customer FK)
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select(`
        *,
        drivers:driver_id (
          id,
          first_name,
          last_name,
          email,
          phone,
          stripe_account_id,
          payouts_enabled,
          category_id
        )
      `)
      .eq('id', tripId)
      .single();

    if (tripError || !trip) {
      console.error('Trip fetch error:', tripError?.message);
      return new Response(JSON.stringify({ error: 'Trip not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch customer separately (no FK relationship)
    let customer = null;
    if (trip.passenger_id) {
      const { data: customerData } = await supabase
        .from('customers')
        .select('id, first_name, last_name, phone')
        .eq('user_id', trip.passenger_id)
        .single();
      customer = customerData;
    }

    // Get commission rate from driver's tier (Bronze default if unassigned)
    let commissionPercent = 0;
    if (trip.drivers?.id) {
      commissionPercent = await getDriverCommissionPct(supabase, trip.drivers.id, trip.service_area_id);
    }

    // Get related ledger entries from driver_wallet_ledger
    const { data: ledgerEntries } = await supabase
      .from('driver_wallet_ledger')
      .select('*')
      .eq('related_trip_id', tripId)
      .order('created_at', { ascending: false });

    const { data: payments } = await supabase
      .from('payments')
      .select('id, stripe_payment_intent_id, captured_amount_pence, amount_pence, status, metadata, capture_method, created_at, provider_charge_id')
      .eq('trip_id', tripId)
      .order('created_at', { ascending: true });

    let paymentCaptured = 0;
    const paymentRows = (payments ?? []).map((payment) => {
      const captured = getPaymentRowCapturedPence(payment);
      paymentCaptured += captured;
      const meta = (payment.metadata && typeof payment.metadata === 'object')
        ? payment.metadata as Record<string, unknown>
        : {};
      return {
        id: payment.id,
        stripePaymentIntentId: payment.stripe_payment_intent_id ?? null,
        capturedAmountPence: captured,
        amountPence: payment.amount_pence ?? 0,
        status: payment.status ?? null,
        captureMethod: payment.capture_method ?? null,
        providerChargeId: payment.provider_charge_id ?? null,
        source: typeof meta.source === 'string' ? meta.source : null,
        createdAt: payment.created_at ?? null,
      };
    });

    const customerPaidPence = getTripSettlementFarePence(trip, {
      paymentCapturedPence: paymentCaptured > 0 ? paymentCaptured : null,
    });
    const finalSettlementTotalPence = customerPaidPence;

    // Calculate fare breakdown — settlement SSOT for finance display
    const estimatedFare = trip.estimated_fare ? Math.round(trip.estimated_fare * 100) : (trip.estimated_fare_pence ?? 0);
    const extras = trip.extras_pence || 0;
    const tip = trip.tip_pence || 0;
    const waitingChargePence = Math.max(
      0,
      trip.total_waiting_charge_pence
        ?? trip.waiting_charge_pence
        ?? trip.pickup_waiting_charge_pence
        ?? 0,
    );
    const commission = trip.commission_pence || 0;
    const driverNet = getTripDriverNetPence({
      driver_net_pence: trip.driver_net_pence,
      ledger: (ledgerEntries ?? []).map((entry) => ({
        type: entry.type,
        amount_pence: entry.amount_pence,
      })),
    });
    const stripeFee = trip.stripe_processing_fee_pence || 0;
    // ONECAB net after Stripe — read from DB (do NOT recompute on the client).
    // Historical trips that pre-date fee tracking fall back to gross commission.
    const onecabNet = trip.onecab_net_pence != null
      ? trip.onecab_net_pence
      : (stripeFee > 0 ? Math.max(0, commission - stripeFee) : commission);

    const response = {
      trip: {
        id: trip.id,
        tripCode: trip.trip_code || trip.trip_number,
        status: trip.status,
        paymentStatus: trip.payment_status,
        paymentMethod: trip.payment_method,
        pickup: {
          address: trip.pickup_address,
          lat: trip.pickup_latitude,
          lng: trip.pickup_longitude,
        },
        dropoff: {
          address: trip.dropoff_address,
          lat: trip.dropoff_latitude,
          lng: trip.dropoff_longitude,
        },
        timestamps: {
          created: trip.created_at,
          started: trip.started_at,
          completed: trip.completed_at,
          refunded: trip.refunded_at,
        },
      },
      fareBreakdown: {
        estimatedFare,
        extras,
        tip,
        waitingChargePence,
        customerPaidPence,
        finalSettlementTotalPence,
        /** @deprecated Use customerPaidPence — legacy gross fare retained for quote comparison only */
        grossFare: trip.gross_fare_pence || (estimatedFare + extras + tip),
        authorisedAmount: trip.authorised_amount_pence,
      },
      commissionBreakdown: {
        commissionPercent,
        commissionFixed: 0,
        platformCommission: commission,
        driverNet,
        stripeFee,
        onecabNet,
      },
      stripe: {
        paymentIntentId: trip.stripe_payment_intent_id,
        chargeId: trip.stripe_charge_id,
        captureStatus: trip.payment_status,
      },
      paymentRows,
      refund: trip.refund_amount_pence ? {
        amount: trip.refund_amount_pence,
        reason: trip.refund_reason,
        refundedAt: trip.refunded_at,
      } : null,
      driver: trip.drivers ? {
        id: trip.drivers.id,
        name: `${trip.drivers.first_name} ${trip.drivers.last_name}`,
        email: trip.drivers.email,
        phone: trip.drivers.phone,
        stripeAccountId: trip.drivers.stripe_account_id,
        payoutsEnabled: trip.drivers.payouts_enabled,
      } : null,
      customer: customer ? {
        id: customer.id,
        name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
        phone: customer.phone,
      } : null,
      ledgerEntries: ledgerEntries || [],
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in admin-payment-detail:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
