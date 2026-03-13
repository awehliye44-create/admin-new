import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse trip_id from query
    const url = new URL(req.url);
    const tripId = url.searchParams.get('trip_id');

    if (!tripId) {
      return new Response(JSON.stringify({ error: 'trip_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch trip details
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
        ),
        customers:passenger_id (
          id,
          first_name,
          last_name,
          phone
        )
      `)
      .eq('id', tripId)
      .single();

    if (tripError || !trip) {
      return new Response(JSON.stringify({ error: 'Trip not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get commission rate from driver's tier (single source of truth)
    let commissionPercent = 20; // default fallback
    if (trip.drivers?.category_id) {
      const { data: category } = await supabase
        .from('driver_categories')
        .select('commission_pct, name')
        .eq('id', trip.drivers.category_id)
        .single();
      if (category?.commission_pct != null) {
        commissionPercent = category.commission_pct;
      }
    }

    // Get related ledger entries
    const { data: ledgerEntries } = await supabase
      .from('driver_ledger')
      .select('*')
      .eq('trip_id', tripId)
      .order('created_at', { ascending: false });

    // Calculate fare breakdown
    const estimatedFare = trip.estimated_fare ? Math.round(trip.estimated_fare * 100) : 0;
    const extras = trip.extras_pence || 0;
    const tip = trip.tip_pence || 0;
    const grossFare = trip.gross_fare_pence || (estimatedFare + extras + tip);
    const commission = trip.commission_pence || 0;
    const driverNet = trip.driver_net_pence || 0;
    const stripeFee = trip.stripe_processing_fee_pence || 0;

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
        grossFare,
        authorisedAmount: trip.authorised_amount_pence,
      },
      commissionBreakdown: {
        commissionPercent: commissionPercent,
        commissionFixed: 0,
        platformCommission: commission,
        driverNet,
        stripeFee,
        platformNet: commission - stripeFee,
      },
      stripe: {
        paymentIntentId: trip.stripe_payment_intent_id,
        chargeId: trip.stripe_charge_id,
        captureStatus: trip.payment_status,
      },
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
      customer: trip.customers ? {
        id: trip.customers.id,
        name: `${trip.customers.first_name || ''} ${trip.customers.last_name || ''}`.trim(),
        phone: trip.customers.phone,
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
