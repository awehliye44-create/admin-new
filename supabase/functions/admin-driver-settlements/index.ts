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
    const search = url.searchParams.get('search');
    const status = url.searchParams.get('status'); // 'online', 'offline', 'all'

    // Get summary stats first
    const { data: allDrivers } = await supabase
      .from('drivers')
      .select('id, is_online');

    const onlineDrivers = allDrivers?.filter(d => d.is_online).length || 0;

    // Get total earnings and commission from completed trips
    const { data: tripStats } = await supabase
      .from('trips')
      .select('driver_net_pence, commission_pence')
      .eq('status', 'completed');

    const totalDriverEarnings = tripStats?.reduce((sum, t) => sum + (t.driver_net_pence || 0), 0) || 0;
    const totalPlatformCommission = tripStats?.reduce((sum, t) => sum + (t.commission_pence || 0), 0) || 0;

    // Get wallet balances
    const { data: walletBalances } = await supabase
      .from('driver_wallet_balance')
      .select('*');

    const driversWithEarnings = walletBalances?.filter(w => 
      w.total_earnings_pence > 0 || w.total_debt_pence > 0
    ).length || 0;

    // Build drivers query
    const offset = (page - 1) * limit;
    let driversQuery = supabase
      .from('drivers')
      .select(`
        id,
        first_name,
        last_name,
        email,
        phone,
        is_online,
        rating,
        total_trips,
        stripe_account_id,
        payouts_enabled,
        charges_enabled,
        onboarding_complete,
        approval_status,
        created_at
      `, { count: 'exact' })
      .order('created_at', { ascending: false });

    if (status === 'online') {
      driversQuery = driversQuery.eq('is_online', true);
    } else if (status === 'offline') {
      driversQuery = driversQuery.eq('is_online', false);
    }

    if (search) {
      driversQuery = driversQuery.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    driversQuery = driversQuery.range(offset, offset + limit - 1);

    const { data: drivers, count, error: driversError } = await driversQuery;

    if (driversError) {
      throw driversError;
    }

    // Get trip stats and wallet data for each driver
    const driverIds = drivers?.map(d => d.id) || [];

    // Get trip totals per driver
    const { data: driverTripStats } = await supabase
      .from('trips')
      .select('driver_id, gross_fare_pence, commission_pence, driver_net_pence')
      .eq('status', 'completed')
      .in('driver_id', driverIds);

    // Group trip stats by driver
    const tripStatsByDriver: Record<string, { 
      totalGross: number; 
      totalCommission: number; 
      totalNet: number;
      tripCount: number;
    }> = {};
    
    driverTripStats?.forEach(trip => {
      if (!trip.driver_id) return;
      if (!tripStatsByDriver[trip.driver_id]) {
        tripStatsByDriver[trip.driver_id] = { 
          totalGross: 0, 
          totalCommission: 0, 
          totalNet: 0,
          tripCount: 0 
        };
      }
      tripStatsByDriver[trip.driver_id].totalGross += trip.gross_fare_pence || 0;
      tripStatsByDriver[trip.driver_id].totalCommission += trip.commission_pence || 0;
      tripStatsByDriver[trip.driver_id].totalNet += trip.driver_net_pence || 0;
      tripStatsByDriver[trip.driver_id].tripCount += 1;
    });

    // Create wallet balance map
    const walletByDriver: Record<string, { 
      available: number; 
      debt: number; 
      earnings: number 
    }> = {};
    
    walletBalances?.forEach(w => {
      walletByDriver[w.driver_id] = {
        available: w.available_pence || 0,
        debt: w.total_debt_pence || 0,
        earnings: w.total_earnings_pence || 0,
      };
    });

    // Transform drivers data
    const transformedDrivers = drivers?.map(d => {
      const tripStats = tripStatsByDriver[d.id] || { 
        totalGross: 0, 
        totalCommission: 0, 
        totalNet: 0,
        tripCount: 0 
      };
      const wallet = walletByDriver[d.id] || { available: 0, debt: 0, earnings: 0 };

      return {
        id: d.id,
        name: `${d.first_name} ${d.last_name}`,
        email: d.email,
        phone: d.phone,
        isOnline: d.is_online,
        rating: d.rating,
        totalTrips: d.total_trips || tripStats.tripCount,
        approvalStatus: d.approval_status,
        stripeAccountId: d.stripe_account_id,
        payoutsEnabled: d.payouts_enabled,
        chargesEnabled: d.charges_enabled,
        onboardingComplete: d.onboarding_complete,
        totalGross: tripStats.totalGross,
        totalCommission: tripStats.totalCommission,
        totalNet: tripStats.totalNet,
        walletAvailable: wallet.available,
        walletDebt: wallet.debt,
        walletEarnings: wallet.earnings,
        canPayout: wallet.available > 0 && d.payouts_enabled,
      };
    }) || [];

    const response = {
      summary: {
        totalDriverEarnings,
        totalPlatformCommission,
        driversWithEarnings,
        onlineDrivers,
        totalDrivers: allDrivers?.length || 0,
      },
      drivers: transformedDrivers,
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in admin-driver-settlements:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
