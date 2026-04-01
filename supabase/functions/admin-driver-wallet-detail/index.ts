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
    const driverId = url.searchParams.get('driver_id');
    const period = url.searchParams.get('period') || 'all'; // 'this_week', 'last_week', 'this_month', 'all'

    if (!driverId) {
      return new Response(JSON.stringify({ error: 'driver_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get driver info
    const { data: driver, error: driverError } = await supabase
      .from('drivers')
      .select('*')
      .eq('id', driverId)
      .single();

    if (driverError || !driver) {
      return new Response(JSON.stringify({ error: 'Driver not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build live wallet totals from ledger (source of truth)
    const { data: allLedgerEntriesForWallet } = await supabase
      .from('driver_ledger')
      .select('entry_type, amount_pence')
      .eq('driver_id', driverId);

    // Get ledger entries
    let ledgerQuery = supabase
      .from('driver_ledger')
      .select('*')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false });

    // Apply period filter
    const now = new Date();
    if (period === 'this_week') {
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      ledgerQuery = ledgerQuery.gte('created_at', startOfWeek.toISOString());
    } else if (period === 'last_week') {
      const startOfLastWeek = new Date(now);
      startOfLastWeek.setDate(now.getDate() - now.getDay() - 7);
      startOfLastWeek.setHours(0, 0, 0, 0);
      const endOfLastWeek = new Date(startOfLastWeek);
      endOfLastWeek.setDate(endOfLastWeek.getDate() + 7);
      ledgerQuery = ledgerQuery.gte('created_at', startOfLastWeek.toISOString())
        .lt('created_at', endOfLastWeek.toISOString());
    } else if (period === 'this_month') {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      ledgerQuery = ledgerQuery.gte('created_at', startOfMonth.toISOString());
    }

    const { data: ledgerEntries, error: ledgerError } = await ledgerQuery.limit(100);

    if (ledgerError) {
      console.error('Ledger query error:', ledgerError);
    }

    // Calculate period summary
    const periodSummary = {
      earnings: 0,
      debts: 0,
      payouts: 0,
      adjustments: 0,
      fees: 0,
    };

    ledgerEntries?.forEach(entry => {
      const amount = entry.amount_pence || 0;
      switch (entry.entry_type) {
        case 'TRIP_EARNING_NET':
          periodSummary.earnings += amount;
          break;
        case 'CASH_COMMISSION_DEBT':
          periodSummary.debts += Math.abs(amount);
          break;
        case 'WEEKLY_PAYOUT':
        case 'EARLY_CASHOUT':
        case 'MANUAL_PAYOUT':
          periodSummary.payouts += Math.abs(amount);
          break;
        case 'ADJUSTMENT':
        case 'BONUS':
          periodSummary.adjustments += amount;
          break;
        case 'CASHOUT_FEE':
        case 'REFUND_DEBIT':
          periodSummary.fees += Math.abs(amount);
          break;
      }
    });

    // Get payout history
    const { data: payoutItems } = await supabase
      .from('payout_items')
      .select(`
        *,
        payout_batches:batch_id (
          id,
          kind,
          run_date,
          status
        )
      `)
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false })
      .limit(20);

    // Get cashout settings
    const { data: settings } = await supabase
      .from('admin_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['early_cashout_fee_pence', 'payouts_enabled']);

    const settingsMap: Record<string, string> = {};
    settings?.forEach(s => {
      settingsMap[s.setting_key] = s.setting_value as string;
    });

    const earlyCashoutFee = parseInt(settingsMap.early_cashout_fee_pence || '50');
    const globalPayoutsEnabled = settingsMap.payouts_enabled !== 'false';

    // Exclude COMPANY_COMMISSION from wallet balance — it's platform revenue tracking, not driver funds
    const available = allLedgerEntriesForWallet?.reduce((sum, entry) => {
      if (entry.entry_type === 'COMPANY_COMMISSION') return sum;
      return sum + (entry.amount_pence || 0);
    }, 0) || 0;
    const earnings = allLedgerEntriesForWallet?.reduce((sum, entry) => {
      if (entry.entry_type === 'COMPANY_COMMISSION') return sum;
      const amount = entry.amount_pence || 0;
      return amount > 0 ? sum + amount : sum;
    }, 0) || 0;
    const debt = allLedgerEntriesForWallet?.reduce((sum, entry) => {
      if (entry.entry_type !== 'CASH_COMMISSION_DEBT') return sum;
      return sum + Math.abs(entry.amount_pence || 0);
    }, 0) || 0;

    const response = {
      driver: {
        id: driver.id,
        name: `${driver.first_name} ${driver.last_name}`,
        email: driver.email,
        phone: driver.phone,
        isOnline: driver.is_online,
        rating: driver.rating,
        totalTrips: driver.total_trips,
        stripeAccountId: driver.stripe_account_id,
        payoutsEnabled: driver.payouts_enabled,
        chargesEnabled: driver.charges_enabled,
        onboardingComplete: driver.onboarding_complete,
        approvalStatus: driver.approval_status,
      },
      wallet: {
        available,
        debt,
        earnings,
        canPayout: available > 0 && driver.payouts_enabled && globalPayoutsEnabled,
        canEarlyCashout: available > earlyCashoutFee && driver.payouts_enabled && globalPayoutsEnabled,
      },
      periodSummary,
      ledgerEntries: ledgerEntries?.map(e => ({
        id: e.id,
        type: e.entry_type,
        amount: e.amount_pence,
        currency: e.currency_code,
        description: e.description,
        tripId: e.trip_id,
        referenceId: e.reference_id,
        createdAt: e.created_at,
      })) || [],
      payoutHistory: payoutItems?.map(p => ({
        id: p.id,
        amount: p.amount_pence,
        status: p.status,
        stripeTransferId: p.stripe_transfer_id,
        stripePayoutId: p.stripe_payout_id,
        errorMessage: p.error_message,
        createdAt: p.created_at,
        completedAt: p.completed_at,
        batch: p.payout_batches,
      })) || [],
      settings: {
        earlyCashoutFee,
        globalPayoutsEnabled,
      },
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in admin-driver-wallet-detail:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
