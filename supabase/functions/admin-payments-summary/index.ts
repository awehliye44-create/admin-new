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

    // Verify admin role
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

    // Calculate KPI metrics
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = today.toISOString();

    // Total Revenue (platform commission from captured/completed digital trips)
    const { data: revenueData } = await supabase
      .from('trips')
      .select('commission_pence, stripe_processing_fee_pence')
      .eq('status', 'completed')
      .in('payment_status', ['captured', 'collected_cash', 'paid']);

    const totalRevenue = revenueData?.reduce((sum, trip) => {
      const commission = trip.commission_pence || 0;
      const stripeFee = trip.stripe_processing_fee_pence || 0;
      return sum + commission - stripeFee;
    }, 0) || 0;

    // Total Transactions count
    const { count: totalTransactions } = await supabase
      .from('trips')
      .select('id', { count: 'exact', head: true })
      .not('payment_method', 'is', null);

    // Pending Amount (authorized but not captured)
    const { data: pendingData } = await supabase
      .from('trips')
      .select('authorised_amount_pence, gross_fare_pence')
      .in('payment_status', ['authorized', 'pending', 'processing']);

    const pendingAmount = pendingData?.reduce((sum, trip) => {
      return sum + (trip.authorised_amount_pence || trip.gross_fare_pence || 0);
    }, 0) || 0;

    // Today's Transactions
    const { count: todayTransactions } = await supabase
      .from('trips')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', todayISO)
      .not('payment_method', 'is', null);

    // Additional stats
    const { count: completedTrips } = await supabase
      .from('trips')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed');

    const { count: refundedTrips } = await supabase
      .from('trips')
      .select('id', { count: 'exact', head: true })
      .gt('refund_amount_pence', 0);

    const { data: refundData } = await supabase
      .from('trips')
      .select('refund_amount_pence')
      .gt('refund_amount_pence', 0);

    const totalRefunds = refundData?.reduce((sum, trip) => sum + (trip.refund_amount_pence || 0), 0) || 0;

    // Payment method breakdown
    const { data: methodBreakdown } = await supabase
      .from('trips')
      .select('payment_method')
      .eq('status', 'completed');

    const paymentMethods = methodBreakdown?.reduce((acc: Record<string, number>, trip) => {
      const method = trip.payment_method || 'unknown';
      acc[method] = (acc[method] || 0) + 1;
      return acc;
    }, {}) || {};

    const response = {
      totalRevenue,
      totalTransactions: totalTransactions || 0,
      pendingAmount,
      todayTransactions: todayTransactions || 0,
      completedTrips: completedTrips || 0,
      refundedTrips: refundedTrips || 0,
      totalRefunds,
      paymentMethods,
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in admin-payments-summary:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
