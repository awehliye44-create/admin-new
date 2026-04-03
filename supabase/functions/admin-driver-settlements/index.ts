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

    const url = new URL(req.url);
    const search = url.searchParams.get('search');
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '100');

    // Query the unified financial summary view
    let query = supabase
      .from('driver_financial_summary')
      .select('*');

    if (search) {
      query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const { data: drivers, error: queryError } = await query;

    if (queryError) throw queryError;

    const allDrivers = drivers || [];

    // Compute aggregated summary from the same view
    const summary = {
      totalDriverEarnings: allDrivers.reduce((s, d) => s + Number(d.gross_trip_total || 0), 0),
      totalDriverNet: allDrivers.reduce((s, d) => s + Number(d.card_net_credits || 0) + Number(d.cash_net_earnings || 0), 0),
      totalPlatformCommission: allDrivers.reduce((s, d) => s + Number(d.company_commission_total || 0), 0),
      driversWithEarnings: allDrivers.filter(d => Number(d.gross_trip_total || 0) > 0).length,
      onlineDrivers: allDrivers.filter(d => d.is_online).length,
      totalDrivers: allDrivers.length,
      totalWalletBalance: allDrivers.reduce((s, d) => s + Number(d.wallet_balance || 0), 0),
      totalPayoutsSent: allDrivers.reduce((s, d) => s + Number(d.total_payouts_sent || 0), 0),
    };

    // Transform to camelCase for frontend
    const transformedDrivers = allDrivers.map(d => ({
      id: d.driver_id,
      name: `${d.first_name} ${d.last_name}`,
      email: d.email,
      phone: d.phone,
      isOnline: d.is_online,
      rating: d.rating,
      approvalStatus: d.approval_status,
      stripeAccountId: d.stripe_account_id,
      payoutsEnabled: d.payouts_enabled,
      onboardingComplete: d.onboarding_complete,
      currencyCode: d.currency_code || '',
      // Trip totals
      totalTrips: Number(d.completed_trips || 0),
      totalGross: Number(d.gross_trip_total || 0),
      totalCommission: Number(d.company_commission_total || 0),
      totalNet: Number(d.card_net_credits || 0) + Number(d.cash_net_earnings || 0),
      // Wallet
      walletBalance: Number(d.wallet_balance || 0),
      availableForPayout: Number(d.available_for_payout || 0),
      amountOwed: Number(d.amount_owed_to_onecab || 0),
      totalPayoutsSent: Number(d.total_payouts_sent || 0),
      // Breakdown
      cardNetCredits: Number(d.card_net_credits || 0),
      cashCommissionDebits: Number(d.cash_commission_debits || 0),
      cashGrossTotal: Number(d.cash_gross_total || 0),
      cardGrossTotal: Number(d.card_gross_total || 0),
      canPayout: Number(d.available_for_payout || 0) > 0 && d.payouts_enabled,
    }));

    // Paginate
    const offset = (page - 1) * limit;
    const paginatedDrivers = transformedDrivers.slice(offset, offset + limit);

    return new Response(JSON.stringify({
      summary,
      drivers: paginatedDrivers,
      total: transformedDrivers.length,
      page,
      limit,
      totalPages: Math.ceil(transformedDrivers.length / limit),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in admin-driver-settlements:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});