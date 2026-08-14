import { createClient } from "npm:@supabase/supabase-js@2";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";
import {
  mergePayoutTabTransactions,
  paginatePayoutTransactions,
  type WalletPayoutTransaction,
} from "../../../shared/walletPayoutTransactions.ts";
import {
  walletTransactionDisplayTitle,
  WALLET_TRIPS_TAB_LEDGER_TYPES,
} from "../../../shared/walletTransactionTitles.ts";
import {
  driverWalletDisplayAmountPence,
  driverWalletTransactionIsCredit,
  isDriverWalletHiddenLedgerType,
  walletTabHistoryWeeks,
  walletTransactionHistoryCutoffIso,
} from "../../../shared/driverWalletDisplaySSOT.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

/**
 * Ledger entry types and their display metadata.
 * 
 * Settlement rules:
 * - card_trip_credit (TRIP_EARNING_NET): +driver_net_pence → wallet credit
 * - cash_trip_commission_debit (CASH_COMMISSION_DEBT): -commission_pence → wallet debit
 * - payout_debit (WEEKLY_PAYOUT / EARLY_CASHOUT): -payout_amount → wallet debit
 * - manual_adjustment (ADJUSTMENT / MANUAL_ADJUSTMENT): ±amount → wallet credit or debit
 */
