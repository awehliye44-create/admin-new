import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
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

    // Check admin role via user_roles table (NOT profiles — prevents privilege escalation)
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .maybeSingle();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── SSOT: driver_financial_summary (100% derived from driver_wallet_ledger) ──
    const { data: summaryRows } = await supabase
      .from('driver_financial_summary')
      .select('gross_trip_total, company_commission_total, card_net_credits, cash_commission_debits, total_payouts_sent, wallet_balance, completed_trips, today_gross_earnings, today_trip_count, card_gross_total, cash_gross_total');

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

    // ── Pending payments: trips with payment_status = 'pending' (not yet captured/confirmed) ──
    const { count: pendingCount } = await supabase
      .from('trips')
      .select('id', { count: 'exact', head: true })
      .eq('payment_status', 'pending');

    const { data: pendingRows } = await supabase
      .from('trips')
      .select('gross_fare_pence')
      .eq('payment_status', 'pending');

    const pendingAmount = (pendingRows || []).reduce((s, t) => s + Number(t.gross_fare_pence || 0), 0);

    // ── Refunds: from driver_wallet_ledger REFUND type (SSOT) ──
    const { data: refundRows } = await supabase
      .from('driver_wallet_ledger')
      .select('amount_pence')
      .eq('type', 'REFUND');

    const totalRefunds = (refundRows || []).reduce((s, r) => s + Math.abs(Number(r.amount_pence || 0)), 0);
    const refundedTrips = (refundRows || []).length;

    // ── Payment method breakdown from trips table (operational data) ──
    const { data: methodRows } = await supabase
      .from('trips')
      .select('payment_method')
      .in('status', ['completed', 'no_show', 'cancelled'])
      .not('payment_method', 'is', null);

    const paymentMethods: Record<string, number> = {};
    for (const row of methodRows || []) {
      const method = (row.payment_method || 'unknown').toLowerCase();
      paymentMethods[method] = (paymentMethods[method] || 0) + 1;
    }

    const response = {
      // Unified financial summary (100% from driver_wallet_ledger via driver_financial_summary)
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
      refundedTrips,
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
