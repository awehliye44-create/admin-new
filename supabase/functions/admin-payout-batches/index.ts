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
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const kind = url.searchParams.get('kind');
    const status = url.searchParams.get('status');
    const offset = (page - 1) * limit;

    // ── PARALLEL: Run all 3 queries simultaneously ──
    let batchQuery = supabase
      .from('payout_batches')
      .select('id,kind,run_date,status,total_drivers,total_amount_pence,successful_payouts,failed_payouts,notes,created_at,completed_at', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (kind) batchQuery = batchQuery.eq('kind', kind);
    if (status) batchQuery = batchQuery.eq('status', status);
    batchQuery = batchQuery.range(offset, offset + limit - 1);

    const [batchResult, financialResult, summaryResult] = await Promise.all([
      batchQuery,
      supabase
        .from('driver_financial_summary')
        .select('total_payouts_sent, available_for_payout, currency_code'),
      supabase
        .from('payout_batches')
        .select('status, total_amount_pence'),
    ]);

    if (batchResult.error) throw batchResult.error;

    const batches = batchResult.data || [];
    const count = batchResult.count;

    // Get items for visible batches only (single query)
    const batchIds = batches.map(b => b.id);
    const { data: allItems } = batchIds.length > 0 ? await supabase
      .from('payout_items')
      .select('id,batch_id,driver_id,amount_pence,status,stripe_transfer_id,stripe_payout_id,error_message,created_at,completed_at,drivers:driver_id(first_name,last_name)')
      .in('batch_id', batchIds) : { data: [] };

    const itemsByBatch: Record<string, any[]> = {};
    allItems?.forEach((item: any) => {
      if (!itemsByBatch[item.batch_id]) itemsByBatch[item.batch_id] = [];
      itemsByBatch[item.batch_id].push(item);
    });

    const transformedBatches = batches.map(batch => ({
      id: batch.id,
      kind: batch.kind,
      runDate: batch.run_date,
      status: batch.status,
      totalDrivers: batch.total_drivers,
      totalAmount: batch.total_amount_pence,
      successfulPayouts: batch.successful_payouts,
      failedPayouts: batch.failed_payouts,
      notes: batch.notes,
      createdAt: batch.created_at,
      completedAt: batch.completed_at,
      items: itemsByBatch[batch.id]?.map((item: any) => ({
        id: item.id,
        driverId: item.driver_id,
        driverName: item.drivers ? `${item.drivers.first_name} ${item.drivers.last_name}` : null,
        amount: item.amount_pence,
        status: item.status,
        stripeTransferId: item.stripe_transfer_id,
        stripePayoutId: item.stripe_payout_id,
        errorMessage: item.error_message,
        createdAt: item.created_at,
        completedAt: item.completed_at,
      })) || [],
    }));

    // ── Stats from parallel results ──
    const financialRows = financialResult.data || [];
    const summaryData = summaryResult.data || [];

    const unifiedTotalPayouts = financialRows.reduce((s, d) => s + Number(d.total_payouts_sent || 0), 0);
    const unifiedAvailablePayout = financialRows.reduce((s, d) => s + Number(d.available_for_payout || 0), 0);
    const driversReadyForPayout = financialRows.filter(d => Number(d.available_for_payout || 0) > 0).length;
    const dominantCurrency = financialRows.find(d => d.currency_code)?.currency_code || '';

    const summary = {
      totalBatches: summaryData.length,
      totalPaidOut: unifiedTotalPayouts,
      totalPaidOutBatches: summaryData.filter(b => b.status === 'completed')
        .reduce((sum, b) => sum + (b.total_amount_pence || 0), 0),
      pendingBatches: summaryData.filter(b => b.status === 'pending' || b.status === 'processing').length,
      failedBatches: summaryData.filter(b => b.status === 'failed').length,
      availableForPayout: unifiedAvailablePayout,
      driversReadyForPayout,
      currencyCode: dominantCurrency,
    };

    return new Response(JSON.stringify({
      batches: transformedBatches,
      summary,
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in admin-payout-batches:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
