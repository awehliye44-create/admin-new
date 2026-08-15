import { createClient } from "npm:@supabase/supabase-js@2";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";
import { fetchDriverPayoutEligibility } from "../_shared/fetchDriverPayoutEligibility.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

function londonDateString(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function mondayOfWeek(d: Date): string {
  const today = londonDateString(d);
  const day = new Date(`${today}T00:00:00Z`);
  const dow = day.getUTCDay();
  const mondayOffset = dow === 0 ? 6 : dow - 1;
  day.setUTCDate(day.getUTCDate() - mondayOffset);
  return day.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isValidDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * driver-earnings-summary — period earnings from Driver Wallet Ledger.
 * Available / Pending come from the same payout-eligibility SSOT as Admin DWL.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const auth = await requireAuthenticatedUser(req, supabaseUrl, supabaseAnonKey);
    if (!auth.ok) {
      console.log('EARNINGS_SUMMARY_FETCH_FAILED', JSON.stringify({ reason: 'invalid_token' }));
      // Inject CORS headers to auth fail response if not present
      const response = auth.response;
      for (const [k, v] of Object.entries(corsHeaders)) {
        response.headers.set(k, v);
      }
      return response;
    }
    const userId = auth.userId;

    let body: Record<string, unknown> = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch {
      // empty body is fine — use defaults
    }

    const now = new Date();
    const todayDateStr = londonDateString(now);
    const currentMonday = mondayOfWeek(now);

    let weekDateStr = currentMonday;
    if (typeof body.week_start === 'string' && isValidDateStr(body.week_start)) {
      weekDateStr = body.week_start;
    }

    const weekEndDateStr = addDays(weekDateStr, 6);

    let monthDateStr = `${weekDateStr.slice(0, 7)}-01`;
    if (typeof body.month === 'string' && /^\d{4}-\d{2}$/.test(body.month)) {
      monthDateStr = `${body.month}-01`;
    }

    const ledgerQueryStart = weekDateStr < monthDateStr ? weekDateStr : monthDateStr;

    // Get driver with region info for currency — single join
    const { data: driver } = await supabase
      .from('drivers')
      .select('id, region_id, regions(currency_code)')
      .eq('user_id', userId)
      .maybeSingle();

    if (!driver) {
      const emptyResponse = {
        currency_code: '',
        available_pence: 0, pending_pence: 0, lifetime_earned_pence: 0,
        today_earnings_pence: 0, week_earnings_pence: 0, month_earnings_pence: 0,
        today_card_earnings_pence: 0, today_cash_earnings_pence: 0,
        week_card_earnings_pence: 0, week_cash_earnings_pence: 0,
        month_card_earnings_pence: 0, month_cash_earnings_pence: 0,
        today_tips_pence: 0, week_tips_pence: 0, month_tips_pence: 0,
        today_trips: 0, week_trips: 0, month_trips: 0,
        today_hours: 0, week_hours: 0, month_hours: 0,
        daily_breakdown: [],
        week_start: weekDateStr,
        week_end: weekEndDateStr,
        month: monthDateStr.slice(0, 7),
      };
      return new Response(JSON.stringify(emptyResponse),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const currencyCode = (driver as any).regions?.currency_code || null;

    // ── Parallel: materialised wallet balance + period earnings from ledger ──
    const earningTypes = ['TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT'];
    const reportingOnlyTypes = '("PLATFORM_COMMISSION","CASH_TRIP_EARNING")';

    const [lifetimeResult, ledgerResult, eligibility] = await Promise.all([
      supabase
        .from('driver_wallet_ledger')
        .select('amount_pence')
        .eq('driver_id', driver.id)
        .gt('amount_pence', 0)
        .not('type', 'in', reportingOnlyTypes),

      supabase
        .from('driver_wallet_ledger')
        .select('type, amount_pence, created_at, related_trip_id')
        .eq('driver_id', driver.id)
        .in('type', earningTypes)
        .gte('created_at', `${ledgerQueryStart}T00:00:00Z`)
        .order('created_at', { ascending: false }),

      fetchDriverPayoutEligibility(supabase, { driver_id: driver.id }),
    ]);

    const available_pence = eligibility.available_balance_pence;
    const pending_pence = eligibility.pending_balance_pence;
    const lifetime_earned_pence = (lifetimeResult.data || []).reduce(
      (sum, row) => sum + (row.amount_pence ?? 0),
      0,
    );

    if (ledgerResult.error) {
      console.error('[driver-earnings-summary] Ledger query error:', ledgerResult.error);
      return new Response(JSON.stringify({ error: 'Failed to fetch ledger' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const entries = ledgerResult.data || [];
    const lf = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
    const [mY, mM] = monthDateStr.split('-').map(Number);
    const monthLastDay = new Date(Date.UTC(mY, mM, 0));
    const monthEndDateStr = monthLastDay.toISOString().slice(0, 10);

    let todayEarnings = 0, weekEarnings = 0, monthEarnings = 0;
    let todayCardEarnings = 0, weekCardEarnings = 0, monthCardEarnings = 0;
    let todayCashEarnings = 0, weekCashEarnings = 0, monthCashEarnings = 0;
    let todayTips = 0, weekTips = 0, monthTips = 0;

    const todayTripIds = new Set<string>();
    const weekTripIds = new Set<string>();
    const monthTripIds = new Set<string>();

    const dailyMap: Record<string, { earnings: number; card_earnings: number; cash_earnings: number; tips: number; tripIds: Set<string> }> = {};
    for (let i = 0; i < 7; i++) {
      const key = addDays(weekDateStr, i);
      dailyMap[key] = { earnings: 0, card_earnings: 0, cash_earnings: 0, tips: 0, tripIds: new Set() };
    }

    for (const entry of entries) {
      if (!entry.created_at) continue;

      const entryLocalDate = lf.format(new Date(entry.created_at));
      const amount = entry.amount_pence ?? 0;
      const tripId = entry.related_trip_id;
      const isCard = entry.type === 'TRIP_EARNING_NET';
      const isTip = entry.type === 'DRIVER_TIP_CREDIT';

      if (entryLocalDate === todayDateStr) {
        todayEarnings += amount;
        if (isCard) todayCardEarnings += amount;
        if (isTip) { todayTips += amount; todayCardEarnings += amount; }
        if (tripId) todayTripIds.add(tripId);
      }

      if (entryLocalDate >= weekDateStr && entryLocalDate <= weekEndDateStr) {
        weekEarnings += amount;
        if (isCard) weekCardEarnings += amount;
        if (isTip) { weekTips += amount; weekCardEarnings += amount; }
        if (tripId) weekTripIds.add(tripId);
      }

      if (entryLocalDate >= monthDateStr && entryLocalDate <= monthEndDateStr) {
        monthEarnings += amount;
        if (isCard) monthCardEarnings += amount;
        if (isTip) { monthTips += amount; monthCardEarnings += amount; }
        if (tripId) monthTripIds.add(tripId);
      }

      if (dailyMap[entryLocalDate] !== undefined) {
        dailyMap[entryLocalDate].earnings += amount;
        if (isCard) dailyMap[entryLocalDate].card_earnings += amount;
        if (isTip) {
          dailyMap[entryLocalDate].tips += amount;
          dailyMap[entryLocalDate].card_earnings += amount;
        }
        if (tripId) dailyMap[entryLocalDate].tripIds.add(tripId);
      }
    }

    const todayTrips = todayTripIds.size;
    const weekTrips = weekTripIds.size;
    const monthTrips = monthTripIds.size;

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dailyBreakdown = Object.entries(dailyMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, data]) => {
        const d = new Date(date + 'T12:00:00Z');
        const trips = data.tripIds.size;
        return {
          date,
          day_name: dayNames[d.getUTCDay()],
          earnings_pence: data.earnings,
          card_earnings_pence: data.card_earnings,
          cash_earnings_pence: data.cash_earnings,
          tips_pence: data.tips,
          trips,
          hours: parseFloat((trips * 20 / 60).toFixed(1)),
        };
      });

    const response = {
      currency_code: currencyCode,
      available_pence,
      pending_pence,
      lifetime_earned_pence,
      today_earnings_pence: todayEarnings,
      week_earnings_pence: weekEarnings,
      month_earnings_pence: monthEarnings,
      today_card_earnings_pence: todayCardEarnings,
      today_cash_earnings_pence: todayCashEarnings,
      week_card_earnings_pence: weekCardEarnings,
      week_cash_earnings_pence: weekCashEarnings,
      month_card_earnings_pence: monthCardEarnings,
      month_cash_earnings_pence: monthCashEarnings,
      today_tips_pence: todayTips,
      week_tips_pence: weekTips,
      month_tips_pence: monthTips,
      today_trips: todayTrips,
      week_trips: weekTrips,
      month_trips: monthTrips,
      today_hours: parseFloat((todayTrips * 20 / 60).toFixed(1)),
      week_hours: parseFloat((weekTrips * 20 / 60).toFixed(1)),
      month_hours: parseFloat((monthTrips * 20 / 60).toFixed(1)),
      daily_breakdown: dailyBreakdown,
      week_start: weekDateStr,
      week_end: weekEndDateStr,
      month: monthDateStr.slice(0, 7),
    };

    return new Response(JSON.stringify(response),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Error in driver-earnings-summary:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
