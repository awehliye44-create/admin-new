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

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: roleData } = await supabase
      .from('profiles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Unified aggregates from driver_financial_summary ──
    // Now includes revenue breakdown by type (completed, no_show, late_cancel)
    const { data: summaryRows } = await supabase
      .from('driver_financial_summary')
      .select('gross_trip_total, company_commission_total, card_net_credits, cash_commission_debits, total_payouts_sent, wallet_balance, completed_trips, today_gross_earnings, today_trip_count, card_gross_total, cash_gross_total, completed_trip_revenue, completed_trip_commission, no_show_revenue, no_show_commission, late_cancel_revenue, late_cancel_commission');

    const all = summaryRows || [];
    const totalGrossFares = all.reduce((s, d) => s + Number(d.gross_trip_total || 0), 0);
    const totalCommission = all.reduce((s, d) => s + Number(d.company_commission_total || 0), 0);
    const totalDriverNet = all.reduce((s, d) => s + Number(d.card_net_credits || 0), 0);
    const totalCashCommission = all.reduce((s, d) => s + Number(d.cash_commission_debits || 0), 0);
    const totalPayoutsSent = all.reduce((s, d) => s + Number(d.total_payouts_sent || 0), 0);
    const totalWalletBalance = all.reduce((s, d) => s + Number(d.wallet_balance || 0), 0);
    const totalTrips = all.reduce((s, d) => s + Number(d.completed_trips || 0), 0);
    const todayGross = all.reduce((s, d) => s + Number(d.today_gross_earnings || 0), 0);
    const todayTrips = all.reduce((s, d) => s + Number(d.today_trip_count || 0), 0);
    const totalCardGross = all.reduce((s, d) => s + Number(d.card_gross_total || 0), 0);
    const totalCashGross = all.reduce((s, d) => s + Number(d.cash_gross_total || 0), 0);

    // ── Trip-level stats that need direct queries ──
    const { data: pendingData } = await supabase
      .from('trips')
      .select('authorised_amount_pence, gross_fare_pence')
      .in('payment_status', ['authorized', 'pending', 'processing']);

    const pendingAmount = pendingData?.reduce((sum, trip) => {
      return sum + (trip.authorised_amount_pence || trip.gross_fare_pence || 0);
    }, 0) || 0;

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
      // Unified financial summary (single source of truth)
      totalGrossFares,
      totalCommission,       // Platform commission (ONECAB revenue)
      totalDriverNet,        // Card net credits to drivers
      totalCashCommission,   // Cash commission owed by drivers
      totalPayoutsSent,
      totalWalletBalance,
      totalCardGross,
      totalCashGross,

      // Legacy field (maps to totalCommission for backwards compat)
      totalRevenue: totalCommission,

      // Trip-level stats
      totalTransactions: totalTrips,
      pendingAmount,
      todayTransactions: todayTrips,
      todayGrossEarnings: todayGross,
      completedTrips: totalTrips,
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
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
