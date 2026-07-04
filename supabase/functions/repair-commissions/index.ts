import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateCommission } from "../_shared/commission.ts";
import { resolveCurrencyFromTrip } from "../_shared/regionCurrency.ts";
import { buildTripAccounting } from "../_shared/tripAccounting.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * repair-commissions
 *
 * Admin-only tool that audits and repairs completed trips.
 * Writes ONLY to driver_wallet_ledger (SSOT).
 * Does NOT touch driver_ledger or trip_finance (both deprecated).
 *
 * Modes:
 *   dry_run: true  → preview corrections without writing
 *   dry_run: false → apply corrections
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
    const isServiceRole = token === supabaseServiceKey;

    if (!isServiceRole) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: roleData } = await supabase
        .from('user_roles').select('role')
        .eq('user_id', user.id).eq('role', 'admin').maybeSingle();

      if (!roleData) {
        return new Response(JSON.stringify({ error: 'Admin access required' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    const { dry_run = true, driver_id, since, until } = await req.json();

    console.log(`[repair-commissions] mode=${dry_run ? 'DRY_RUN' : 'APPLY'}, driver=${driver_id || 'all'}, since=${since || 'all'}, until=${until || 'all'}`);

    // === Fetch completed trips ===
    let query = supabase
      .from('trips')
      .select('id, driver_id, service_area_id, gross_fare_pence, final_fare_pence, airport_charge_pence, other_pass_through_charges_pence, commission_pence, driver_net_pence, payment_method, payment_status, currency_code, financial_outcome, completed_at, fare, tip_pence')
      .eq('status', 'completed')
      .not('driver_id', 'is', null);

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

    const commissionCache: Record<string, { commission_pct: number }> = {};
    const currencyCache: Record<string, string> = {};

    const corrections: Array<Record<string, unknown>> = [];
    let totalDelta = 0;
    let walletLedgerCreated = 0;
    let currencyFixed = 0;
    let outcomeFixed = 0;

    for (const trip of trips) {
      const dId = trip.driver_id;
      const finalFare = trip.final_fare_pence || trip.gross_fare_pence || 0;
      const tipPence = trip.tip_pence || 0;
      const airportPence = trip.airport_charge_pence || 0;
      const passThroughPence = trip.other_pass_through_charges_pence || 0;
      const isCash = (trip.payment_method || '').toUpperCase() === 'CASH';
      const issues: string[] = [];

      // === Resolve correct currency from Region ===
      let correctCurrency = trip.currency_code || '';
      if (trip.service_area_id) {
        if (!currencyCache[trip.service_area_id]) {
          try {
            const resolved = await resolveCurrencyFromTrip(supabase, trip.id);
            currencyCache[trip.service_area_id] = resolved.currency_code;
          } catch (e) {
            console.warn(`[repair-commissions] Currency resolution failed for trip ${trip.id}:`, e);
          }
        }
        if (currencyCache[trip.service_area_id]) {
          correctCurrency = currencyCache[trip.service_area_id];
        }
      }

      const currencyMismatch = trip.currency_code !== correctCurrency;
      if (currencyMismatch) issues.push(`currency: ${trip.currency_code} → ${correctCurrency}`);

      // === Check financial_outcome ===
      const missingOutcome = !trip.financial_outcome;
      if (missingOutcome) issues.push('missing financial_outcome');

      // === Check commission ===
      const commissionCacheKey = `${dId}:${trip.service_area_id ?? 'unknown'}`;
      if (!commissionCache[commissionCacheKey]) {
        try {
          const result = await calculateCommission(supabase, dId, 10000, trip.service_area_id);
          commissionCache[commissionCacheKey] = { commission_pct: result.commission_pct };
        } catch {
          console.warn(`[repair-commissions] Could not get commission for driver ${dId} SA ${trip.service_area_id}, skipping`);
          continue;
        }
      }

      const correctPct = commissionCache[commissionCacheKey].commission_pct;
      const recomputed = await calculateCommission(supabase, dId, finalFare, trip.service_area_id);
      const correctCommission = recomputed.commission_pence;
      const correctNet = recomputed.driver_net_pence;
      const oldCommission = trip.commission_pence || 0;
      const oldDriverNet = trip.driver_net_pence || 0;
      const commissionDelta = correctCommission - oldCommission;

      if (commissionDelta !== 0) issues.push(`commission: ${oldCommission} → ${correctCommission}`);
      if (oldDriverNet !== correctNet) issues.push(`driver_net: ${oldDriverNet} → ${correctNet}`);

      // === Check for missing driver_wallet_ledger entries (SSOT) ===
      const { data: existingWalletEntries } = await supabase
        .from('driver_wallet_ledger')
        .select('id, type')
        .eq('related_trip_id', trip.id)
        .in('type', ['CASH_COMMISSION_DEBT', 'TRIP_EARNING_NET', 'CASH_TRIP_EARNING', 'PLATFORM_COMMISSION']);

      const walletTypes = new Set((existingWalletEntries || []).map(e => e.type));
      const missingWalletEntries: string[] = [];

      if (isCash) {
        if (!walletTypes.has('CASH_COMMISSION_DEBT') && correctCommission > 0) missingWalletEntries.push('CASH_COMMISSION_DEBT');
        if (!walletTypes.has('CASH_TRIP_EARNING')) missingWalletEntries.push('CASH_TRIP_EARNING');
        if (!walletTypes.has('PLATFORM_COMMISSION') && correctCommission > 0) missingWalletEntries.push('PLATFORM_COMMISSION');
      } else {
        if (!walletTypes.has('TRIP_EARNING_NET') && correctNet > 0) missingWalletEntries.push('TRIP_EARNING_NET');
        if (!walletTypes.has('PLATFORM_COMMISSION') && correctCommission > 0) missingWalletEntries.push('PLATFORM_COMMISSION');
      }

      if (missingWalletEntries.length > 0) issues.push(`missing wallet_ledger: ${missingWalletEntries.join(', ')}`);

      // Skip if nothing to fix
      if (issues.length === 0) continue;

      corrections.push({
        trip_id: trip.id,
        driver_id: dId,
        gross_fare_pence: recomputed.commissionable_fare_pence,
        old_commission_pence: oldCommission,
        correct_commission_pence: correctCommission,
        correct_driver_net_pence: correctNet,
        commission_pct: correctPct,
        delta_pence: commissionDelta,
        payment_method: trip.payment_method,
        completed_at: trip.completed_at,
        issues,
      });

      totalDelta += commissionDelta;

      // === Apply corrections ===
      if (!dry_run) {
        // 1. Update trip record
        const tripUpdate: Record<string, unknown> = {
          commission_pence: correctCommission,
          driver_net_pence: correctNet,
          updated_at: new Date().toISOString(),
        };

        if (missingOutcome) {
          tripUpdate.financial_outcome = 'COMPLETED';
          outcomeFixed++;
        }
        if (currencyMismatch) {
          tripUpdate.currency_code = correctCurrency;
          currencyFixed++;
        }

        await supabase.from('trips').update(tripUpdate).eq('id', trip.id);

        // 2. Backfill missing driver_wallet_ledger entries
        for (const missingType of missingWalletEntries) {
          let amount = 0;
          let desc = '';

          switch (missingType) {
            case 'CASH_COMMISSION_DEBT':
              amount = -correctCommission;
              desc = 'Cash trip commission owed to platform (repaired)';
              break;
            case 'CASH_TRIP_EARNING':
              amount = grossFare;
              desc = 'Cash trip gross fare collected (repaired)';
              break;
            case 'TRIP_EARNING_NET':
              amount = correctNet;
              desc = 'Trip earnings net (repaired)';
              break;
            case 'PLATFORM_COMMISSION':
              amount = correctCommission;
              desc = 'Platform commission (repaired)';
              break;
          }

          const { error: insertErr } = await supabase.from('driver_wallet_ledger').insert({
            driver_id: dId,
            related_trip_id: trip.id,
            type: missingType,
            amount_pence: amount,
            currency: correctCurrency,
            description: desc,
          });

          if (insertErr) {
            console.error(`[repair-commissions] wallet_ledger insert error for ${trip.id}/${missingType}:`, insertErr);
          } else {
            walletLedgerCreated++;
          }
        }
      }
    }

    console.log(`[repair-commissions] Found ${corrections.length} issues in ${trips.length} trips`);

    return new Response(JSON.stringify({
      mode: dry_run ? 'dry_run' : 'applied',
      total_trips_checked: trips.length,
      corrections_count: corrections.length,
      total_commission_delta_pence: totalDelta,
      wallet_ledger_entries_created: dry_run ? 'N/A (dry run)' : walletLedgerCreated,
      currency_codes_fixed: dry_run ? 'N/A (dry run)' : currencyFixed,
      financial_outcomes_fixed: dry_run ? 'N/A (dry run)' : outcomeFixed,
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