const TYPE_LABELS: Record<string, { title: string; category: string }> = {
  'TRIP_EARNING_NET': { title: 'Card trip earning', category: 'trips' },
  'DRIVER_TIP_CREDIT': { title: 'Passenger tip', category: 'trips' },
  'CASH_COMMISSION_DEBT': { title: 'Cash trip commission', category: 'trips' },
  'DEBT_RECOVERY': { title: 'Debt recovery', category: 'trips' },
  'REFUND_DEBIT': { title: 'Refund', category: 'trips' },
  'WEEKLY_PAYOUT': { title: 'Weekly payout', category: 'payouts' },
  'EARLY_CASHOUT': { title: 'Instant cash out', category: 'payouts' },
  'CASHOUT_FEE': { title: 'Cash-out fee', category: 'payouts' },
  'ADJUSTMENT': { title: 'Adjustment', category: 'adjustments' },
  'MANUAL_ADJUSTMENT': { title: 'Manual adjustment', category: 'adjustments' },
  'CHARGEBACK_DEBIT': { title: 'Chargeback adjustment', category: 'adjustments' },
  'BONUS': { title: 'Bonus', category: 'bonuses' },
};

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
      console.log('WALLET_TRANSACTIONS_FETCH_FAILED', JSON.stringify({ reason: 'invalid_token' }));
      // Inject CORS headers to auth fail response if not present
      const response = auth.response;
      for (const [k, v] of Object.entries(corsHeaders)) {
        response.headers.set(k, v);
      }
      return response;
    }
    const userId = auth.userId;

    

    // Parse query params
    const url = new URL(req.url);
    const tab = url.searchParams.get('tab') || 'all';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
    const cursor = url.searchParams.get('cursor');

    console.log('Fetching transactions for user:', userId, 'tab:', tab, 'limit:', limit);

    const historyWeeks = walletTabHistoryWeeks(tab);
    const historyCutoffIso = historyWeeks != null
      ? walletTransactionHistoryCutoffIso(historyWeeks)
      : null;

    const { data: driver } = await supabase
      .from('drivers')
      .select('id, region_id, regions(currency_code, timezone)')
      .eq('user_id', userId)
      .maybeSingle();

    // If driver record doesn't exist (e.g. after admin reset), return empty transactions safely
    if (!driver) {
      console.log('No driver record for user:', userId, '- returning empty transactions');
      return new Response(
        JSON.stringify({ transactions: [], has_more: false, next_cursor: null }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let query = supabase
      .from('driver_wallet_ledger')
      .select('*')
      .eq('driver_id', driver.id)
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    if (tab === 'trips') {
      query = query.in('type', [...WALLET_TRIPS_TAB_LEDGER_TYPES]);
    } else if (tab === 'payouts') {
      query = query.in('type', ['WEEKLY_PAYOUT', 'EARLY_CASHOUT', 'CASHOUT_FEE']);
    } else if (tab === 'adjustments') {
      query = query.in('type', ['ADJUSTMENT', 'MANUAL_ADJUSTMENT', 'CHARGEBACK_DEBIT']);
    } else if (tab === 'bonuses') {
      query = query.in('type', ['BONUS']);
    }

    if (cursor) {
      if (historyCutoffIso && cursor < historyCutoffIso) {
        return new Response(
          JSON.stringify({ transactions: [], has_more: false, next_cursor: null }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      query = query.lt('created_at', cursor);
    }

    if (historyCutoffIso) {
      query = query.gte('created_at', historyCutoffIso);
    }

    const { data: ledgerEntries, error: ledgerError } = await query;

    if (ledgerError) {
      console.error('Ledger fetch error:', ledgerError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch transactions' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let entries = ledgerEntries || [];
    let hasMore = false;
    let nextCursor: string | null = null;
    let payoutMergedRows: WalletPayoutTransaction[] | null = null;

    if (tab === 'payouts') {
      let earlyCashoutQuery = supabase
        .from('driver_early_cashouts')
        .select('id, status, driver_receives_pence, early_cashout_fee_pence, failure_reason, created_at, paid_at, failed_at, ledger_cashout_id, payout_method')
        .eq('driver_id', driver.id)
        .order('created_at', { ascending: false })
        .limit(100);

      if (historyCutoffIso) {
        earlyCashoutQuery = earlyCashoutQuery.gte('created_at', historyCutoffIso);
      }

      const { data: earlyCashouts, error: earlyCashoutError } = await earlyCashoutQuery;

      if (earlyCashoutError) {
        console.error('Early cashout fetch error:', earlyCashoutError);
        return new Response(
          JSON.stringify({ error: 'Failed to fetch payout transactions' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      payoutMergedRows = mergePayoutTabTransactions(entries, earlyCashouts ?? []);
      const paginated = paginatePayoutTransactions(payoutMergedRows, limit, cursor);
      payoutMergedRows = paginated.page;
      hasMore = paginated.hasMore;
      nextCursor = paginated.nextCursor;
      entries = [];
    } else {
      hasMore = entries.length > limit;
      entries = hasMore ? entries.slice(0, limit) : entries;
      nextCursor = hasMore && entries.length > 0
        ? entries[entries.length - 1].created_at
        : null;
    }

    // Driver perspective: hide reporting-only / ONECAB mirror rows (e.g. COMMISSION_RECOVERED).
    if (tab !== 'payouts') {
      entries = entries.filter((entry) => !isDriverWalletHiddenLedgerType(entry.type));
    }

    // Resolve currency + timezone from driver's region — Region is the ONLY source of truth
    const regionData = driver.regions as { currency_code?: string; timezone?: string } | null;
    const currencyCode = regionData?.currency_code || null;
    const driverTimeZone = regionData?.timezone || 'UTC';
    const CURRENCY_SYMBOLS: Record<string, string> = {
      GBP: '£', USD: '$', EUR: '€', INR: '₹', AED: 'د.إ',
      CAD: 'C$', AUD: 'A$', KES: 'KSh', NGN: '₦', ZAR: 'R', PKR: '₨', BDT: '৳',
    };
    const currencySymbol = currencyCode ? (CURRENCY_SYMBOLS[currencyCode.toUpperCase()] || '') : '';

    const formatDateKey = (date: Date) => {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: driverTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      const year = parts.find((part) => part.type === 'year')?.value;
      const month = parts.find((part) => part.type === 'month')?.value;
      const day = parts.find((part) => part.type === 'day')?.value;
      return `${year}-${month}-${day}`;
    };

    const formatPence = (pence: number) => {
      const amount = Math.abs(pence) / 100;
      const sign = pence < 0 ? '-' : '+';
      return `${sign}${currencySymbol}${amount.toFixed(2)}`;
    };

    const formatDate = (dateStr: string) => {
      const date = new Date(dateStr);
      const now = new Date();
      const todayKey = formatDateKey(now);
      const yesterdayDate = new Date(now);
      yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
      const yesterdayKey = formatDateKey(yesterdayDate);
      const entryKey = formatDateKey(date);

      if (entryKey === todayKey) {
        return `Today, ${date.toLocaleTimeString('en-GB', { timeZone: driverTimeZone, hour: '2-digit', minute: '2-digit' })}`;
      } else if (entryKey === yesterdayKey) {
        return `Yesterday, ${date.toLocaleTimeString('en-GB', { timeZone: driverTimeZone, hour: '2-digit', minute: '2-digit' })}`;
      } else {
        return date.toLocaleDateString('en-GB', {
          timeZone: driverTimeZone,
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
        });
      }
    };

    const transactions = payoutMergedRows
      ? payoutMergedRows.map((entry) => {
        const typeInfo = TYPE_LABELS[entry.type] || { title: entry.type, category: 'payouts' };
        return {
          id: entry.id,
          type: entry.type,
          title: walletTransactionDisplayTitle(entry.type, entry.title || typeInfo.title),
          amount_pence: entry.amount_pence,
          amount_formatted: formatPence(entry.amount_pence),
          is_positive: entry.is_positive,
          category: typeInfo.category,
          date: entry.date,
          date_formatted: formatDate(entry.date),
          related_trip_id: entry.related_trip_id,
          cashout_status: entry.cashout_status ?? null,
          cashout_fee_pence: entry.cashout_fee_pence ?? null,
          failure_reason: entry.failure_reason ?? null,
          payout_method: entry.payout_method ?? null,
        };
      })
      : entries.map(entry => {
        const typeInfo = TYPE_LABELS[entry.type] || { title: entry.type, category: 'other' };
        const displayPence = driverWalletDisplayAmountPence(entry.type, entry.amount_pence);
        const isPositive = driverWalletTransactionIsCredit(entry.type, entry.amount_pence);
        return {
          id: entry.id,
          type: entry.type,
          title: walletTransactionDisplayTitle(entry.type, entry.description || typeInfo.title),
          amount_pence: displayPence,
          amount_formatted: formatPence(displayPence),
          is_positive: isPositive,
          category: typeInfo.category,
          date: entry.created_at,
          date_formatted: formatDate(entry.created_at),
          related_trip_id: entry.related_trip_id,
          cashout_status: null,
          cashout_fee_pence: null,
          failure_reason: null,
        };
      });

    console.log(`Returning ${transactions.length} transactions, hasMore: ${hasMore}`);

    return new Response(
      JSON.stringify({
        transactions,
        has_more: hasMore,
        next_cursor: nextCursor,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in driver-wallet-transactions:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
