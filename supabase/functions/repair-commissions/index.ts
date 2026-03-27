import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateCommission } from "../_shared/commission.ts";
import { resolveCurrencyFromTrip } from "../_shared/regionCurrency.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * repair-commissions
 *
 * Admin-only tool to repair completed trips that are missing:
 *   1. financial_outcome (should be 'COMPLETED')
 *   2. driver_ledger entries (CASH_COMMISSION_DEBT for cash trips)
 *   3. trip_finance records
 *   4. Incorrect currency_code (should match Region)
 *   5. Incorrect commission amounts
 *
 * Modes:
 *   dry_run: true  → preview corrections without writing
 *   dry_run: false → apply corrections and create missing records
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

    // Check if using service role key (for server-to-server calls)
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
        const { data: profileRole } = await supabase
          .from('profiles').select('role')
          .eq('user_id', user.id).eq('role', 'admin').maybeSingle();

        if (!profileRole) {
          return new Response(JSON.stringify({ error: 'Admin access required' }), {
            status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
    }

    const { dry_run = true, driver_id, since, until } = await req.json();

    console.log(`[repair-commissions] mode=${dry_run ? 'DRY_RUN' : 'APPLY'}, driver=${driver_id || 'all'}, since=${since || 'all'}, until=${until || 'all'}`);

    // === Fetch completed trips ===
    let query = supabase
      .from('trips')
      .select('id, driver_id, service_area_id, gross_fare_pence, commission_pence, driver_net_pence, payment_method, payment_status, currency_code, financial_outcome, completed_at, fare')
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

    // Cache commission rates per driver
    const commissionCache: Record<string, { commission_pct: number }> = {};
    // Cache resolved currencies per trip's service_area
    const currencyCache: Record<string, string> = {};

    const corrections: Array<Record<string, unknown>> = [];
    let totalDelta = 0;
    let ledgerCreated = 0;
    let financeCreated = 0;
    let currencyFixed = 0;
    let outcomeFixed = 0;

    for (const trip of trips) {
      const dId = trip.driver_id;
      const grossFare = trip.gross_fare_pence || 0;
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
      if (!commissionCache[dId]) {
        try {
          const result = await calculateCommission(supabase, dId, 10000);
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
      const commissionDelta = correctCommission - oldCommission;

      if (commissionDelta !== 0) issues.push(`commission: ${oldCommission} → ${correctCommission}`);

      // === Check for missing driver_ledger entry ===
      const { data: existingLedger } = await supabase
        .from('driver_ledger')
        .select('id')
        .eq('trip_id', trip.id)
        .in('entry_type', ['CASH_COMMISSION_DEBT', 'TRIP_EARNING_NET'])
        .maybeSingle();

      const missingLedger = !existingLedger;
      if (missingLedger) issues.push('missing driver_ledger entry');

      // === Check for missing trip_finance record ===
      const { data: existingFinance } = await supabase
        .from('trip_finance')
        .select('id')
        .eq('trip_id', trip.id)
        .maybeSingle();

      const missingFinance = !existingFinance;
      if (missingFinance) issues.push('missing trip_finance record');

      // Skip if nothing to fix
      if (issues.length === 0) continue;

      corrections.push({
        trip_id: trip.id,
        driver_id: dId,
        gross_fare_pence: grossFare,
        old_commission_pence: oldCommission,
        correct_commission_pence: correctCommission,
        correct_driver_net_pence: correctNet,
        commission_pct: correctPct,
        delta_pence: commissionDelta,
        payment_method: trip.payment_method,
        completed_at: trip.completed_at,
        old_currency: trip.currency_code,
        correct_currency: correctCurrency,
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

        // 2. Create or update driver_ledger entry
        if (missingLedger && isCash && correctCommission > 0) {
          const { error: ledgerErr } = await supabase
            .from('driver_ledger')
            .insert({
              driver_id: dId,
              trip_id: trip.id,
              entry_type: 'CASH_COMMISSION_DEBT',
              amount_pence: -correctCommission,
              currency_code: correctCurrency,
              description: 'Cash trip commission owed to platform (repaired)',
            });

          if (ledgerErr) {
            if (ledgerErr.code === '23505') {
              console.log(`[repair-commissions] Ledger already exists for trip ${trip.id}`);
            } else {
              console.error(`[repair-commissions] Ledger insert error for trip ${trip.id}:`, ledgerErr);
            }
          } else {
            ledgerCreated++;
            console.log(`[repair-commissions] Created CASH_COMMISSION_DEBT: -${correctCommission}p for trip ${trip.id}`);
          }
        } else if (!missingLedger && commissionDelta !== 0) {
          // Update existing ledger entry
          if (isCash) {
            await supabase.from('driver_ledger').update({
              amount_pence: -correctCommission,
              description: 'Commission owed from cash trip (repaired)',
            }).eq('trip_id', trip.id).eq('entry_type', 'CASH_COMMISSION_DEBT');
          } else {
            await supabase.from('driver_ledger').update({
              amount_pence: correctNet,
              description: 'Trip earnings net (repaired)',
            }).eq('trip_id', trip.id).eq('entry_type', 'TRIP_EARNING_NET');
          }
        }

        // 3. Create missing trip_finance record
        if (missingFinance) {
          const financeRecord: Record<string, unknown> = {
            trip_id: trip.id,
            driver_id: dId,
            service_area_id: trip.service_area_id,
            financial_status: 'recognized',
            revenue_type: 'completed_trip_revenue',
            is_financially_countable: true,
            base_fare_pence: grossFare,
            commissionable_subtotal_pence: grossFare,
            commission_rate_pct: correctPct,
            platform_commission_pence: correctCommission,
            driver_net_before_tip_pence: correctNet,
            driver_total_earnings_pence: correctNet,
            final_trip_total_pence: grossFare,
            payment_method: trip.payment_method,
            currency_code: correctCurrency,
            settlement_status: 'settled',
            settled_at: trip.completed_at,
          };

          if (isCash) {
            financeRecord.stripe_processing_fee_pence = 0;
            financeRecord.debt_recovery_pence = 0;
            financeRecord.final_driver_payout_pence = 0;
          }

          const { error: financeErr } = await supabase
            .from('trip_finance')
            .insert(financeRecord);

          if (financeErr) {
            if (financeErr.code === '23505') {
              console.log(`[repair-commissions] trip_finance already exists for ${trip.id}`);
            } else {
              console.error(`[repair-commissions] trip_finance insert error for ${trip.id}:`, financeErr);
            }
          } else {
            financeCreated++;
          }
        } else if (existingFinance) {
          // Update existing trip_finance
          await supabase.from('trip_finance').update({
            commission_rate_pct: correctPct,
            platform_commission_pence: correctCommission,
            driver_net_before_tip_pence: correctNet,
            driver_total_earnings_pence: correctNet,
            currency_code: correctCurrency,
          }).eq('trip_id', trip.id);
        }
      }
    }

    console.log(`[repair-commissions] Found ${corrections.length} issues in ${trips.length} trips`);
    console.log(`[repair-commissions] Commission delta: ${totalDelta}p, Ledger created: ${ledgerCreated}, Finance created: ${financeCreated}, Currency fixed: ${currencyFixed}, Outcome fixed: ${outcomeFixed}`);

    return new Response(JSON.stringify({
      mode: dry_run ? 'dry_run' : 'applied',
      total_trips_checked: trips.length,
      corrections_count: corrections.length,
      total_commission_delta_pence: totalDelta,
      ledger_entries_created: dry_run ? 'N/A (dry run)' : ledgerCreated,
      finance_records_created: dry_run ? 'N/A (dry run)' : financeCreated,
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
