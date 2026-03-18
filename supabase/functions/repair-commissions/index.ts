import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateCommission } from "../_shared/commission.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * repair-commissions
 *
 * Admin-only tool to recalculate commission on completed trips
 * that may have been computed with wrong/hardcoded rates.
 *
 * Modes:
 *   dry_run: true  → preview corrections without writing
 *   dry_run: false → apply corrections and fix ledger entries
 *
 * Optional filters:
 *   driver_id   — limit to a single driver
 *   since       — ISO date, only trips completed on or after
 *   until       — ISO date, only trips completed before
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // === Auth: verify admin ===
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
      .from('profiles').select('role')
      .eq('user_id', user.id).eq('role', 'admin').single();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { dry_run = true, driver_id, since, until } = await req.json();

    console.log(`[repair-commissions] mode=${dry_run ? 'DRY_RUN' : 'APPLY'}, driver=${driver_id || 'all'}, since=${since || 'all'}, until=${until || 'all'}`);

    // === Fetch completed trips ===
    let query = supabase
      .from('trips')
      .select('id, driver_id, gross_fare_pence, commission_pence, driver_net_pence, payment_method, completed_at')
      .eq('status', 'completed')
      .not('driver_id', 'is', null)
      .gt('gross_fare_pence', 0);

    if (driver_id) query = query.eq('driver_id', driver_id);
    if (since) query = query.gte('completed_at', since);
    if (until) query = query.lt('completed_at', until);

    const { data: trips, error: tripsError } = await query.order('completed_at', { ascending: true }).limit(500);

    if (tripsError) {
      return new Response(JSON.stringify({ error: 'Failed to fetch trips', details: tripsError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!trips || trips.length === 0) {
      return new Response(JSON.stringify({ message: 'No trips found matching criteria', corrections: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Cache commission rates per driver to avoid repeated lookups
    const commissionCache: Record<string, { commission_pct: number }> = {};
    const corrections: Array<Record<string, unknown>> = [];
    let totalDelta = 0;

    for (const trip of trips) {
      const dId = trip.driver_id;
      const grossFare = trip.gross_fare_pence || 0;

      // Get correct commission
      if (!commissionCache[dId]) {
        try {
          const result = await calculateCommission(supabase, dId, 10000); // dummy amount just to get pct
          commissionCache[dId] = { commission_pct: result.commission_pct };
        } catch {
          console.warn(`[repair-commissions] Could not get commission for driver ${dId}, skipping`);
          continue;
        }
      }

      const correctPct = commissionCache[dId].commission_pct;
      const correctCommission = Math.round(grossFare * correctPct / 100);
      const correctNet = grossFare - correctCommission;
      const oldCommission = trip.commission_pence || 0;
      const delta = correctCommission - oldCommission;

      if (delta === 0) continue;

      corrections.push({
        trip_id: trip.id,
        driver_id: dId,
        gross_fare_pence: grossFare,
        old_commission_pence: oldCommission,
        correct_commission_pence: correctCommission,
        old_driver_net_pence: trip.driver_net_pence,
        correct_driver_net_pence: correctNet,
        commission_pct: correctPct,
        delta_pence: delta,
        payment_method: trip.payment_method,
        completed_at: trip.completed_at,
      });

      totalDelta += delta;

      // === Apply corrections ===
      if (!dry_run) {
        // Update trip record
        await supabase.from('trips').update({
          commission_pence: correctCommission,
          driver_net_pence: correctNet,
          updated_at: new Date().toISOString(),
        }).eq('id', trip.id);

        // Update trip_finance if exists
        await supabase.from('trip_finance').update({
          commission_rate_pct: correctPct,
          platform_commission_pence: correctCommission,
          driver_net_before_tip_pence: correctNet,
          driver_total_earnings_pence: correctNet, // tip excluded from gross_fare so net = total here
        }).eq('trip_id', trip.id);

        // Fix ledger entries
        const isCash = (trip.payment_method || '').toUpperCase() === 'CASH';

        if (isCash) {
          // Update CASH_COMMISSION_DEBT amount
          await supabase.from('driver_ledger').update({
            amount_pence: -correctCommission,
            description: `Commission owed from cash trip (repaired)`,
          }).eq('trip_id', trip.id).eq('entry_type', 'CASH_COMMISSION_DEBT');
        } else {
          // Update TRIP_EARNING_NET amount
          await supabase.from('driver_ledger').update({
            amount_pence: correctNet,
            description: `Trip earnings net (repaired)`,
          }).eq('trip_id', trip.id).eq('entry_type', 'TRIP_EARNING_NET');
        }
      }
    }

    console.log(`[repair-commissions] Found ${corrections.length} corrections out of ${trips.length} trips, total delta: ${totalDelta}p`);

    return new Response(JSON.stringify({
      mode: dry_run ? 'dry_run' : 'applied',
      total_trips_checked: trips.length,
      corrections_count: corrections.length,
      total_commission_delta_pence: totalDelta,
      corrections,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[repair-commissions] Error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
