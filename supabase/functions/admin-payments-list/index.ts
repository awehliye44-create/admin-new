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

    // Parse query parameters
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const status = url.searchParams.get('status');
    const method = url.searchParams.get('method');
    const type = url.searchParams.get('type'); // 'payment', 'refund', or null for all
    const search = url.searchParams.get('search');
    const startDate = url.searchParams.get('startDate');
    const endDate = url.searchParams.get('endDate');

    const offset = (page - 1) * limit;

    // Build query
    let query = supabase
      .from('trips')
      .select(`
        id,
        trip_code,
        trip_number,
        pickup_address,
        dropoff_address,
        gross_fare_pence,
        commission_pence,
        driver_net_pence,
        payment_method,
        payment_status,
        stripe_payment_intent_id,
        stripe_charge_id,
        refund_amount_pence,
        refund_reason,
        refunded_at,
        extras_pence,
        tip_pence,
        created_at,
        completed_at,
        status,
        driver_id,
        passenger_id,
        drivers:driver_id (
          id,
          first_name,
          last_name,
          email
        )
      `, { count: 'exact' })
      .not('payment_method', 'is', null)
      .order('created_at', { ascending: false });

    // Apply filters
    if (status) {
      query = query.eq('payment_status', status);
    }

    if (method) {
      query = query.eq('payment_method', method.toUpperCase());
    }

    if (type === 'refund') {
      query = query.gt('refund_amount_pence', 0);
    } else if (type === 'payment') {
      query = query.or('refund_amount_pence.is.null,refund_amount_pence.eq.0');
    }

    if (startDate) {
      query = query.gte('created_at', startDate);
    }

    if (endDate) {
      query = query.lte('created_at', endDate);
    }

    if (search) {
      query = query.or(`trip_code.ilike.%${search}%,trip_number.ilike.%${search}%,pickup_address.ilike.%${search}%,dropoff_address.ilike.%${search}%`);
    }

    // Apply pagination
    query = query.range(offset, offset + limit - 1);

    const { data: transactions, error, count } = await query;

    if (error) {
      console.error('Query error:', error);
      throw error;
    }

    // Transform data
    const transformedTransactions = transactions?.map((t: any) => ({
      id: t.id,
      tripCode: t.trip_code || t.trip_number,
      type: (t.refund_amount_pence && t.refund_amount_pence > 0) ? 'refund' : 'payment',
      route: `${t.pickup_address?.split(',')[0] || 'Unknown'} → ${t.dropoff_address?.split(',')[0] || 'Unknown'}`,
      amount: t.gross_fare_pence || 0,
      refundAmount: t.refund_amount_pence || 0,
      status: t.payment_status || 'unknown',
      method: t.payment_method || 'unknown',
      date: t.created_at,
      completedAt: t.completed_at,
      driver: t.drivers ? `${t.drivers.first_name} ${t.drivers.last_name}` : null,
      driverId: t.driver_id,
      customer: null,
      customerId: t.passenger_id,
      commission: t.commission_pence || 0,
      driverNet: t.driver_net_pence || 0,
      extras: t.extras_pence || 0,
      tip: t.tip_pence || 0,
      stripePaymentIntentId: t.stripe_payment_intent_id,
      stripeChargeId: t.stripe_charge_id,
    })) || [];

    return new Response(JSON.stringify({
      transactions: transformedTransactions,
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in admin-payments-list:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
