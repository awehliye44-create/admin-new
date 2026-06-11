// Canonical admin finance summary — single source of truth for:
//   1. Total customer revenue (payments.captured_amount_pence)
//   2. ONECAB gross commission (driver_wallet_ledger PLATFORM_COMMISSION)
//   3. Stripe processing fees (trips.stripe_processing_fee_pence)
//   4. ONECAB net commission (#2 - #3)
//   5. Driver net earnings (ledger TRIP_EARNING_NET + DRIVER_TIP_CREDIT + ADJUSTMENT)
//   6. Stripe platform balance (live, never used as commission)
//   7. Driver payout liability (Σ driver_wallets.available_pence + pending_pence)
//   8. Driver available payout (Σ driver_financial_summary.net_available_for_payout)
//   9. Driver pending payout (Σ driver_wallets.pending_pence)
// Plus commission_status, validation_warnings, and currency_code grouping.
//
// HARD RULE: ONECAB commission is NEVER `stripe_balance - driver_payable`.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type CommissionStatus =
  | 'stripe_confirmed'
  | 'stripe_paid_out'
  | 'calculated_pending'
  | 'legacy_fallback';

interface CurrencyGroup {
  currency_code: string;
  totals: {
    customer_revenue_pence: number;
    onecab_gross_commission_pence: number;
    stripe_fees_pence: number;
    onecab_net_commission_pence: number;
    driver_net_earnings_pence: number;
    driver_payout_liability_pence: number;
    driver_available_payout_pence: number;
    driver_pending_payout_pence: number;
    commissionable_revenue_pence: number;
  };
  commission_status: CommissionStatus;
  validation_warnings: string[];
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Auth: admin only (role from user_roles, never profiles) ──
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Unauthorized', error_code: 'AUTH_MISSING' }, 401);
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', ''),
    );
    if (authError || !user) {
      return json({ error: 'Unauthorized', error_code: 'AUTH_INVALID' }, 401);
    }
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .maybeSingle();
    if (!roleData) {
      return json({ error: 'Admin access required', error_code: 'ROLE_FORBIDDEN' }, 403);
    }

    // Optional ?region_id= filter (same pattern as other admin finance fns)
    const url = new URL(req.url);
    const regionFilter = url.searchParams.get('region_id') || null;

    // ── 1. Customer revenue: captured payments ──
    let paymentsQuery = supabase
      .from('payments')
      .select('captured_amount_pence, currency, status')
      .in('status', ['captured', 'succeeded', 'confirmed']);
    const { data: paymentRows, error: payErr } = await paymentsQuery;
    if (payErr) throw new Error(`payments: ${payErr.message}`);

    // ── 2. Trips: stripe fees + commissionable fares (for tier-cap validation) ──
    let tripsQuery = supabase
      .from('trips')
      .select('stripe_processing_fee_pence, commissionable_fare_pence, commission_pence, currency_code, region_id, status')
      .in('status', ['completed', 'no_show']);
    if (regionFilter) tripsQuery = tripsQuery.eq('region_id', regionFilter);
    const { data: tripRows, error: tripErr } = await tripsQuery;
    if (tripErr) throw new Error(`trips: ${tripErr.message}`);

    // ── 3. Ledger SOT (commission + driver net + tips + adjustments) ──
    const { data: ledgerRows, error: ledgerErr } = await supabase
      .from('driver_wallet_ledger')
      .select('amount_pence, type, currency, stripe_payout_id, stripe_transfer_id');
    if (ledgerErr) throw new Error(`ledger: ${ledgerErr.message}`);

    // ── 4. Driver financial summary view (region-aware, currency-aware) ──
    let summaryQuery = supabase
      .from('driver_financial_summary')
      .select('region_id, currency_code, wallet_balance, net_available_for_payout, reserved_cashout_pence');
    if (regionFilter) summaryQuery = summaryQuery.eq('region_id', regionFilter);
    const { data: summaryRows, error: sumErr } = await summaryQuery;
    if (sumErr) throw new Error(`driver_financial_summary: ${sumErr.message}`);

    // ── 5. Driver wallets — pending payout component ──
    const { data: walletRows, error: walletErr } = await supabase
      .from('driver_wallets')
      .select('available_pence, pending_pence');
    if (walletErr) throw new Error(`driver_wallets: ${walletErr.message}`);

    // ── 6. Max tier % for validation ──
    const { data: tierRows } = await supabase
      .from('driver_categories')
      .select('commission_pct');
    const maxTierPct = Math.max(
      0,
      ...(tierRows || []).map((r) => Number(r.commission_pct || 0)),
    );

    // ── 7. Stripe platform balance (live) — never used as commission ──
    let stripeBalance: { available_pence: number; pending_pence: number; source: 'stripe_api' | 'unavailable' } = {
      available_pence: 0,
      pending_pence: 0,
      source: 'unavailable',
    };
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (stripeKey) {
      try {
        const stripe = new Stripe(stripeKey, { apiVersion: '2024-11-20.acacia' });
        const bal = await stripe.balance.retrieve();
        const sum = (arr: { amount: number }[] | undefined) =>
          (arr || []).reduce((s, b) => s + Number(b.amount || 0), 0);
        stripeBalance = {
          available_pence: sum(bal.available),
          pending_pence: sum(bal.pending),
          source: 'stripe_api',
        };
      } catch (e) {
        console.warn('Stripe balance unavailable:', (e as Error).message);
      }
    }

    // ── Group by currency_code (mixed-currency safe) ──
    const buckets = new Map<string, CurrencyGroup>();
    const ensure = (cc: string): CurrencyGroup => {
      const key = (cc || '').toUpperCase() || 'UNKNOWN';
      let g = buckets.get(key);
      if (!g) {
        g = {
          currency_code: key,
          totals: {
            customer_revenue_pence: 0,
            onecab_gross_commission_pence: 0,
            stripe_fees_pence: 0,
            onecab_net_commission_pence: 0,
            driver_net_earnings_pence: 0,
            driver_payout_liability_pence: 0,
            driver_available_payout_pence: 0,
            driver_pending_payout_pence: 0,
            commissionable_revenue_pence: 0,
          },
          commission_status: 'legacy_fallback',
          validation_warnings: [],
        };
        buckets.set(key, g);
      }
      return g;
    };

    for (const p of paymentRows || []) {
      ensure(p.currency).totals.customer_revenue_pence += Number(p.captured_amount_pence || 0);
    }
    for (const t of tripRows || []) {
      const g = ensure(t.currency_code);
      g.totals.stripe_fees_pence += Number(t.stripe_processing_fee_pence || 0);
      g.totals.commissionable_revenue_pence += Number(t.commissionable_fare_pence || 0);
    }
    for (const l of ledgerRows || []) {
      const g = ensure(l.currency);
      const amt = Number(l.amount_pence || 0);
      switch (l.type) {
        case 'PLATFORM_COMMISSION':
          g.totals.onecab_gross_commission_pence += amt;
          if (l.stripe_payout_id) g.commission_status = 'stripe_paid_out';
          else if (l.stripe_transfer_id && g.commission_status === 'legacy_fallback') g.commission_status = 'stripe_confirmed';
          break;
        case 'TRIP_EARNING_NET':
        case 'DRIVER_TIP_CREDIT':
        case 'ADJUSTMENT':
          if (amt > 0) g.totals.driver_net_earnings_pence += amt;
          break;
      }
    }
    for (const s of summaryRows || []) {
      const g = ensure(s.currency_code);
      g.totals.driver_payout_liability_pence += Math.max(0, Number(s.wallet_balance || 0));
      g.totals.driver_available_payout_pence += Math.max(0, Number(s.net_available_for_payout || 0));
    }
    // pending payout = driver_wallets.pending_pence (currency missing → bucket into UNKNOWN or sum globally)
    const totalPending = (walletRows || []).reduce((s, w) => s + Math.max(0, Number(w.pending_pence || 0)), 0);
    if (buckets.size === 1) {
      // Single-currency setup — attribute pending to it
      const only = Array.from(buckets.values())[0];
      only.totals.driver_pending_payout_pence = totalPending;
    }

    // ── Derive net commission + status + validation per bucket ──
    for (const g of buckets.values()) {
      g.totals.onecab_net_commission_pence =
        g.totals.onecab_gross_commission_pence - g.totals.stripe_fees_pence;

      if (g.totals.onecab_gross_commission_pence > 0 && g.commission_status === 'legacy_fallback') {
        g.commission_status = 'calculated_pending';
      }

      if (
        maxTierPct > 0 &&
        g.totals.commissionable_revenue_pence > 0 &&
        g.totals.onecab_gross_commission_pence >
          Math.round((g.totals.commissionable_revenue_pence * maxTierPct) / 100)
      ) {
        g.validation_warnings.push(
          'Commission exceeds allowed tier cap — calculation mismatch.',
        );
      }
    }

    return json({
      max_tier_pct: maxTierPct,
      stripe_platform_balance: stripeBalance,
      currencies: Array.from(buckets.values()).sort((a, b) =>
        a.currency_code.localeCompare(b.currency_code),
      ),
    }, 200);
  } catch (error) {
    console.error('admin-finance-summary error:', error);
    return json({ error: (error as Error).message, error_code: 'FINANCE_SUMMARY_FAILED' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
