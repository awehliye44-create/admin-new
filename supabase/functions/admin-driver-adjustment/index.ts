import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveCurrencyFromTrip, resolveCurrencyFromDriver } from "../_shared/regionCurrency.ts";

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
      .from('profiles')
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

    const { 
      driver_id, 
      amount_pence, 
      entry_type = 'ADJUSTMENT',
      reason,
      trip_id,
    } = await req.json();

    if (!driver_id || amount_pence === undefined) {
      return new Response(JSON.stringify({ error: 'driver_id and amount_pence are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validate entry type
    const validTypes = ['ADJUSTMENT', 'BONUS', 'REFUND_DEBIT', 'CASHOUT_FEE'];
    if (!validTypes.includes(entry_type)) {
      return new Response(JSON.stringify({ error: 'Invalid entry_type' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify driver exists
    const { data: driver, error: driverError } = await supabase
      .from('drivers')
      .select('id, first_name, last_name')
      .eq('id', driver_id)
      .single();

    if (driverError || !driver) {
      return new Response(JSON.stringify({ error: 'Driver not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === Resolve currency from Region (single source of truth) ===
    let currency_code: string;
    try {
      const regionCurrency = await resolveCurrencyFromDriver(supabase, driver_id);
      currency_code = regionCurrency.currency_code;
    } catch (e) {
      console.error('[admin-driver-adjustment] Currency resolution failed:', e);
      return new Response(JSON.stringify({ error: (e as Error).message, error_code: 'REGION_CURRENCY_UNRESOLVABLE' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Create ledger entry
    const { data: ledgerEntry, error: ledgerError } = await supabase
      .from('driver_ledger')
      .insert({
        driver_id,
        entry_type,
        amount_pence,
        currency_code,
        description: reason || `${entry_type} by admin`,
        trip_id: trip_id || null,
        reference_id: `admin_${user.id}_${Date.now()}`,
      })
      .select()
      .single();

    if (ledgerError) {
      throw ledgerError;
    }

    // Get updated live wallet totals from ledger
    const { data: walletLedgerEntries } = await supabase
      .from('driver_ledger')
      .select('entry_type, amount_pence')
      .eq('driver_id', driver_id);

    return new Response(JSON.stringify({
      success: true,
      ledgerEntry: {
        id: ledgerEntry.id,
        type: ledgerEntry.entry_type,
        amount: ledgerEntry.amount_pence,
        description: ledgerEntry.description,
        createdAt: ledgerEntry.created_at,
        currency_code,
      },
      wallet: {
        available: walletLedgerEntries?.reduce((sum, entry) => {
          if (entry.entry_type === 'COMPANY_COMMISSION') return sum;
          return sum + (entry.amount_pence || 0);
        }, 0) || 0,
        debt: walletLedgerEntries?.reduce((sum, entry) => {
          if (entry.entry_type !== 'CASH_COMMISSION_DEBT') return sum;
          return sum + Math.abs(entry.amount_pence || 0);
        }, 0) || 0,
        earnings: walletLedgerEntries?.reduce((sum, entry) => {
          if (entry.entry_type === 'COMPANY_COMMISSION') return sum;
          const amount = entry.amount_pence || 0;
          return amount > 0 ? sum + amount : sum;
        }, 0) || 0,
      },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in admin-driver-adjustment:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
